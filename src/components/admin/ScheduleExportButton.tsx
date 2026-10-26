'use client'

import { useMemo, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'

type PeriodMode = 'month' | 'week' | 'custom'

interface BrandOption {
  id: string
  name: string
}

interface WeekOption {
  /** Monday, YYYY-MM-DD — the value sent to the route. */
  value: string
  /** e.g. "Jun 2 – Jun 8". */
  label: string
}

/** Every Mon–Sun week that overlaps the given PT month (`YYYY-MM`). */
function weeksForMonth(monthKey: string): WeekOption[] {
  const [y, m] = monthKey.split('-').map(Number)
  const monthStart = Date.UTC(y, m - 1, 1)
  const lastDay = Date.UTC(y, m, 0) // day 0 of next month = last day of this one
  // Monday on or before the 1st.
  const startDay = new Date(monthStart).getUTCDay() // 0=Sun..6=Sat
  const backToMonday = startDay === 0 ? 6 : startDay - 1
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const ymd = (ms: number) => {
    const d = new Date(ms)
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    return `${d.getUTCFullYear()}-${mm}-${dd}`
  }
  const weeks: WeekOption[] = []
  for (let mon = monthStart - backToMonday * 86_400_000; mon <= lastDay; mon += 7 * 86_400_000) {
    const sun = mon + 6 * 86_400_000
    weeks.push({ value: ymd(mon), label: `${fmt(mon)} – ${fmt(sun)}` })
  }
  return weeks
}

export function ScheduleExportButton({
  brands,
  monthKey,
}: {
  brands: BrandOption[]
  monthKey: string
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '')
  const [mode, setMode] = useState<PeriodMode>('month')
  const weeks = useMemo(() => weeksForMonth(monthKey), [monthKey])
  const [week, setWeek] = useState(weeks[0]?.value ?? '')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [emptyMsg, setEmptyMsg] = useState<string | null>(null)

  if (brands.length === 0) return null

  const customInvalid = mode === 'custom' && (!from || !to || from > to)
  const disabled = busy || !brandId || customInvalid

  function buildUrl(): string {
    const params = new URLSearchParams()
    params.set('brand', brandId)
    if (mode === 'month') {
      params.set('month', monthKey)
    } else if (mode === 'week') {
      params.set('week', week)
    } else {
      params.set('from', from)
      params.set('to', to)
    }
    return `/admin/dashboard/schedule-export?${params.toString()}`
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
        setEmptyMsg('No shifts in that range.')
        return
      }
      // Trigger a client-side download from the CSV text.
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const match = disposition.match(/filename="([^"]+)"/)
      const a = document.createElement('a')
      a.href = url
      a.download = match?.[1] ?? 'schedule.csv'
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
          Export schedule
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export schedule CSV</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Brand */}
          <div className="space-y-1">
            <Label htmlFor="brand" className="text-sm font-semibold">Brand</Label>
            <select
              id="brand"
              value={brandId}
              onChange={e => { setBrandId(e.target.value); setEmptyMsg(null) }}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {brands.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          {/* Period */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-foreground mb-1">Period</legend>
            {([
              ['month', 'This month'],
              ['week', 'A week'],
              ['custom', 'Custom range'],
            ] as [PeriodMode, string][]).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio" name="period" value={value} checked={mode === value}
                  onChange={() => { setMode(value); setEmptyMsg(null) }} className="accent-primary"
                />
                {label}
              </label>
            ))}

            {mode === 'week' && (
              <div className="pt-2 pl-6">
                <select
                  value={week}
                  onChange={e => { setWeek(e.target.value); setEmptyMsg(null) }}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  {weeks.map(w => (
                    <option key={w.value} value={w.value}>{w.label}</option>
                  ))}
                </select>
              </div>
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
