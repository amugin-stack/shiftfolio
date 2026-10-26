import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { resolveRole, resolveUserRoles, getProducerBrandIds } from '@/lib/role'
import {
  resolveMonthRange,
  resolveWeekRange,
  resolveCustomRange,
  buildScheduleRows,
  scheduleRowsToCsv,
  type DateRange,
  type ScheduleStreamInput,
} from '@/lib/scheduleExport'
import type { Profile } from '@/lib/supabase/types'

export const runtime = 'nodejs'

/** Brand name → filesystem-friendly slug for the download filename. */
function brandSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return slug || 'brand'
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  // --- Auth: admin (any brand) or producer (their assigned brands only) ---
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse('unauthorized', { status: 401 })

  const { data: profileData } = await supabase
    .from('profiles').select('*').eq('id', user.id).single()
  const profile = profileData as Profile | null
  const { effectiveIsAdmin } = await resolveRole(profile)
  const roles = await resolveUserRoles(supabase, user.id, effectiveIsAdmin)
  if (!effectiveIsAdmin && !roles.isProducer) {
    return new NextResponse('forbidden', { status: 403 })
  }

  // --- Params ---
  const sp = request.nextUrl.searchParams
  const brand = sp.get('brand')
  if (!brand) return new NextResponse('missing brand', { status: 400 })

  // Producers may only export brands they are assigned to.
  if (!effectiveIsAdmin) {
    const allowed = roles.producerId
      ? await getProducerBrandIds(supabase, roles.producerId)
      : []
    if (!allowed.includes(brand)) {
      return new NextResponse('forbidden', { status: 403 })
    }
  }

  let range: DateRange
  try {
    const month = sp.get('month')
    const week = sp.get('week')
    if (month) {
      range = resolveMonthRange(month)
    } else if (week) {
      range = resolveWeekRange(week)
    } else {
      const from = sp.get('from')
      const to = sp.get('to')
      if (!from || !to) return new NextResponse('missing date range', { status: 400 })
      range = resolveCustomRange(from, to)
    }
  } catch {
    return new NextResponse('invalid date range', { status: 400 })
  }

  // --- Query: every booked shift for this brand in range (past + future) ---
  // PAGED: the preset ranges are bounded, but the custom from/to path accepts
  // an arbitrary span, so this can exceed PostgREST's 1000-row cap. Truncated,
  // the CSV silently omits shifts while looking complete — the same failure
  // that made the brand calendar render empty days over occupied slots.
  let streamsData: unknown[]
  try {
    streamsData = await fetchAllRows(() =>
      supabase
        .from('streams')
        .select(
          'start_time, end_time, host:hosts(name), moderator:moderators(name), brand:brands(name)',
        )
        .eq('brand_id', brand)
        .gte('start_time', range.fromISO)
        .lt('start_time', range.toExclusiveISO)
        .order('id') as never,
    )
  } catch {
    return new NextResponse('query failed', { status: 500 })
  }

  type Named = { name: string }
  type Row = {
    start_time: string
    end_time: string
    host: Named | Named[] | null
    moderator: Named | Named[] | null
    brand: Named | Named[] | null
  }
  const first = (v: Named | Named[] | null): Named | null =>
    Array.isArray(v) ? v[0] ?? null : v

  const rows = (streamsData ?? []) as unknown as Row[]
  const streams: ScheduleStreamInput[] = rows.map(s => ({
    start_time: s.start_time,
    end_time: s.end_time,
    host: first(s.host),
    moderator: first(s.moderator),
  }))

  const brandName = first(rows[0]?.brand ?? null)?.name ?? 'brand'
  const csv = scheduleRowsToCsv(buildScheduleRows(streams))
  const filename = `schedule_${brandSlug(brandName)}_${range.fromKey}_to_${range.toKey}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
