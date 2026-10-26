'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { formatPT } from '@/lib/utils'
import { shiftLabelPT } from './schedulerShared'

export interface BotBookingRow {
  id: string
  brandName: string
  role: 'host' | 'moderator'
  workerName: string
  runStart: string
  runEnd: string
  bookedAt: string
  undoneAt: string | null
}

export function BotBookingsSection({ initialRows }: { initialRows: BotBookingRow[] }) {
  const [rows, setRows] = useState(initialRows)
  const [target, setTarget] = useState<BotBookingRow | null>(null)
  const [dontRefill, setDontRefill] = useState(false)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()

  async function undo() {
    if (!target) return
    setBusy(true)
    try {
      const { error } = await supabase.rpc('sched_undo_bot_booking', {
        p_booking: target.id,
        p_refill: !dontRefill,
      })
      if (error) throw new Error(error.message)
      setRows(prev => prev.map(r => r.id === target.id ? { ...r, undoneAt: new Date().toISOString() } : r))
      toast({ title: 'Booking undone', description: dontRefill ? 'This shift will not be re-offered by the bot.' : 'The shift is open again and may be re-offered.' })
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unable to undo.', variant: 'destructive' })
    } finally {
      setBusy(false)
      setTarget(null)
      setDontRefill(false)
    }
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="font-semibold">Bot bookings (latest 50)</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bot bookings yet.</p>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Brand</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Role</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Worker</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Shift (PT)</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Booked at</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Status</th>
                <th className="text-right px-3 py-2 text-muted-foreground font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={`border-b border-border last:border-0 ${i % 2 ? 'bg-secondary/20' : ''}`}>
                  <td className="px-3 py-2">{r.brandName}</td>
                  <td className="px-3 py-2 capitalize">{r.role}</td>
                  <td className="px-3 py-2">{r.workerName}</td>
                  <td className="px-3 py-2">{shiftLabelPT(r.runStart, r.runEnd)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatPT(r.bookedAt, 'M/d h:mmaaa')}</td>
                  <td className="px-3 py-2">
                    <Badge variant={r.undoneAt ? 'outline' : 'secondary'}>{r.undoneAt ? 'Undone' : 'Active'}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!r.undoneAt && (
                      <Button size="sm" variant="outline" onClick={() => setTarget(r)}>Undo</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={!!target} onOpenChange={(o) => { if (!o) { setTarget(null); setDontRefill(false) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this bot booking?</AlertDialogTitle>
            <AlertDialogDescription>
              {target && `${target.workerName} will be removed from ${shiftLabelPT(target.runStart, target.runEnd)}, only if the shift hasn't started and they're still the one assigned.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 px-1 cursor-pointer">
            <input
              type="checkbox"
              checked={dontRefill}
              onChange={e => setDontRefill(e.target.checked)}
              className="w-3.5 h-3.5 accent-primary"
            />
            <span className="text-sm">Don&apos;t re-offer this shift</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={undo} disabled={busy}>{busy ? 'Undoing…' : 'Undo booking'}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
