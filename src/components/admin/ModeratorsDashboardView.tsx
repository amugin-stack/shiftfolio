'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PayrollTabs } from './PayrollTabs'
import { PayrollExportButton } from './PayrollExportButton'

export interface ModeratorRow {
  moderatorId: string
  moderatorName: string
  rateCents: number
  bookedHours: number
  completedHours: number
  shiftCount: number
  /** Shifts that earned the first-of-day +30 min setup pay (pre-cutoff rule). */
  setupShifts: number
  /** New-rule prep blocks this month (one per contiguous session, post-cutoff). */
  prepBlocks: number
  /** Prep pay portion of the earnings totals, in cents. */
  prepCents: number
  brandCount: number
  expectedEarningsCents: number
  realizedEarningsCents: number
}

interface ModeratorsDashboardViewProps {
  monthKey: string
  rows: ModeratorRow[]
}

type SortKey =
  | 'moderatorName'
  | 'expectedEarningsCents'
  | 'realizedEarningsCents'
  | 'bookedHours'
  | 'completedHours'
  | 'shiftCount'
  | 'brandCount'

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

export function ModeratorsDashboardView({ monthKey, rows }: ModeratorsDashboardViewProps) {
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
    return rows.reduce(
      (acc, r) => {
        acc.expected += r.expectedEarningsCents
        acc.realized += r.realizedEarningsCents
        acc.booked += r.bookedHours
        acc.completed += r.completedHours
        acc.shifts += r.shiftCount
        acc.setup += r.setupShifts
        acc.prepBlocks += r.prepBlocks
        acc.prepCents += r.prepCents
        return acc
      },
      { expected: 0, realized: 0, booked: 0, completed: 0, shifts: 0, setup: 0, prepBlocks: 0, prepCents: 0 },
    )
  }, [rows])

  function changeMonth(delta: number) {
    const next = shiftMonth(monthKey, delta)
    router.push(`/admin/payroll/moderators?month=${next}`)
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'moderatorName' ? 'asc' : 'desc')
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
          <h1 className="text-2xl font-bold text-foreground">Payroll</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Earnings and hours by moderator</p>
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

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <PayrollTabs active="moderators" monthKey={monthKey} />
        <PayrollExportButton />
      </div>

      {/* Summary tiles. Prep pay is its own subtotal tile once any new-rule
          prep blocks exist this month; it is already included in Expected /
          Realized (separate line item, inclusive totals). */}
      <div
        className={
          totals.prepBlocks > 0
            ? 'grid grid-cols-2 md:grid-cols-6 gap-3'
            : 'grid grid-cols-2 md:grid-cols-5 gap-3'
        }
      >
        <StatTile label="Expected earnings" value={fmtDollars(totals.expected)} highlight />
        <StatTile label="Realized earnings" value={fmtDollars(totals.realized)} subdued />
        {totals.prepBlocks > 0 && (
          <StatTile
            label="Prep pay"
            value={fmtDollars(totals.prepCents)}
            sub={`${totals.prepBlocks} block${totals.prepBlocks === 1 ? '' : 's'} · included in totals`}
          />
        )}
        <StatTile label="Booked hours" value={fmtHours(totals.booked)} />
        <StatTile label="Completed hours" value={fmtHours(totals.completed)} subdued />
        <StatTile
          label="Total shifts"
          value={totals.setup > 0 ? `${totals.shifts.toLocaleString()} · ${totals.setup} setup` : totals.shifts.toLocaleString()}
        />
      </div>

      {/* Moderator grid */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="hidden md:grid grid-cols-[1.6fr_0.9fr_1.1fr_1.1fr_1fr_1fr_0.8fr_0.8fr] items-center gap-4 px-4 py-2.5 border-b border-border bg-secondary/40">
          <SortHeader k="moderatorName" label="Moderator" align="left" />
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Rate</div>
          <SortHeader k="expectedEarningsCents" label="Expected" />
          <SortHeader k="realizedEarningsCents" label="Realized" />
          <SortHeader k="bookedHours" label="Booked" />
          <SortHeader k="completedHours" label="Completed" />
          <SortHeader k="shiftCount" label="Shifts" />
          <SortHeader k="brandCount" label="Brands" />
        </div>

        {sorted.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No moderated shifts this month.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map(r => (
              <li key={r.moderatorId}>
                <Link
                  href={`/admin/payroll/moderators/${r.moderatorId}?month=${monthKey}`}
                  className="grid grid-cols-2 md:grid-cols-[1.6fr_0.9fr_1.1fr_1.1fr_1fr_1fr_0.8fr_0.8fr] items-center gap-4 px-4 py-3 hover:bg-secondary/40 transition-colors"
                >
                  <div className="col-span-2 md:col-span-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{r.moderatorName}</p>
                  </div>
                  <Cell label="Rate" value={fmtRatePerHour(r.rateCents)} subdued />
                  <Cell label="Expected" value={fmtDollars(r.expectedEarningsCents)} highlight />
                  <Cell label="Realized" value={fmtDollars(r.realizedEarningsCents)} subdued />
                  <Cell label="Booked" value={fmtHours(r.bookedHours)} />
                  <Cell label="Completed" value={fmtHours(r.completedHours)} subdued />
                  <Cell
                    label="Shifts"
                    value={[
                      r.shiftCount.toLocaleString(),
                      r.setupShifts > 0 ? `${r.setupShifts} setup` : null,
                      r.prepBlocks > 0 ? `${r.prepBlocks} prep` : null,
                    ].filter(Boolean).join(' · ')}
                  />
                  <Cell label="Brands" value={r.brandCount.toLocaleString()} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function StatTile({
  label,
  value,
  highlight,
  subdued,
  sub,
}: {
  label: string
  value: string
  highlight?: boolean
  subdued?: boolean
  sub?: string
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
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

function Cell({
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
    <div className="md:text-right">
      <p className="md:hidden text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p
        className={
          'text-sm font-medium tabular-nums ' +
          (highlight
            ? 'text-primary font-semibold'
            : subdued
              ? 'text-muted-foreground'
              : 'text-foreground')
        }
      >
        {value}
      </p>
    </div>
  )
}
