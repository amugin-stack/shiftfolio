'use client'

// "Copy week" — duplicate a brand's visible week into another week.
//
// All planning math lives in src/lib/copyWeek.ts (pure + unit-tested); this
// component only does I/O: fetch source week, fetch what's already in the
// target week, preview, then insert.
//
// The preview step is not decoration. A single collision with
// streams_unique_slot raises 23505, and because a multi-row insert is ONE
// statement that aborts the entire copy — so conflicting rows must be filtered
// out BEFORE the insert, and the admin should see what got dropped and why.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy, AlertTriangle, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetchAll'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { formatPT, nowPtAsUtc } from '@/lib/utils'
import {
  buildCopyPlan,
  describeCopyPlan,
  DAY_MS,
  WEEK_MS,
  type BusyInterval,
  type CopyPlan,
  type CopySourceStream,
} from '@/lib/copyWeek'

interface CopyWeekDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  brandId: string
  /** Start of the week currently shown in the calendar (PT-naive). */
  sourceWeekStart: Date
}

const SELECT =
  'id, title, host_id, producer_id, moderator_id, notes, start_time, end_time'

/** YYYY-MM-DD (PT-naive) -> ms, matching how the rest of the app encodes dates. */
function dateKeyToMs(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function msToDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function CopyWeekDialog({
  open,
  onOpenChange,
  brandId,
  sourceWeekStart,
}: CopyWeekDialogProps) {
  const supabase = createClient()
  const router = useRouter()
  const { toast } = useToast()

  const sourceStartMs = sourceWeekStart.getTime()
  const [targetKey, setTargetKey] = useState(() => msToDateKey(sourceStartMs + WEEK_MS))
  const [plan, setPlan] = useState<CopyPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only the newest preview may write state. Without this, changing the target
  // date rapidly lets a SLOW EARLIER response land last: the label would read
  // the new week while `plan` held the old week's timestamps, and confirming
  // would insert a full week of real shifts into the wrong week with nothing
  // on screen revealing it.
  const requestSeq = useRef(0)

  const targetStartMs = dateKeyToMs(targetKey)

  // This dialog is mounted permanently by CalendarView, so it never remounts —
  // the lazy initial state above would keep proposing a target relative to
  // whatever week was visible at page load. Re-anchor when the source week
  // changes, or navigating the calendar silently aims the copy backwards.
  useEffect(() => {
    setTargetKey(msToDateKey(sourceStartMs + WEEK_MS))
  }, [sourceStartMs])

  const buildPreview = useCallback(async () => {
    if (targetStartMs === null) {
      setError('Pick a valid target date.')
      setPlan(null)
      return
    }
    if (targetStartMs === sourceStartMs) {
      setError('The target week is the same as the source week.')
      setPlan(null)
      return
    }
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    try {
      const offsetMs = targetStartMs - sourceStartMs
      const srcEndMs = sourceStartMs + WEEK_MS
      const tgtEndMs = targetStartMs + WEEK_MS

      const [{ data: srcRows, error: srcErr }, { data: tgtRows, error: tgtErr }, { data: busyRows, error: busyErr }] =
        await Promise.all([
          // Source week, this brand.
          supabase
            .from('streams')
            .select(SELECT)
            .eq('brand_id', brandId)
            .gte('start_time', new Date(sourceStartMs).toISOString())
            .lt('start_time', new Date(srcEndMs).toISOString())
            .order('start_time'),
          // What already occupies the target week on this brand.
          supabase
            .from('streams')
            .select('start_time')
            .eq('brand_id', brandId)
            .gte('start_time', new Date(targetStartMs).toISOString())
            .lt('start_time', new Date(tgtEndMs).toISOString()),
          // Everyone's other commitments in the target window, ANY brand —
          // enforce_no_double_booking rejects cross-brand overlaps too.
          // PAGED: this one is unbounded across all brands, so a busy 9-day
          // window can exceed PostgREST's 1000-row cap. Truncation here would
          // silently under-report conflicts, and the copy would then die on a
          // 23P01 AFTER promising N shifts in the preview.
          fetchAllRows(() =>
            supabase
              .from('streams')
              .select('host_id, moderator_id, start_time, end_time, brand:brands(name)')
              .gte('start_time', new Date(targetStartMs - DAY_MS).toISOString())
              .lt('start_time', new Date(tgtEndMs + DAY_MS).toISOString())
              // Deterministic order is required for correct paging.
              .order('start_time')
              .order('id'),
          ).then(data => ({ data, error: null })),
        ])

      if (srcErr || tgtErr || busyErr) {
        throw new Error((srcErr ?? tgtErr ?? busyErr)!.message)
      }

      // Paid setup/training/office-hour blocks (migration 057) also block a
      // booking: trg_stream_not_overlapping_extra_pay raises 23P01 per row. A
      // multi-row insert is ONE statement, so a single overlooked training
      // block would abort the ENTIRE copy — the exact failure the preview
      // exists to prevent.
      const { data: extraRows, error: extraErr } = await supabase
        .from('extra_pay_slots')
        .select('host_id, start_time, end_time, kind')
        .neq('status', 'canceled')
        .gte('start_time', new Date(targetStartMs - DAY_MS).toISOString())
        .lt('start_time', new Date(tgtEndMs + DAY_MS).toISOString())
      // Non-fatal: if this table is missing or unreadable, fall back to
      // stream-only conflict detection rather than blocking the whole feature.
      if (extraErr) console.warn('[CopyWeek] extra-pay conflict check skipped:', extraErr.message)

      const hostBusy = new Map<string, BusyInterval[]>()
      const moderatorBusy = new Map<string, BusyInterval[]>()
      type BusyRow = {
        host_id: string | null
        moderator_id: string | null
        start_time: string
        end_time: string
        brand: { name: string } | { name: string }[] | null
      }
      for (const raw of (busyRows ?? []) as unknown as BusyRow[]) {
        const brandName = Array.isArray(raw.brand) ? raw.brand[0]?.name : raw.brand?.name
        const iv: BusyInterval = {
          startMs: new Date(raw.start_time).getTime(),
          endMs: new Date(raw.end_time).getTime(),
          brandName: brandName ?? 'another brand',
        }
        if (raw.host_id) hostBusy.set(raw.host_id, [...(hostBusy.get(raw.host_id) ?? []), iv])
        if (raw.moderator_id) moderatorBusy.set(raw.moderator_id, [...(moderatorBusy.get(raw.moderator_id) ?? []), iv])
      }

      // Fold extra-pay blocks into the same host-busy map so they surface in
      // the preview as an ordinary host conflict, labelled by what they are.
      type ExtraRow = { host_id: string; start_time: string; end_time: string; kind: string }
      const KIND_LABEL: Record<string, string> = {
        setup: 'setup', training: 'training', office_hours: 'office hours',
      }
      for (const raw of (extraRows ?? []) as ExtraRow[]) {
        if (!raw.host_id) continue
        hostBusy.set(raw.host_id, [
          ...(hostBusy.get(raw.host_id) ?? []),
          {
            startMs: new Date(raw.start_time).getTime(),
            endMs: new Date(raw.end_time).getTime(),
            brandName: KIND_LABEL[raw.kind] ?? 'paid time',
          },
        ])
      }

      // Discard a stale response: only the newest request may set the plan.
      if (seq !== requestSeq.current) return

      setPlan(
        buildCopyPlan({
          sourceStreams: (srcRows ?? []) as unknown as CopySourceStream[],
          offsetMs,
          occupiedStartMs: ((tgtRows ?? []) as { start_time: string }[]).map(r =>
            new Date(r.start_time).getTime(),
          ),
          hostBusy,
          moderatorBusy,
          nowMs: nowPtAsUtc().getTime(),
        }),
      )
    } catch (e) {
      if (seq !== requestSeq.current) return
      setError(e instanceof Error ? e.message : 'Could not build the preview.')
      setPlan(null)
    } finally {
      // Only the newest request may clear the spinner, or an early response
      // would make a still-pending preview look finished.
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [brandId, sourceStartMs, targetStartMs, supabase])

  // Re-preview whenever the dialog opens or the target week changes — the
  // admin should never confirm against a stale plan.
  useEffect(() => {
    if (open) void buildPreview()
  }, [open, buildPreview])

  async function handleConfirm() {
    if (!plan || plan.toCreate.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not signed in.')

      const rows = plan.toCreate.map(p => ({
        brand_id: brandId,
        title: p.title,
        host_id: p.host_id,
        producer_id: p.producer_id,
        moderator_id: p.moderator_id,
        notes: p.notes,
        start_time: p.start_time,
        end_time: p.end_time,
        created_by: user.id,
      }))

      // One statement => atomic. Conflicting rows were already filtered out,
      // so a 23505/23P01 here means someone booked concurrently; surface it
      // rather than silently writing a partial week.
      const { error: insErr } = await supabase.from('streams').insert(rows)
      if (insErr) throw new Error(insErr.message)

      toast({
        title: `Copied ${rows.length} shift${rows.length === 1 ? '' : 's'}`,
        description: 'Assigned hosts and moderators have been notified.',
      })
      onOpenChange(false)
      setPlan(null)
      router.refresh()
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message} — nothing was copied. Re-open to rebuild the preview.`
          : 'Copy failed.',
      )
    } finally {
      setSaving(false)
    }
  }

  const sourceLabel = `${formatPT(new Date(sourceStartMs), 'MMM d')} – ${formatPT(new Date(sourceStartMs + 6 * DAY_MS), 'MMM d, yyyy')}`
  const targetLabel =
    targetStartMs === null
      ? '—'
      : `${formatPT(new Date(targetStartMs), 'MMM d')} – ${formatPT(new Date(targetStartMs + 6 * DAY_MS), 'MMM d, yyyy')}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy week</DialogTitle>
          <DialogDescription>
            Duplicates every shift from <span className="font-medium text-foreground">{sourceLabel}</span>,
            keeping the same days, times, and assigned people.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="copy-week-target">Copy into the week starting</Label>
            <Input
              id="copy-week-target"
              type="date"
              value={targetKey}
              onChange={e => setTargetKey(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Target week: {targetLabel}</p>
          </div>

          <div className="rounded-md border border-border p-3 text-sm">
            {loading ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking for conflicts…
              </span>
            ) : plan ? (
              <div className="space-y-2">
                <p className="text-foreground">{describeCopyPlan(plan)}</p>
                {plan.counts.landsInPast > 0 && (
                  <p className="flex items-start gap-2 text-amber-600 dark:text-amber-500">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      {plan.counts.landsInPast} of these land in the past, so they count as worked
                      immediately and will appear in payroll.
                    </span>
                  </p>
                )}
                {plan.counts.create > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Everyone assigned to a copied shift gets a notification.
                  </p>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">Pick a target week to preview.</span>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={saving || loading || !plan || plan.counts.create === 0}
            className="gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
            {saving
              ? 'Copying…'
              : plan && plan.counts.create > 0
                ? `Copy ${plan.counts.create} shift${plan.counts.create === 1 ? '' : 's'}`
                : 'Copy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
