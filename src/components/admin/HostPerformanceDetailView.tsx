'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatCents, formatPT } from '@/lib/utils'

export interface PerfSessionRow {
  anchorId: string
  startISO: string
  endISO: string
  brandName: string
  hours: number
  gmvCents: number | null
  gmvPerHourCents: number | null
}

export interface HostPerformanceDetail {
  hostName: string
  weekGmvCents: number
  monthGmvCents: number
  monthGmvPerHourCents: number | null
  sessions: PerfSessionRow[]
}

function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function formatMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1, 1))
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function perHour(cents: number | null): string {
  return cents == null ? '—' : `${formatCents(cents)}/hr`
}

function fmtHours(hours: number): string {
  return `${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })} hr`
}

export function HostPerformanceDetailView({
  hostId,
  monthKey,
  data,
}: {
  hostId: string
  monthKey: string
  data: HostPerformanceDetail
}) {
  const router = useRouter()
  function changeMonth(delta: number) {
    router.push(`/admin/performance/${hostId}?month=${shiftMonth(monthKey, delta)}`)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <Link
          href={`/admin/performance?month=${monthKey}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Host Performance
        </Link>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{data.hostName}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">GMV by session</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => changeMonth(-1)} aria-label="Previous month">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="px-4 py-2 min-w-[180px] text-center font-semibold text-foreground bg-card border border-border rounded-md">
              {formatMonthLabel(monthKey)}
            </div>
            <Button variant="outline" size="icon" onClick={() => changeMonth(1)} aria-label="Next month">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile label="GMV this week" value={formatCents(data.weekGmvCents)} />
        <Tile label={`GMV in ${formatMonthLabel(monthKey)}`} value={formatCents(data.monthGmvCents)} highlight />
        <Tile label="GMV / hr (month)" value={perHour(data.monthGmvPerHourCents)} />
      </div>

      {/* Sessions */}
      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Sessions this month</h2>
        </div>
        {data.sessions.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No sessions this month.</div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-[1.4fr_1.4fr_0.8fr_1fr_1fr] items-center gap-4 px-4 py-2 border-b border-border bg-secondary/40">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Brand</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Hours</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">GMV</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">GMV / hr</p>
            </div>
            <ul className="divide-y divide-border">
              {data.sessions.map(s => (
                <li
                  key={s.anchorId}
                  className="grid grid-cols-2 md:grid-cols-[1.4fr_1.4fr_0.8fr_1fr_1fr] items-center gap-4 px-4 py-3"
                >
                  <DCell label="Date" value={`${formatPT(s.startISO, 'EEE, MMM d')} · ${formatPT(s.startISO, 'h:mm a')}`} align="left" />
                  <DCell label="Brand" value={s.brandName} align="left" />
                  <DCell label="Hours" value={fmtHours(s.hours)} />
                  <DCell label="GMV" value={s.gmvCents == null ? '—' : formatCents(s.gmvCents)} highlight={s.gmvCents != null} />
                  <DCell label="GMV / hr" value={perHour(s.gmvPerHourCents)} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

function Tile({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={'mt-1 text-2xl font-bold ' + (highlight ? 'text-primary' : 'text-foreground')}>{value}</p>
    </div>
  )
}

function DCell({ label, value, align = 'right', highlight }: { label: string; value: string; align?: 'left' | 'right'; highlight?: boolean }) {
  return (
    <div className={align === 'right' ? 'md:text-right' : ''}>
      <p className="md:hidden text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={'text-sm tabular-nums truncate ' + (highlight ? 'text-primary font-semibold' : 'text-foreground font-medium')}>{value}</p>
    </div>
  )
}
