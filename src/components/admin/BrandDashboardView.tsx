'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatPT } from '@/lib/utils'
import { BrandLogo } from '@/components/brand/BrandLogo'

export interface BrandShiftDetail {
  id: string
  hostId: string
  hostName: string
  startISO: string
  endISO: string
  durationMinutes: number
  isPast: boolean
}

export interface HostBreakdown {
  hostId: string
  hostName: string
  hours: number
  shifts: number
}

export interface BrandDetailData {
  brandId: string
  brandName: string
  brandLogoPath: string | null
  bookedHours: number
  completedHours: number
  shiftCount: number
  uniqueHosts: number
  avgShiftMinutes: number
  fillRate: number | null
  /** What this brand pays us per hour, in cents. Null when admin hasn't set it. */
  clientRateCents: number | null
  /** clientRateCents * bookedHours, in cents. 0 when rate is null. */
  expectedRevenueCents: number
  /** clientRateCents * completedHours (past shifts), in cents. */
  realizedRevenueCents: number
  /** Sum of per-stream host payout across every booked shift this month. */
  expectedHostCostCents: number
  /** Same, but only past shifts. */
  realizedHostCostCents: number
  /** Sum of moderator.rate_cents × duration when a moderator is assigned. */
  expectedModeratorCostCents: number
  realizedModeratorCostCents: number
  /** Expected revenue − expected host cost − expected moderator cost. Can
   *  be negative when costs exceed the client rate. */
  expectedProfitCents: number
  realizedProfitCents: number
  hosts: HostBreakdown[]
  shifts: BrandShiftDetail[]
}

interface Props {
  monthKey: string
  data: BrandDetailData
  /** Admin-only: when false, hides the two revenue tiles (Expected/Realized).
   *  Producers should pass false. Defaults true for backwards compatibility. */
  showRevenue?: boolean
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

export function BrandDashboardView({ monthKey, data, showRevenue = true }: Props) {
  const router = useRouter()

  function changeMonth(delta: number) {
    const next = shiftMonth(monthKey, delta)
    router.push(`/admin/dashboard/${data.brandId}?month=${next}`)
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
          href={`/admin/dashboard?month=${monthKey}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </Link>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <BrandLogo name={data.brandName} logoPath={data.brandLogoPath} size="xl" />
            <div>
              <h1 className="text-2xl font-bold text-foreground">{data.brandName}</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Monthly booking detail</p>
            </div>
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

      {/* Stat tiles. Revenue + profit pairs render side-by-side at md+, then
          host/moderator cost breakdown beneath. Producers (showRevenue=false)
          only see hour counts. */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {showRevenue && (
          <>
            <RevenueTile
              revenueCents={data.expectedRevenueCents}
              clientRateCents={data.clientRateCents}
              hours={data.bookedHours}
              label="Expected revenue"
              subline="booked"
            />
            <RevenueTile
              revenueCents={data.realizedRevenueCents}
              clientRateCents={data.clientRateCents}
              hours={data.completedHours}
              label="Realized revenue"
              subline="completed"
              subdued
            />
            <ProfitTile
              profitCents={data.expectedProfitCents}
              hostCostCents={data.expectedHostCostCents}
              moderatorCostCents={data.expectedModeratorCostCents}
              clientRateCents={data.clientRateCents}
              label="Expected profit"
            />
            <ProfitTile
              profitCents={data.realizedProfitCents}
              hostCostCents={data.realizedHostCostCents}
              moderatorCostCents={data.realizedModeratorCostCents}
              clientRateCents={data.clientRateCents}
              label="Realized profit"
              subdued
            />
          </>
        )}
        <StatTile label="Booked hours" value={fmtHours(data.bookedHours)} />
        <StatTile label="Completed hours" value={fmtHours(data.completedHours)} subdued />
        <StatTile label="Shifts" value={data.shiftCount.toLocaleString()} />
        <StatTile label="Avg shift" value={data.shiftCount > 0 ? fmtDurationMinutes(data.avgShiftMinutes) : '—'} />
      </div>

      {/* Per-host breakdown */}
      <section className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Hosts this month</h2>
        </div>
        {data.hosts.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No hosted shifts this month.
          </div>
        ) : (
          <div className="hidden md:grid grid-cols-[2fr_1fr_1fr] items-center gap-4 px-4 py-2 border-b border-border bg-secondary/40">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Host</p>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Hours</p>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Shifts</p>
          </div>
        )}
        <ul className="divide-y divide-border">
          {data.hosts.map(h => (
            <li
              key={h.hostId}
              className="grid grid-cols-2 md:grid-cols-[2fr_1fr_1fr] items-center gap-4 px-4 py-3"
            >
              <p className="col-span-2 md:col-span-1 text-sm font-semibold text-foreground truncate">{h.hostName}</p>
              <Cell label="Hours" value={fmtHours(h.hours)} highlight />
              <Cell label="Shifts" value={h.shifts.toLocaleString()} />
            </li>
          ))}
        </ul>
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
            <div className="hidden md:grid grid-cols-[1.4fr_1.4fr_1fr_1.6fr] items-center gap-4 px-4 py-2 border-b border-border bg-secondary/40">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Date</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Time</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Length</p>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Host</p>
            </div>
            <ul className="divide-y divide-border">
              {sortedShifts.map(s => (
                <li
                  key={s.id}
                  className={
                    'grid grid-cols-2 md:grid-cols-[1.4fr_1.4fr_1fr_1.6fr] items-center gap-4 px-4 py-3 ' +
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
                  <Cell label="Host" value={s.hostName} align="left" />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

function RevenueTile({
  revenueCents,
  clientRateCents,
  hours,
  label,
  subline,
  subdued,
}: {
  revenueCents: number
  clientRateCents: number | null
  hours: number
  label: string
  subline: string
  subdued?: boolean
}) {
  const hasRate = clientRateCents != null
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      {hasRate ? (
        <>
          <p className={'mt-1 text-2xl font-bold ' + (subdued ? 'text-foreground' : 'text-primary')}>
            {fmtDollars(revenueCents)}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {fmtRatePerHour(clientRateCents!)} × {fmtHours(hours)} {subline}
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-2xl font-bold text-muted-foreground">Not set</p>
          <Link href="/admin/brands" className="text-[11px] text-primary hover:underline mt-0.5 inline-block">
            Set client rate →
          </Link>
        </>
      )}
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

function ProfitTile({
  profitCents,
  hostCostCents,
  moderatorCostCents,
  clientRateCents,
  label,
  subdued,
}: {
  profitCents: number
  hostCostCents: number
  moderatorCostCents: number
  clientRateCents: number | null
  label: string
  subdued?: boolean
}) {
  const hasRate = clientRateCents != null
  // Green for positive profit, red for negative. Subdued for the realized
  // tile keeps a visual hierarchy with the expected (primary) tile.
  const valueColor = (() => {
    if (!hasRate) return 'text-muted-foreground'
    if (profitCents < 0) return subdued ? 'text-destructive/80' : 'text-destructive'
    return subdued ? 'text-emerald-600/80' : 'text-emerald-600'
  })()
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      {hasRate ? (
        <>
          <p className={'mt-1 text-2xl font-bold ' + valueColor}>{fmtDollars(profitCents)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            − {fmtDollars(hostCostCents)} hosts · {fmtDollars(moderatorCostCents)} mods
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-2xl font-bold text-muted-foreground">Not set</p>
          <Link href="/admin/brands" className="text-[11px] text-primary hover:underline mt-0.5 inline-block">
            Set client rate →
          </Link>
        </>
      )}
    </div>
  )
}

function Cell({
  label,
  value,
  highlight,
  align = 'right',
}: {
  label: string
  value: string
  highlight?: boolean
  align?: 'left' | 'right'
}) {
  return (
    <div className={align === 'right' ? 'md:text-right' : ''}>
      <p className="md:hidden text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p
        className={
          'text-sm tabular-nums truncate ' +
          (highlight ? 'text-primary font-semibold' : 'text-foreground font-medium')
        }
      >
        {value}
      </p>
    </div>
  )
}
