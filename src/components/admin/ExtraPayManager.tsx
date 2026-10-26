'use client'

// Admin UI for non-livestream paid work: setup, training, office hours.
//
// Every write goes through the SECURITY DEFINER RPCs from migration 057
// (create/update/cancel_extra_pay_slot). The table has NO insert/update/delete
// RLS policies at all, so a direct PostgREST write is impossible — the admin
// check and the double-booking check cannot be bypassed by this UI or any
// other client.
//
// The rate is FROZEN onto each slot when it is created. The per-kind values in
// DEFAULT_RATE_CENTS only prefill this form; editing them later can never
// re-price work already done. That is why the rate field is per-slot and
// always visible rather than hidden behind a global setting.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Pencil, Trash2, GraduationCap, Wrench, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { formatCents, formatPT, nowPtAsUtc } from '@/lib/utils'
import {
  DEFAULT_RATE_CENTS,
  EXTRA_PAY_KINDS,
  EXTRA_PAY_LABELS,
  extraPayCents,
  extraPayHours,
  type ExtraPayKind,
} from '@/lib/extraPay'

export interface ExtraPaySlot {
  id: string
  /** Exactly one of host_id / moderator_id is set (migration 073). */
  host_id: string | null
  moderator_id: string | null
  kind: ExtraPayKind
  start_time: string
  end_time: string
  rate_cents: number
  status: 'scheduled' | 'completed' | 'canceled'
  notes: string | null
}

interface ExtraPayManagerProps {
  initialSlots: ExtraPaySlot[]
  hosts: { id: string; name: string }[]
  /** Moderators became assignable in migration 073. */
  moderators: { id: string; name: string }[]
}

type WorkerRole = 'host' | 'moderator'

const KIND_ICON: Record<ExtraPayKind, typeof Wrench> = {
  setup: Wrench,
  training: GraduationCap,
  office_hours: Clock,
}

interface FormState {
  /** Which roster `workerId` refers to. A slot belongs to exactly one person
   *  in exactly one role — the database enforces that too. */
  role: WorkerRole
  workerId: string
  kind: ExtraPayKind
  date: string
  startTime: string
  endTime: string
  /** Dollars as typed; converted to cents on save. */
  rate: string
  notes: string
}

const EMPTY_FORM: FormState = {
  role: 'host',
  workerId: '',
  kind: 'training',
  date: '',
  startTime: '10:00',
  endTime: '12:00',
  rate: (DEFAULT_RATE_CENTS.training / 100).toFixed(2),
  notes: '',
}

/**
 * Form date + time -> PT-naive ISO. The UTC fields ARE the PT wall-clock, so
 * the components are encoded with Date.UTC and never round-tripped through
 * local Date methods (which would drift an hour on DST days).
 */
function toPtNaiveISO(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})$/.exec(time)
  if (!d || !t) return null
  return new Date(
    Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0, 0),
  ).toISOString()
}

export function ExtraPayManager({ initialSlots, hosts, moderators }: ExtraPayManagerProps) {
  const supabase = createClient()
  const router = useRouter()
  const { toast } = useToast()

  const [slots, setSlots] = useState<ExtraPaySlot[]>(initialSlots)
  const [dialogOpen, setDialogOpen] = useState(false)
  // Non-null while editing an existing slot (the support team needs to adjust hours after
  // the fact and have the pay follow automatically).
  const [editingSlot, setEditingSlot] = useState<ExtraPaySlot | null>(null)
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hostName = useMemo(() => new Map(hosts.map(h => [h.id, h.name])), [hosts])
  const moderatorName = useMemo(() => new Map(moderators.map(m => [m.id, m.name])), [moderators])
  // The roster the form is currently picking from.
  const roster = form.role === 'host' ? hosts : moderators
  const nowMs = nowPtAsUtc().getTime()

  // Live preview of what this slot will pay, so the admin sees the money
  // before committing it.
  const preview = useMemo(() => {
    const startISO = toPtNaiveISO(form.date, form.startTime)
    const endISO = toPtNaiveISO(form.date, form.endTime)
    const rateCents = Math.round((parseFloat(form.rate) || 0) * 100)
    if (!startISO || !endISO || rateCents <= 0) return null
    const hours = extraPayHours(startISO, endISO)
    if (hours <= 0) return null
    return { hours, cents: extraPayCents(startISO, endISO, rateCents) }
  }, [form.date, form.startTime, form.endTime, form.rate])

  function openCreate() {
    setEditingSlot(null)
    setForm({ ...EMPTY_FORM, workerId: hosts[0]?.id ?? '' })
    setError(null)
    setDialogOpen(true)
  }

  // Edit an existing slot. Times and rate are both adjustable; pay is always
  // recomputed from them, so correcting the hours corrects the payment.
  function openEdit(slot: ExtraPaySlot) {
    setEditingSlot(slot)
    setForm({
      role: slot.host_id ? 'host' : 'moderator',
      workerId: slot.host_id ?? slot.moderator_id ?? '',
      kind: slot.kind,
      date: slot.start_time.slice(0, 10),
      startTime: slot.start_time.slice(11, 16),
      endTime: slot.end_time.slice(11, 16),
      rate: (slot.rate_cents / 100).toFixed(2),
      notes: slot.notes ?? '',
    })
    setError(null)
    setDialogOpen(true)
  }

  function pickKind(kind: ExtraPayKind) {
    // Prefill the rate from this kind's default, but it stays editable — the
    // stored value is what gets paid.
    setForm(f => ({ ...f, kind, rate: (DEFAULT_RATE_CENTS[kind] / 100).toFixed(2) }))
  }

  async function handleSave() {
    const startISO = toPtNaiveISO(form.date, form.startTime)
    const endISO = toPtNaiveISO(form.date, form.endTime)
    if (!form.workerId) return setError(form.role === 'host' ? 'Pick a host.' : 'Pick a moderator.')
    if (!startISO || !endISO) return setError('Pick a date and times.')
    if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
      return setError('End time must be after the start time.')
    }
    const rateCents = Math.round((parseFloat(form.rate) || 0) * 100)
    if (!(rateCents > 0)) return setError('Enter an hourly rate.')

    setSaving(true)
    setError(null)
    // Editing goes through update_extra_pay_slot so the overlap check still
    // runs on the NEW times. Pay is never stored separately — it is always
    // recomputed from times x rate, so adjusting the hours adjusts the payment.
    const { data, error: rpcError } = editingSlot
      ? await supabase.rpc('update_extra_pay_slot', {
          p_id: editingSlot.id,
          p_start: startISO,
          p_end: endISO,
          p_rate_cents: rateCents,
          p_notes: form.notes.trim() || null,
        })
      : await supabase.rpc('create_extra_pay_slot', {
          // Exactly one is non-null. The RPC rejects both-or-neither and the
          // table has a CHECK behind it (extra_pay_one_worker, migration 073),
          // so a bug here fails loudly rather than creating an unpayable slot.
          p_host_id: form.role === 'host' ? form.workerId : null,
          p_moderator_id: form.role === 'moderator' ? form.workerId : null,
          p_kind: form.kind,
          p_start: startISO,
          p_end: endISO,
          p_rate_cents: rateCents,
          p_notes: form.notes.trim() || null,
        })
    setSaving(false)

    if (rpcError) {
      // The RPC raises 23P01 when the host already has a shift or another slot
      // in that window — surface it plainly rather than as a Postgres string.
      setError(
        rpcError.message.includes('already booked')
          ? 'That host is already booked during this time.'
          : rpcError.message,
      )
      return
    }

    if (editingSlot) {
      setSlots(prev => prev.map(x => (x.id === editingSlot.id ? (data as ExtraPaySlot) : x)))
      toast({ title: 'Updated', description: 'Payroll will use the new hours.' })
    } else {
      setSlots(prev => [...prev, data as ExtraPaySlot])
      toast({ title: `${EXTRA_PAY_LABELS[form.kind]} scheduled` })
    }
    setDialogOpen(false)
    router.refresh()
  }

  async function handleCancel(id: string) {
    const { error: rpcError } = await supabase.rpc('cancel_extra_pay_slot', { p_id: id })
    if (rpcError) {
      toast({ title: 'Error', description: rpcError.message, variant: 'destructive' })
    } else {
      setSlots(prev => prev.map(s => (s.id === id ? { ...s, status: 'canceled' } : s)))
      toast({ title: 'Slot cancelled', description: 'It will not be paid.' })
      router.refresh()
    }
    setCancelId(null)
  }

  const visible = useMemo(
    () => [...slots].sort((a, b) => b.start_time.localeCompare(a.start_time)),
    [slots],
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Setup, training &amp; office hours</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Paid work that isn&apos;t a livestream. Each slot is paid at the rate you set here,
            separate from the host&apos;s livestream rate.
          </p>
        </div>
        <Button onClick={openCreate} size="sm" className="gap-2" disabled={hosts.length === 0 && moderators.length === 0}>
          <Plus className="w-4 h-4" />
          Add Slot
        </Button>
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">No slots yet. Add one to pay a host for setup, training, or office hours.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Host</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Type</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">When</th>
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Hours</th>
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Rate</th>
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Pay</th>
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s, i) => {
                const Icon = KIND_ICON[s.kind]
                const cancelled = s.status === 'canceled'
                const worked = new Date(s.end_time).getTime() <= nowMs
                return (
                  <tr
                    key={s.id}
                    className={`border-b border-border last:border-0 ${i % 2 === 0 ? '' : 'bg-secondary/20'} ${cancelled ? 'opacity-40' : ''}`}
                  >
                    <td className="px-4 py-3 font-medium text-foreground">
                      {s.host_id
                        ? hostName.get(s.host_id) ?? 'Unknown'
                        : moderatorName.get(s.moderator_id ?? '') ?? 'Unknown'}
                      <span className="block text-[11px] text-muted-foreground">
                        {s.host_id ? 'Host' : 'Moderator'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <Icon className="w-3.5 h-3.5" />
                        {EXTRA_PAY_LABELS[s.kind]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatPT(new Date(s.start_time), 'EEE, MMM d')} ·{' '}
                      {formatPT(new Date(s.start_time), 'h:mm a')}–
                      {formatPT(new Date(s.end_time), 'h:mm a')}
                      {cancelled && <Badge variant="outline" className="ml-2 text-[10px]">Cancelled</Badge>}
                      {!cancelled && worked && (
                        <Badge variant="outline" className="ml-2 text-[10px]">Worked</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {extraPayHours(s.start_time, s.end_time).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {formatCents(s.rate_cents)}/hr
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-foreground">
                      {cancelled ? '—' : formatCents(extraPayCents(s.start_time, s.end_time, s.rate_cents))}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!cancelled && (
                        <div className="flex items-center justify-end gap-3">
                          {/* Adjust hours after the fact — pay recalculates. */}
                          <button
                            type="button"
                            onClick={() => openEdit(s)}
                            title="Adjust hours or rate"
                            className="text-muted-foreground hover:text-primary transition-colors"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setCancelId(s.id)}
                            title="Remove this slot (won't be paid)"
                            className="text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingSlot ? 'Adjust paid slot' : 'Add paid slot'}</DialogTitle>
            <DialogDescription>
              {editingSlot
                ? 'Change the hours or rate and the payment updates to match. Payroll always recalculates from these times.'
                : 'The rate is saved onto this slot. Changing a default later won\u2019t change anything already worked.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Who the block is for. The role toggle clears the person, because
                a host id is meaningless against the moderator roster and
                silently keeping it would send a valid-looking but wrong id to
                the RPC. Both are locked while editing: moving a slot to a
                different person is not an edit, it is a different payment —
                cancel and recreate, which leaves both facts in the record. */}
            <div className="space-y-1.5">
              <Label>Who is this for</Label>
              <div className="flex gap-2">
                {(['host', 'moderator'] as WorkerRole[]).map(r => (
                  <Button
                    key={r}
                    type="button"
                    size="sm"
                    variant={form.role === r ? 'default' : 'outline'}
                    disabled={!!editingSlot || (r === 'host' ? hosts.length === 0 : moderators.length === 0)}
                    onClick={() => setForm(f => ({ ...f, role: r, workerId: '' }))}
                  >
                    {r === 'host' ? 'Host' : 'Moderator'}
                  </Button>
                ))}
              </div>
              <Select
                value={form.workerId}
                onValueChange={v => setForm(f => ({ ...f, workerId: v }))}
                disabled={!!editingSlot}
              >
                <SelectTrigger>
                  <SelectValue placeholder={form.role === 'host' ? 'Pick a host' : 'Pick a moderator'} />
                </SelectTrigger>
                <SelectContent>
                  {roster.map(w => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={form.kind}
                onValueChange={v => pickKind(v as ExtraPayKind)}
                disabled={!!editingSlot}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXTRA_PAY_KINDS.map(k => (
                    <SelectItem key={k} value={k}>{EXTRA_PAY_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="extra-date">Date</Label>
              <Input
                id="extra-date"
                type="date"
                value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="extra-start">Start</Label>
                <Input
                  id="extra-start"
                  type="time"
                  value={form.startTime}
                  onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="extra-end">End</Label>
                <Input
                  id="extra-end"
                  type="time"
                  value={form.endTime}
                  onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="extra-rate">Hourly rate ($)</Label>
              <Input
                id="extra-rate"
                type="number"
                min="0"
                step="0.01"
                value={form.rate}
                onChange={e => setForm(f => ({ ...f, rate: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="extra-notes">Notes (optional)</Label>
              <Input
                id="extra-notes"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="What's this for?"
              />
            </div>

            {preview && (
              <div className="rounded-md border border-border p-3 text-sm">
                <span className="text-muted-foreground">This will pay </span>
                <span className="font-medium text-foreground">{formatCents(preview.cents)}</span>
                <span className="text-muted-foreground"> for {preview.hours.toFixed(2)} hours.</span>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editingSlot ? 'Save changes' : 'Add Slot'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!cancelId} onOpenChange={() => setCancelId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this slot?</AlertDialogTitle>
            <AlertDialogDescription>
              It stays on the record for reference but won&apos;t be paid. This can&apos;t be undone
              from here — add a new slot if you need to reinstate it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => cancelId && handleCancel(cancelId)}>
              Cancel slot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
