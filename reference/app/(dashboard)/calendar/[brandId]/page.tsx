import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CalendarView } from '@/components/calendar/CalendarView'
import { CalendarHeader } from '@/components/calendar/CalendarHeader'
import { CalendarNavProvider } from '@/components/calendar/CalendarNavContext'
import { resolveRole } from '@/lib/role'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { calendarRange, windowStreamIds, readIdChunks } from '@/lib/supabase/windowedStreams'
import { nowPtAsUtc } from '@/lib/utils'
import {
  BRAND_NONPRICING_COLUMNS,
  type Brand,
  type HostPublic,
  type Moderator,
  type Producer,
  type StreamWithRelations,
} from '@/lib/supabase/types'

// Shared by both viewer branches of the paged streams fetch below.
const CALENDAR_STREAM_SELECT =
  'id, title, brand_id, host_id, producer_id, moderator_id, start_time, end_time, notes, created_by, created_at, host:hosts(id,name), brand:brands(id,name), producer:producers(id,name), moderator:moderators(id,name)'

interface BrandCalendarPageProps {
  params: Promise<{ brandId: string }>
  searchParams: Promise<{ from?: string; to?: string; date?: string }>
}

export default async function BrandCalendarPage({ params, searchParams }: BrandCalendarPageProps) {
  const { brandId } = await params
  const supabase = await createClient()

  // Shared with the dashboard layout for this request (src/lib/auth/session.ts)
  // — these three used to be a second full identity resolution on top of the
  // layout's: one auth round-trip, one profile fetch and three role queries.
  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin: isAdmin } = await resolveRole(profile)
  const userRoles = await getSessionRoles(user.id, isAdmin)

  const { data: brandData } = await supabase
    .from('brands')
    // client_rate_cents / contracted_hours_per_month are column-locked (mig 055)
    // and the calendar never needs them; select everything else. brandForClient
    // below already nulls pricing for non-admins.
    .select(BRAND_NONPRICING_COLUMNS)
    .eq('id', brandId)
    .single()

  const brand = brandData as unknown as Brand | null
  if (!brand) notFound()

  // Privacy: client pricing + contracted hours are admin-only. The brand
  // object is handed to client components (CalendarHeader), so null those
  // fields for non-admins — they must never reach the browser (CLAUDE.md
  // rule 25). Producers/moderators still get name, logo, producer_id, and the
  // block/day config the calendar needs.
  const brandForClient: Brand = isAdmin
    ? brand
    : { ...brand, client_rate_cents: null, contracted_hours_per_month: null }

  // Producer name for the header badge ("Producer: …"). Null when no producer
  // is assigned to this brand.
  let producerName: string | null = null
  if (brand.producer_id) {
    const { data: producerRow } = await supabase
      .from('producers')
      .select('name')
      .eq('id', brand.producer_id)
      .maybeSingle()
    producerName = (producerRow as { name: string } | null)?.name ?? null
  }

  // Eligibility (the support team 2026-07-21 access model):
  //   - admins can view + edit every brand calendar
  //   - producers can view every brand, READ-ONLY (no writes)
  //   - moderators can view only brands they have at least one assignment on
  //   - HOSTS are passive — no brand-calendar access at all; they only ever
  //     see their own shifts on /my-shifts, so a host is redirected there.
  let isModeratorOfThisBrand = false

  // Moderator-on-this-brand check (any assigned stream).
  if (!isAdmin && !userRoles.isProducer && userRoles.isModerator && userRoles.moderatorId) {
    const { data: anyAssignment } = await supabase
      .from('streams')
      .select('id')
      .eq('brand_id', brandId)
      .eq('moderator_id', userRoles.moderatorId)
      .limit(1)
      .maybeSingle()
    isModeratorOfThisBrand = !!anyAssignment
  }

  // Only admins, producers (read-only), and moderators-on-this-brand may view
  // a brand calendar. Everyone else — notably hosts — goes to My Shifts.
  if (!isAdmin && !userRoles.isProducer && !isModeratorOfThisBrand) {
    redirect('/my-shifts')
  }

  // Only admins can write (create/edit/delete). Producers are view-only, hosts
  // no longer reach this page — so canBook is admin-only now.
  const isScheduler = userRoles.isScheduler // admin-only (see src/lib/role.ts)
  const canBook = isScheduler

  // viewerMode tells CalendarView how to render. Moderators get a sparse,
  // own-shifts-only view; producers get the full read-only calendar; only
  // admins get edit affordances (gated by isScheduler/canBook downstream).
  const viewerMode: 'admin' | 'host' | 'producer' | 'moderator' =
    isAdmin
      ? 'admin'
      : userRoles.isProducer
        ? 'producer'
        : 'moderator'

  const query = await searchParams
  const range = calendarRange(query.from, query.to, nowPtAsUtc())
  const streamIds = await windowStreamIds(supabase, range.from, range.to, {
    brand: brandId, moderator: viewerMode === 'moderator' ? userRoles.moderatorId ?? undefined : undefined,
  })

  const [
    streamsData,
    { data: hostsData },
    { data: producersData },
    { data: moderatorsData },
    { data: currentHostData },
  ] = await Promise.all([
    readIdChunks(streamIds, ids => supabase.from('streams').select(CALENDAR_STREAM_SELECT).in('id', ids).order('start_time').order('id') as never),
    // The calendar serializes the full host list to the client to populate
    // the assignment dropdown — rate_cents (pay) is sensitive and only the
    // admin Hosts page should expose it. Public columns for everyone here,
    // including admins — the calendar UI never reads it. (Defense-in-depth
    // on top of the column-trigger in mig 046.)
    // Only ACTIVE hosts populate the assignment dropdown (soft-delete, mig 054).
    // 'id, name' ONLY — not the *_PUBLIC_COLUMNS lists. Those are "public"
    // with respect to rate_cents, but still carry email and phone, and this
    // page serialises them into the browser of any producer OR any moderator
    // with a single shift on this brand — i.e. one moderator would receive the
    // contact details of every active host, moderator and producer in the
    // company. The assignment dropdowns only ever read id and name (grep
    // CalendarView/StreamEventModal for .email/.phone: no hits), so this is
    // pure over-fetch with real PII attached.
    supabase.from('hosts').select('id, name').eq('is_active', true).order('name'),
    supabase.from('producers').select('id, name').order('name'),
    // Same treatment for moderators (mig 036).
    // Only ACTIVE moderators populate the assignment dropdown (soft-delete, mig 054).
    supabase.from('moderators').select('id, name').eq('is_active', true).order('name'),
    supabase.from('hosts').select('id,name').eq('user_id', user.id).maybeSingle(),
  ])

  const currentHost = (currentHostData as { id: string; name: string } | null) ?? null

  // Cross-brand conflict overlay: this host's existing bookings on OTHER brands
  // so we can grey them out on this calendar with "Already booked for X".
  type Conflict = { start_time: string; end_time: string; brandName: string }
  let conflicts: Conflict[] = []
  if (currentHost) {
    const conflictRows = await fetchAllRows<ConflictRow>(() => supabase
      .from('streams')
      .select('start_time, end_time, brand:brands(name)')
      .eq('host_id', currentHost.id)
      .neq('brand_id', brandId)
      .gte('end_time', range.from)
      .lt('start_time', range.to).order('start_time').order('id') as never)

    type ConflictRow = {
      start_time: string
      end_time:   string
      brand: { name: string } | { name: string }[] | null
    }
    conflicts = ((conflictRows ?? []) as unknown as ConflictRow[])
      .map(r => {
        const brandName = Array.isArray(r.brand) ? r.brand[0]?.name : r.brand?.name
        return brandName ? { start_time: r.start_time, end_time: r.end_time, brandName } : null
      })
      .filter((c): c is Conflict => c !== null)
  }

  // Prep-time source for moderator viewers: ALL of this moderator's assigned
  // streams (any brand, RLS-visible as their own). Prep blocks derive per
  // contiguous session, and the suppression rule needs their other-brand
  // shifts (src/lib/prepTime.ts) — the brand-scoped streams query above
  // can't provide that.
  type PrepSourceRow = {
    id: string
    brand_id: string
    moderator_id: string | null
    start_time: string
    end_time: string
  }
  let prepSourceStreams: PrepSourceRow[] = []
  if (viewerMode === 'moderator' && userRoles.moderatorId) {
    const prepIds = await windowStreamIds(supabase, range.from, range.to, { moderator: userRoles.moderatorId })
    prepSourceStreams = await readIdChunks<PrepSourceRow>(prepIds, ids => supabase.from('streams')
      .select('id, brand_id, moderator_id, start_time, end_time').in('id', ids).order('start_time').order('id') as never)

  }

  // Pending cancellation requests submitted by THIS user — used to render the
  // subtle "Cancel pending" badge on their own tiles.
  const { data: pendingCancelRows } = await supabase
    .from('shift_cancellation_requests')
    .select('stream_id')
    .eq('host_user_id', user.id)
    .eq('status', 'pending')
  const pendingCancelStreamIds = ((pendingCancelRows as { stream_id: string }[] | null) ?? [])
    .map(r => r.stream_id)

  return (
    <CalendarNavProvider>
      <div className="h-full flex flex-col">
        <CalendarHeader brand={brandForClient} canEdit={isAdmin} producerName={producerName} />
        <div className="flex-1 min-h-0">
          <CalendarView
          brandId={brandId}
          loadedRange={range}
          initialDate={(query.date && Number.isFinite(Date.parse(query.date)) ? query.date : query.from) ?? nowPtAsUtc().toISOString()}
          initialStreams={(streamsData as unknown as StreamWithRelations[] | null) ?? []}
          initialHosts={(hostsData as unknown as HostPublic[] | null) ?? []}
          initialProducers={(producersData as Producer[] | null) ?? []}
          initialModerators={(moderatorsData as Moderator[] | null) ?? []}
          shift={{
            blockSizeMinutes: brand.block_size_minutes,
            dayStartMinutes:  brand.day_start_minutes,
            dayEndMinutes:    brand.day_end_minutes,
          }}
          isAdmin={isAdmin}
          isScheduler={isScheduler}
          canBook={canBook}
          viewerMode={viewerMode}
          currentUserId={user.id}
          currentHost={currentHost}
          conflicts={conflicts}
          pendingCancelStreamIds={pendingCancelStreamIds}
          prepSourceStreams={prepSourceStreams}
        />
        </div>
      </div>
    </CalendarNavProvider>
  )
}
