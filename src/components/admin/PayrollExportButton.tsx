'use client'

import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { nowPtAsUtc } from '@/lib/utils'
import {
  currentPayPeriodStartKey,
  formatPayPeriodLabel,
  resolvePayPeriod,
  shiftPayPeriodKey,
} from '@/lib/payPeriod'

// 'previous' and 'current' are the anchored biweekly pay periods — the same
// calendar every worker sees on My Shifts, so the CSV you pay from and the
// number they were shown cover the same fourteen days. They replaced a rolling
// "past 2 weeks" that meant 14 days back from whatever day you clicked, which
// could leave days inside no export window at all.
type RangeMode = 'previous' | 'current' | 'month' | 'custom'

export function PayrollExportButton() {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  // Defaults to the CLOSED period — the one you actually pay. Everything in it
  // has finished, so the completed-shifts-only rule cannot quietly drop work
  // from the file.
  const [mode, setMode] = useState<RangeMode>('previous')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [hosts, setHosts] = useState(true)
  const [moderators, setModerators] = useState(true)
  // Which hours to pay. Defaults to SCHEDULED because that matches how payroll
  // is actually run -- a couple of days before the period closes. The route
  // defaults the other way for bookmarks without the parameter; the two
  // defaults differ deliberately.
  const [basis, setBasis] = useState<'scheduled' | 'completed'>('scheduled')
  const [busy, setBusy] = useState(false)
  const [emptyMsg, setEmptyMsg] = useState<string | null>(null)

  // Computed at render, but the dialog body only mounts once it's open, so
  // there is no server/client hydration mismatch to worry about.
  const currentKey = currentPayPeriodStartKey(nowPtAsUtc())
  const currentLabel = formatPayPeriodLabel(resolvePayPeriod(currentKey))
  const previousLabel = formatPayPeriodLabel(resolvePayPeriod(shiftPayPeriodKey(currentKey, -1)))

  const customInvalid = mode === 'custom' && (!from || !to || from > to)
  const noRole = !hosts && !moderators
  const disabled = busy || noRole || customInvalid

  function buildUrl(): string {
    const params = new URLSearchParams()
    const roles = [hosts ? 'hosts' : null, moderators ? 'moderators' : null].filter(Boolean).join(',')
    params.set('roles', roles)
    if (mode === 'custom') {
      params.set('from', from)
      params.set('to', to)
    } else {
      params.set('preset', mode)
    }
    params.set('basis', basis)
    return `/admin/payroll/export?${params.toString()}`
  }

  async function handleExport() {
    setBusy(true)
    setEmptyMsg(null)
    try {
      const res = await fetch(buildUrl())
      if (!res.ok) {
        toast({ title: 'Export failed', description: await res.text(), variant: 'destructive' })
        return
      }
      const text = await res.text()
      const dataLines = text.split('\n').length - 1 // minus header
      if (dataLines === 0) {
        setEmptyMsg('No one worked in that range.')
        return
      }
      // Trigger a client-side download from the CSV text.
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = disposition.match(/filename="([^"]+)"/)
      const a = document.createElement('a')
      a.href = url
      a.download = match?.[1] ?? 'payroll.csv'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      setOpen(false)
    } catch {
      toast({ title: 'Export failed', description: 'Could not generate the CSV.', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export payroll CSV</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Range */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-foreground mb-1">Date range</legend>
            {([
              ['previous', 'Last pay period', previousLabel],
              ['current', 'Current pay period', `${currentLabel} · still running`],
              ['month', 'Past 30 days', 'Not a pay period — for reference only'],
              ['custom', 'Custom range', null],
            ] as [RangeMode, string, string | null][]).map(([value, label, hint]) => (
              <label key={value} className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio" name="range" value={value} checked={mode === value}
                  onChange={() => { setMode(value); setEmptyMsg(null) }} className="accent-primary mt-1"
                />
                <span>
                  {label}
                  {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
                </span>
              </label>
            ))}
            {mode === 'current' && basis === 'completed' && (
              <p className="text-xs text-muted-foreground pl-6">
                This period hasn&apos;t finished, and you&apos;ve chosen completed hours only —
                shifts that haven&apos;t ended yet are left out, so the totals will still grow.
                That is what causes people to be paid short.
              </p>
            )}
            {mode === 'custom' && (
              <div className="grid grid-cols-2 gap-3 pt-2 pl-6">
                <div className="space-y-1">
                  <Label htmlFor="from" className="text-xs">From</Label>
                  <Input id="from" type="date" value={from} onChange={e => { setFrom(e.target.value); setEmptyMsg(null) }} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="to" className="text-xs">To</Label>
                  <Input id="to" type="date" value={to} onChange={e => { setTo(e.target.value); setEmptyMsg(null) }} />
                </div>
              </div>
            )}
            {customInvalid && (
              <p className="text-xs text-destructive pl-6">Pick a start date on or before the end date.</p>
            )}
          </fieldset>

          {/* Which hours to pay */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-foreground mb-1">Hours to pay</legend>
            {([
              ['scheduled', 'All scheduled hours', 'Everything booked in the period, worked or not'],
              ['completed', 'Completed hours only', 'Only shifts that have already finished'],
            ] as ['scheduled' | 'completed', string, string][]).map(([value, label, hint]) => (
              <label key={value} className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio" name="basis" value={value} checked={basis === value}
                  onChange={() => { setBasis(value); setEmptyMsg(null) }} className="accent-primary mt-1"
                />
                <span>
                  {label}
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
            {/* Everything in a closed period has already ended, so the choice
                cannot change the file. Saying so stops the second-guessing. */}
            {mode === 'previous' && (
              <p className="text-xs text-muted-foreground pl-6">
                This period has closed, so both options produce the same file.
              </p>
            )}
            {mode === 'current' && basis === 'scheduled' && (
              <p className="text-xs text-muted-foreground pl-6">
                Includes shifts not yet worked, so nobody is paid short. The CSV has an
                <strong> Unworked Hours</strong> column showing how much of each person&apos;s
                total is still to come. Shifts with a cancellation already requested are left
                out automatically.
              </p>
            )}
          </fieldset>

          {/* Roles */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-foreground mb-1">Include</legend>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={hosts} onChange={e => { setHosts(e.target.checked); setEmptyMsg(null) }} className="accent-primary" />
              Hosts
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={moderators} onChange={e => { setModerators(e.target.checked); setEmptyMsg(null) }} className="accent-primary" />
              Moderators
            </label>
            {noRole && <p className="text-xs text-destructive">Select at least one.</p>}
          </fieldset>

          {emptyMsg && <p className="text-sm text-muted-foreground">{emptyMsg}</p>}
        </div>

        <DialogFooter>
          <Button onClick={handleExport} disabled={disabled}>
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
