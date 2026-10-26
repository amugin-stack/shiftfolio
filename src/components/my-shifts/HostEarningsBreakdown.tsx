'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatCents } from '@/lib/utils'
import {
  formatPayPeriodLabel,
  payPeriodStartKeyForShift,
  resolvePayPeriod,
  shiftPayPeriodKey,
} from '@/lib/payPeriod'
import type { ShiftRow } from './MyShiftsList'

interface HostEarningsBreakdownProps {
  shifts: ShiftRow[]
  /** Start date of the selected pay period, YYYY-MM-DD. Driven by the
   *  `?period=` URL searchParam so a period can be deep-linked. */
  periodKey: string
  /** Start date of the period happening right now, for the "Current" badge. */
  currentPeriodKey: string
}

type SortKey = 'brandName' | 'shifts' | 'hoursWorked' | 'realizedCents' | 'expectedCents'

function fmtHours(hours: number): string {
  return `${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })} hr`
}

function durationHours(startISO: string, endISO: string): number {
  return (new Date(endISO).getTime() - new Date(startISO).getTime()) / 3_600_000
}

interface BrandTotals {
  brandId: string
  brandName: string
  shifts: number
  hoursWorked: number      // hours from past shifts only
  hoursBooked: number      // hours from all shifts in month (past + future)
  realizedCents: number    // earnings from past shifts only
  expectedCents: number    // total earnings if all booked shifts complete
}

export function HostEarningsBreakdown({
  shifts,
  periodKey,
  currentPeriodKey,
}: HostEarningsBreakdownProps) {
  const router = useRouter()
  const [sortKey, setSortKey] = useState<SortKey>('expectedCents')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const period = useMemo(() => resolvePayPeriod(periodKey), [periodKey])
  const periodLabel = formatPayPeriodLabel(period)
  const isCurrent = periodKey === currentPeriodKey

  // Filter to the selected pay period, then aggregate. Bucketed by the shift's
  // END, which is what payroll pays on — see payPeriodStartKeyForShift.
  const periodShifts = useMemo(
    () => shifts.filter(s => payPeriodStartKeyForShift(s.endISO) === periodKey),
    [shifts, periodKey],
  )

  const totals = useMemo(() => {
    let realizedCents = 0
    let expectedCents = 0
    let hoursWorked = 0
    let hoursBooked = 0
    let shiftsWorked = 0
    let prepExpectedCents = 0
    let prepRealizedCents = 0
    let prepBlocks = 0
    // Setup HOURS, which is what moderators actually ask about. Summed from
    // each block's own length rather than a constant — the length changed on
    // 2026-08-24 and older sessions keep the shorter block.
    let prepExpectedMinutes = 0
    let prepRealizedMinutes = 0
    for (const s of periodShifts) {
      const hours = durationHours(s.startISO, s.endISO)
      const prep = s.prepCents ?? 0
      if (s.prepCents !== undefined) {
        prepBlocks += 1
        prepExpectedMinutes += s.prepMinutes ?? 0
      }
      hoursBooked += hours
      expectedCents += s.totalCents
      prepExpectedCents += prep
      if (s.isPast) {
        hoursWorked += hours
        // Prep realizes on SESSION end (prepRealized), not this row's end.
        realizedCents += s.totalCents - prep
        shiftsWorked += 1
      }
      if (s.prepRealized) {
        realizedCents += prep
        prepRealizedCents += prep
        prepRealizedMinutes += s.prepMinutes ?? 0
      }
    }
    return {
      realizedCents,
      expectedCents,
      hoursWorked,
      hoursBooked,
      shiftsWorked,
      shiftsBooked: periodShifts.length,
      prepExpectedCents,
      prepRealizedCents,
      prepBlocks,
      prepExpectedHours: prepExpectedMinutes / 60,
      prepRealizedHours: prepRealizedMinutes / 60,
    }
  }, [periodShifts])

  const brandRows: BrandTotals[] = useMemo(() => {
    const byBrand = new Map<string, BrandTotals>()
    for (const s of periodShifts) {
      const hours = durationHours(s.startISO, s.endISO)
      const existing = byBrand.get(s.brandId) ?? {
        brandId: s.brandId,
        brandName: s.brandName,
        shifts: 0,
        hoursWorked: 0,
        hoursBooked: 0,
        realizedCents: 0,
        expectedCents: 0,
      }
      const prep = s.prepCents ?? 0
      existing.shifts += 1
      existing.hoursBooked += hours
      existing.expectedCents += s.totalCents
      if (s.isPast) {
        existing.hoursWorked += hours
        existing.realizedCents += s.totalCents - prep
      }
      if (s.prepRealized) existing.realizedCents += prep
      byBrand.set(s.brandId, existing)
    }
    return Array.from(byBrand.values())
  }, [periodShifts])

  const sorted = useMemo(() => {
    const copy = [...brandRows]
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
  }, [brandRows, sortKey, sortDir])

  function changePeriod(delta: number) {
    router.push(`/my-shifts?period=${shiftPayPeriodKey(periodKey, delta)}`)
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
    <section className="space-y-4 mb-8">
      {/* Header: title + pay period picker */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-foreground">Pay period breakdown</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Earnings, hours and shifts for one biweekly pay period — the same two weeks your
            paycheck covers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => changePeriod(-1)} aria-label="Previous pay period">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="px-4 py-2 min-w-[210px] text-center bg-card border border-border rounded-md">
            <span className="font-semibold text-foreground">{periodLabel}</span>
            <span className="block text-[11px] text-muted-foreground">
              {isCurrent ? 'Current pay period' : 'Pay period'}
            </span>
          </div>
          <Button variant="outline" size="icon" onClick={() => changePeriod(1)} aria-label="Next pay period">
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Summary tiles. Prep pay appears as its own subtotal tile when any
          shift this period carries new-rule prep (moderators only).
          The sub-lines spell out Realized vs Expected in plain words: the
          terms are kept because every admin payroll surface uses them, but a
          worker reading their own page should not have to know the jargon to
          understand why two different numbers are both correct. */}
      <div
        className={
          totals.prepBlocks > 0
            ? 'grid grid-cols-2 md:grid-cols-6 gap-3'
            : 'grid grid-cols-2 md:grid-cols-5 gap-3'
        }
      >
        <StatTile
          label="Realized earnings"
          value={formatCents(totals.realizedCents)}
          sub="Shifts already finished"
          highlight
        />
        <StatTile
          label="Expected earnings"
          value={formatCents(totals.expectedCents)}
          sub={isCurrent ? 'If every booked shift is worked' : 'Everything booked in this period'}
          subdued
        />
        {/* Setup time, broken out because moderators kept having to ask what
            they were paid for it. Shows the HOURS as the headline — that is the
            question — with the money and the realized split underneath. */}
        {totals.prepBlocks > 0 && (
          <StatTile
            label="Setup time"
            value={fmtHours(totals.prepExpectedHours)}
            sub={`${formatCents(totals.prepExpectedCents)} · ${totals.prepBlocks} session${
              totals.prepBlocks === 1 ? '' : 's'
            } · included in totals`}
          />
        )}
        <StatTile label="Shifts worked" value={`${totals.shiftsWorked} / ${totals.shiftsBooked}`} />
        <StatTile label="Hours worked" value={fmtHours(totals.hoursWorked)} />
        <StatTile label="Hours booked" value={fmtHours(totals.hoursBooked)} subdued />
      </div>

      {/* The reconciliation line. Payroll's "Total Hours" column counts worked
          hours PLUS setup time, while "Hours worked" above is shift time only —
          so without this the two surfaces show different numbers and the
          moderator has to ask which is right. Spell out the sum instead. */}
      {totals.prepBlocks > 0 && (
        <p className="text-xs text-muted-foreground">
          Payroll counts <strong>{fmtHours(totals.hoursBooked + totals.prepExpectedHours)}</strong>{' '}
          for this period — {fmtHours(totals.hoursBooked)} on shift plus{' '}
          {fmtHours(totals.prepExpectedHours)} setup time.
        </p>
      )}

      {/* Per-brand grid */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="hidden md:grid items-center gap-4 px-4 py-2.5 border-b border-border bg-secondary/40 grid-cols-[2fr_0.8fr_1fr_1.1fr_1.1fr]">
          <SortHeader k="brandName" label="Brand" align="left" />
          <SortHeader k="shifts" label="Shifts" />
          <SortHeader k="hoursWorked" label="Hours" />
          <SortHeader k="realizedCents" label="Realized" />
          <SortHeader k="expectedCents" label="Expected" />
        </div>

        {sorted.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No shifts in {periodLabel}.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {sorted.map(r => (
              <li key={r.brandId}>
                <div className="grid grid-cols-2 md:grid-cols-[2fr_0.8fr_1fr_1.1fr_1.1fr] items-center gap-4 px-4 py-3">
                  <div className="col-span-2 md:col-span-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">{r.brandName}</p>
                  </div>
                  <Cell label="Shifts" value={r.shifts.toLocaleString()} />
                  <Cell label="Hours" value={fmtHours(r.hoursWorked)} subdued />
                  <Cell label="Realized" value={formatCents(r.realizedCents)} highlight />
                  <Cell label="Expected" value={formatCents(r.expectedCents)} subdued />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
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
          (highlight ? 'text-primary font-semibold' : subdued ? 'text-muted-foreground' : 'text-foreground')
        }
      >
        {value}
      </p>
    </div>
  )
}
