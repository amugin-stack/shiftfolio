'use client'

import { useMemo, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { ScheduleExportButton } from '@/components/admin/ScheduleExportButton'

// recharts is the single heaviest dependency on this route, and it backs ONE
// card near the bottom of the page that the admin may never scroll to. Loading
// it lazily takes it off the critical path: the dashboard's numbers render
// first, and the charting library arrives afterwards.
//
// ssr:false because recharts measures the DOM to size itself — server-rendering
// it produces markup that is thrown away on hydration anyway.
const GrowthChart = dynamic(
  () => import('./GrowthChart').then(m => m.GrowthChart),
  {
    ssr: false,
    // Reserve the chart's height so the page doesn't jump when it arrives.
    loading: () => (
      <section className="bg-card border border-border rounded-lg p-4 md:p-6">
        <div className="h-64 md:h-80 animate-pulse rounded-md bg-secondary" />
      </section>
    ),
  },
)

// Imported for use in this file's own props, and re-exported for the admin
// dashboard page, which imports this type from here. Both are `import type` /
// `export type`, erased at compile time, so neither pulls recharts back into
// this bundle.
import type { TrendPoint } from './GrowthChart'
export type { TrendPoint }

export interface BrandRow {
  brandId: string
  brandName: string
  brandLogoPath: string | null
  bookedHours: number
  completedHours: number
  shiftCount: number
  uniqueHosts: number
  avgShiftMinutes: number
  fillRate: number | null // 0..N ratio (can exceed 1); null = no contract set ("—"). Admin-only.
  /** What this brand pays us per hour, in cents. Null when admin hasn't set it. */
  clientRateCents: number | null
  /** clientRateCents * bookedHours, in cents. 0 when rate is null. */
  expectedRevenueCents: number
  /** clientRateCents * completedHours (shifts whose end_time has passed),
   *  in cents. 0 when rate is null. */
  realizedRevenueCents: number
  /** Sum of per-stream host payout for every booked shift this month.
   *  Mirrors the host payroll page's math. */
  expectedHostCostCents: number
  /** Same, but only for past shifts. */
  realizedHostCostCents: number
  /** Sum of moderator.rate_cents × duration for every booked shift with
   *  a moderator assigned. */
  expectedModeratorCostCents: number
  realizedModeratorCostCents: number
  /** Expected revenue − expected host cost − expected moderator cost. Can
   *  be negative when costs exceed the client rate. */
  expectedProfitCents: number
  /** Realized revenue − realized host cost − realized moderator cost. */
  realizedProfitCents: number
}

interface DashboardViewProps {
  monthKey: string // YYYY-MM
  rows: BrandRow[]
  /** Admin-only: when false, every revenue $$ surface is hidden (summary tiles,
   *  grid columns, per-row hints). Producers should pass false. */
  showRevenue?: boolean
  children?: ReactNode
  /** In-scope brands for the schedule CSV export (admins: all; producers:
   *  their assignments). When empty, the export button is hidden. */
  brands?: { id: string; name: string }[]
  /** Setup/training/office-hour cost for the month. COMPANY OVERHEAD — these
   *  slots carry no brand, so this is subtracted from the totals only, never
   *  from a per-brand row. Expected = all booked; Realized = already worked. */
  extraPayExpectedCents?: number
  extraPayRealizedCents?: number
}

type SortKey =
  | 'brandName'
  | 'bookedHours'
  | 'completedHours'
  | 'shiftCount'
  | 'uniqueHosts'
  | 'fillRate'
  | 'expectedRevenueCents'
  | 'realizedRevenueCents'
  | 'expectedProfitCents'
  | 'realizedProfitCents'

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

export function DashboardView({
  monthKey,
  rows,
  showRevenue = true,
  children,
  brands = [],
  extraPayExpectedCents = 0,
  extraPayRealizedCents = 0,
}: DashboardViewProps) {
  const router = useRouter()
  const [sortKey, setSortKey] = useState<SortKey>('bookedHours')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      const av = a[sortKey] as number | string
      const bv = b[sortKey] as number | string
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      const an = Number(av)
      const bn = Number(bv)
      return sortDir === 'asc' ? an - bn : bn - an
    })
    return copy
  }, [rows, sortKey, sortDir])

  const totals = useMemo(() => {
    const summed = rows.reduce(
      (acc, r) => {
        acc.booked += r.bookedHours
        acc.completed += r.completedHours
        acc.shifts += r.shiftCount
        acc.revenueCents += r.expectedRevenueCents
        acc.realizedCents += r.realizedRevenueCents
        acc.expectedProfitCents += r.expectedProfitCents
        acc.realizedProfitCents += r.realizedProfitCents
        return acc
      },
      {
        booked: 0,
        completed: 0,
        shifts: 0,
        revenueCents: 0,
        realizedCents: 0,
        expectedProfitCents: 0,
        realizedProfitCents: 0,
      },
    )
    // Setup / training / office hours is real money out, but it is COMPANY
    // OVERHEAD (the support team, 2026-08-25) — not billable to a brand. So it is
    // subtracted from the TOTALS only, never from a per-brand row: charging it
    // to a brand would misstate that brand's profitability. Without this,
    // company profit reads high by the full amount of every paid session.
    summed.expectedProfitCents -= extraPayExpectedCents
    summed.realizedProfitCents -= extraPayRealizedCents
    return summed
  }, [rows, extraPayExpectedCents, extraPayRealizedCents])

  function changeMonth(delta: number) {
    const next = shiftMonth(monthKey, delta)
    router.push(`/admin/dashboard?month=${next}`)
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'brandName' ? 'asc' : 'desc')
    }
  }

  const SortHeader = ({ k, label, align = 'right' }: { k: SortKey; label: string; align?: 'left' | 'right' }) => (
    <button
      type="button"
      onClick={() => toggleSort(k)}
      className={`flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors ${
        align === 'right' ? 'justify-end ml-auto' : ''
      } ${sortKey === k ? 'text-foreground' : ''}`}
    >
      {label}
      <ArrowUpDown className="w-3 h-3" />
    </button>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Booking analytics by brand</p>
        </div>
        <div className="flex items-center gap-2">
          <ScheduleExportButton brands={brands} monthKey={monthKey} />
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

      {/* Summary tiles. With revenue showing we now display 7 tiles (revenue
          pair, profit pair, and three counters). Mobile keeps the 2-col grid
          and scrolls; md grows to 4-wide so the row stays compact. */}
      <div
        className={
          showRevenue
            ? 'grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3'
            : 'grid grid-cols-2 md:grid-cols-3 gap-3'
        }
      >
        {showRevenue && (
          <>
            <StatTile label="Expected revenue" value={fmtDollars(totals.revenueCents)} highlight />
            <StatTile label="Realized revenue" value={fmtDollars(totals.realizedCents)} subdued />
            <StatTile
              label="Expected profit"
              value={fmtDollars(totals.expectedProfitCents)}
              tone={totals.expectedProfitCents >= 0 ? 'positive' : 'negative'}
            />
            {/* Shown whenever there is any, so the profit figure is
                explainable rather than just smaller than the brand rows imply.
                Company-wide, which is why it sits outside the per-brand grid. */}
            {extraPayExpectedCents > 0 && (
              <StatTile
                label="Setup / training / office hrs"
                value={`−${fmtDollars(extraPayRealizedCents)}`}
                subdued
              />
            )}
            <StatTile
              label="Realized profit"
              value={fmtDollars(totals.realizedProfitCents)}
              tone={totals.realizedProfitCents >= 0 ? 'positive' : 'negative'}
              subdued
            />
          </>
        )}
        <StatTile label="Booked hours" value={fmtHours(totals.booked)} />
        <StatTile label="Completed hours" value={fmtHours(totals.completed)} subdued />
        <StatTile label="Total shifts" value={totals.shifts.toLocaleString()} />
      </div>

      {/* Brand grid. With revenue shown the row now has 10 columns (brand,
          exp revenue, real revenue, exp profit, real profit, booked, completed,
          shifts, hosts, fill). The track template gives revenue+profit a
          slightly wider share since dollar values are wider than counts. */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div
          className={
            'hidden md:grid items-center gap-4 px-4 py-2.5 border-b border-border bg-secondary/40 ' +
            (showRevenue
              ? 'grid-cols-[2fr_1.1fr_1.1fr_1.1fr_1.1fr_1fr_1fr_0.8fr_1fr_1fr]'
              : 'grid-cols-[2fr_1fr_1fr_0.8fr_1fr]')
          }
        >
          <SortHeader k="brandName" label="Brand" align="left" />
          {showRevenue && (
            <>
              <SortHeader k="expectedRevenueCents" label="Exp. Rev" />
              <SortHeader k="realizedRevenueCents" label="Real. Rev" />
              <SortHeader k="expectedProfitCents" label="Exp. Profit" />
              <SortHeader k="realizedProfitCents" label="Real. Profit" />
            </>
          )}
          <SortHeader k="bookedHours" label="Booked" />
          <SortHeader k="completedHours" label="Completed" />
          <SortHeader k="shiftCount" label="Shifts" />
          <SortHeader k="uniqueHosts" label="Hosts" />
          {showRevenue && <SortHeader k="fillRate" label="Fill" />}
        </div>

        {sorted.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No brands configured.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map(r => {
              const empty = r.shiftCount === 0
              return (
                <li key={r.brandId}>
                  <Link
                    href={`/admin/dashboard/${r.brandId}?month=${monthKey}`}
                    className={
                      'grid grid-cols-2 items-center gap-4 px-4 py-3 hover:bg-secondary/40 transition-colors ' +
                      (showRevenue
                        ? 'md:grid-cols-[2fr_1.1fr_1.1fr_1.1fr_1.1fr_1fr_1fr_0.8fr_1fr_1fr]'
                        : 'md:grid-cols-[2fr_1fr_1fr_0.8fr_1fr]')
                    }
                  >
                    <div className="col-span-2 md:col-span-1 min-w-0 flex items-center gap-2.5">
                      <BrandLogo name={r.brandName} logoPath={r.brandLogoPath} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">{r.brandName}</p>
                        {empty && (
                          <p className="text-[11px] text-muted-foreground italic">No bookings this month</p>
                        )}
                        {showRevenue && r.clientRateCents == null && (
                          <p className="text-[11px] text-muted-foreground italic">No client rate set</p>
                        )}
                      </div>
                    </div>
                    {showRevenue && (
                      <>
                        <Cell
                          label="Exp. Rev"
                          value={r.clientRateCents != null ? fmtDollars(r.expectedRevenueCents) : '—'}
                          dim={empty || r.clientRateCents == null}
                          highlight={!empty && r.clientRateCents != null}
                        />
                        <Cell
                          label="Real. Rev"
                          value={r.clientRateCents != null ? fmtDollars(r.realizedRevenueCents) : '—'}
                          dim={empty || r.clientRateCents == null}
                          subdued
                        />
                        <Cell
                          label="Exp. Profit"
                          value={r.clientRateCents != null ? fmtDollars(r.expectedProfitCents) : '—'}
                          dim={empty || r.clientRateCents == null}
                          tone={
                            !empty && r.clientRateCents != null
                              ? r.expectedProfitCents >= 0 ? 'positive' : 'negative'
                              : undefined
                          }
                        />
                        <Cell
                          label="Real. Profit"
                          value={r.clientRateCents != null ? fmtDollars(r.realizedProfitCents) : '—'}
                          dim={empty || r.clientRateCents == null}
                          subdued
                          tone={
                            !empty && r.clientRateCents != null
                              ? r.realizedProfitCents >= 0 ? 'positive' : 'negative'
                              : undefined
                          }
                        />
                      </>
                    )}
                    <Cell label="Booked" value={fmtHours(r.bookedHours)} dim={empty} />
                    <Cell label="Completed" value={fmtHours(r.completedHours)} dim={empty} subdued />
                    <Cell label="Shifts" value={r.shiftCount.toLocaleString()} dim={empty} />
                    <Cell label="Hosts" value={r.uniqueHosts.toLocaleString()} dim={empty} />
                    {showRevenue && (
                      <Cell
                        label="Fill"
                        value={r.fillRate == null ? '—' : `${(r.fillRate * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}%`}
                        dim={empty}
                      />
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {children}
    </div>
  )
}


function StatTile({
  label,
  value,
  highlight,
  subdued,
  tone,
}: {
  label: string
  value: string
  highlight?: boolean
  subdued?: boolean
  /** When set, overrides highlight/foreground with a profit-tone color.
   *  Subdued still applies (used to dim Realized profit relative to Expected). */
  tone?: 'positive' | 'negative'
}) {
  const valueColor = (() => {
    if (tone === 'negative') return subdued ? 'text-destructive/60' : 'text-destructive'
    if (tone === 'positive') return subdued ? 'text-emerald-600/80' : 'text-emerald-600'
    if (highlight) return 'text-primary'
    if (subdued) return 'text-muted-foreground'
    return 'text-foreground'
  })()
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={'mt-1 text-2xl font-bold ' + valueColor}>{value}</p>
    </div>
  )
}

function Cell({
  label,
  value,
  dim,
  highlight,
  subdued,
  tone,
}: {
  label: string
  value: string
  dim?: boolean
  highlight?: boolean
  subdued?: boolean
  tone?: 'positive' | 'negative'
}) {
  const color = (() => {
    if (dim) return 'text-muted-foreground'
    if (tone === 'negative') return subdued ? 'text-destructive/70 font-semibold' : 'text-destructive font-semibold'
    if (tone === 'positive') return subdued ? 'text-emerald-600/80 font-semibold' : 'text-emerald-600 font-semibold'
    if (highlight) return 'text-primary font-semibold'
    if (subdued) return 'text-muted-foreground'
    return 'text-foreground'
  })()
  return (
    <div className="md:text-right">
      <p className="md:hidden text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={'text-sm font-medium tabular-nums ' + color}>{value}</p>
    </div>
  )
}

export function DashboardGrowthChart({ weeklyTrend, monthlyTrend }: { weeklyTrend: TrendPoint[]; monthlyTrend: TrendPoint[] }) {
  return <GrowthChart weeklyTrend={weeklyTrend} monthlyTrend={monthlyTrend} />
}
