'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { formatPT } from '@/lib/utils'

export interface HostShiftDetail {
  id: string
  brandId: string
  brandName: string
  brandLogoPath: string | null
  startISO: string
  endISO: string
  durationMinutes: number
  rateCents: number
  earningsCents: number
  isPast: boolean
}

export interface HostBrandBreakdown {
  brandId: string
  brandName: string
  brandLogoPath: string | null
  hours: number
  shifts: number
  expectedEarningsCents: number
  realizedEarningsCents: number
}

export interface HostDetailData {
  hostId: string
  hostName: string
  bookedHours: number
  completedHours: number
  shiftCount: number
  brandCount: number
  avgShiftMinutes: number
  expectedEarningsCents: number
  realizedEarningsCents: number
  brands: HostBrandBreakdown[]
  shifts: HostShiftDetail[]
}

interface Props {
  monthKey: string
  data: HostDetailData
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

function fmtHours(hours: number): string {
  return `${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })} hr`
}

function fmtDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtRatePerHour(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}/hr`
}

function fmtDurationMinutes(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function HostDashboardView({ monthKey, data }: Props) {
  const router = useRouter()

  function changeMonth(delta: number) {
    const next = shiftMonth(monthKey, delta)
    router.push(`/admin/payroll/hosts/${data.hostId}?month=${next}`)
  }

  const sortedShifts = useMemo(
    () => [...data.shifts].sort((a, b) => a.startISO.localeCompare(b.startISO)),
    [data.shifts],
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <Link
          href={`/admin/payroll/hosts?month=${monthKey}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Payroll
        </Link>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{data.hostName}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Monthly earnings detail</p>
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

      {/* Stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatTile label="Expected earnings" value={fmtDollars(data.expectedEarningsCents)} highlight />
        <StatTile label="Realized earnings" value={fmtDollars(data.realizedEarningsCents)} subdued />
        <StatTile label="Brands" value={data.brandCount.toLocaleString()} />
        <StatTile label="Booked hours" value={fmtHours(data.bookedHours)} />
        <StatTile label="Completed hours" value={fmtHours(data.completedHours)} subdued />
        <StatTile label="Avg shift" value={data.shiftCount > 0 ? fmtDurationMinutes(data.avgShiftMinutes) : '—'} />
      </div>

      {/* Per-brand breakdown */}
      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Brands this month</h2>
        </div>
        {data.brands.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No hosted shifts this month.
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-[2fr_1.1fr_1.1fr_1fr_0.8fr] items-center gap-4 px-4 py-2 border-b border-border bg-secondary/40">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Brand</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Expected</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Realized</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Hours</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Shifts</p>
            </div>
            <ul className="divide-y divide-border">
              {data.brands.map(b => (
                <li
                  key={b.brandId}
                  className="grid grid-cols-2 md:grid-cols-[2fr_1.1fr_1.1fr_1fr_0.8fr] items-center gap-4 px-4 py-3"
                >
                  <div className="col-span-2 md:col-span-1 min-w-0 flex items-center gap-2.5">
                    <BrandLogo name={b.brandName} logoPath={b.brandLogoPath} size="sm" />
                    <p className="text-sm font-semibold text-foreground truncate">{b.brandName}</p>
                  </div>
                  <Cell label="Expected" value={fmtDollars(b.expectedEarningsCents)} highlight />
                  <Cell label="Realized" value={fmtDollars(b.realizedEarningsCents)} subdued />
                  <Cell label="Hours" value={fmtHours(b.hours)} />
                  <Cell label="Shifts" value={b.shifts.toLocaleString()} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Shift list */}
      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">All shifts</h2>
        </div>
        {sortedShifts.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No shifts to show.
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-[1.3fr_1.3fr_0.8fr_1.4fr_0.9fr_1fr] items-center gap-4 px-4 py-2 border-b border-border bg-secondary/40">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Time</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Length</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Brand</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Rate</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Earned</p>
            </div>
            <ul className="divide-y divide-border">
              {sortedShifts.map(s => (
                <li
                  key={s.id}
                  className={
                    'grid grid-cols-2 md:grid-cols-[1.3fr_1.3fr_0.8fr_1.4fr_0.9fr_1fr] items-center gap-4 px-4 py-3 ' +
                    (s.isPast ? 'opacity-70' : '')
                  }
                >
                  <Cell label="Date" value={formatPT(s.startISO, 'EEE, MMM d')} align="left" />
                  <Cell
                    label="Time"
                    value={`${formatPT(s.startISO, 'h:mm a')} – ${formatPT(s.endISO, 'h:mm a')}`}
                    align="left"
                  />
                  <Cell label="Length" value={fmtDurationMinutes(s.durationMinutes)} align="left" />
                  <Cell label="Brand" value={s.brandName} align="left" />
                  <Cell label="Rate" value={fmtRatePerHour(s.rateCents)} />
                  <Cell label="Earned" value={fmtDollars(s.earningsCents)} highlight />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

function StatTile({
  label,
  value,
  highlight,
  subdued,
}: {
  label: string
  value: string
  highlight?: boolean
  subdued?: boolean
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p
        className={
          'mt-1 text-2xl font-bold ' +
          (highlight ? 'text-primary' : subdued ? 'text-muted-foreground' : 'text-foreground')
        }
      >
        {value}
      </p>
    </div>
  )
}

function Cell({
  label,
  value,
  highlight,
  subdued,
  align = 'right',
}: {
  label: string
  value: string
  highlight?: boolean
  subdued?: boolean
  align?: 'left' | 'right'
}) {
  return (
    <div className={align === 'right' ? 'md:text-right' : ''}>
      <p className="md:hidden text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p
        className={
          'text-sm tabular-nums truncate ' +
          (highlight
            ? 'text-primary font-semibold'
            : subdued
              ? 'text-muted-foreground font-medium'
              : 'text-foreground font-medium')
        }
      >
        {value}
      </p>
    </div>
  )
}
