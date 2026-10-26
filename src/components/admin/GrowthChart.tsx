'use client'

import { useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

// Split out of DashboardView so that recharts — by far the heaviest dependency
// on the admin dashboard — is no longer part of that route's initial
// JavaScript. It backs a single card near the bottom of the page, which the
// admin may never scroll to, yet every dashboard load was paying to download
// and parse the whole charting library before first paint.
//
// DashboardView now pulls this in via next/dynamic with ssr:false, so it
// arrives only once the card actually renders.
//
// TrendPoint lives here rather than in DashboardView because it describes this
// chart's input. DashboardView re-exports it (`export type`, erased at compile
// time, so the re-export does NOT drag recharts back into the parent bundle)
// to keep the admin dashboard page's existing import working unchanged.

export interface TrendPoint {
  /** Bucket key: "YYYY-MM" for monthly, "YYYY-MM-DD" (Monday) for weekly. */
  bucketKey: string
  /** Short display label, e.g. "May '25" or "May 5". */
  label: string
  revenueCents: number
  profitCents: number
}

/** Custom tooltip — defaults are too noisy. Shows month + both series with
 *  formatted dollar values. */
type TooltipProps = {
  active?: boolean
  label?: string | number
  payload?: Array<{ dataKey: string; name: string; value: number; color: string }>
}
function GrowthTooltip({ active, label, payload }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 shadow-md text-xs">
      <p className="font-semibold text-foreground mb-1">{label}</p>
      {payload.map(p => (
        <p key={p.dataKey} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: p.color }}
          />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold text-foreground tabular-nums">
            {/* p.value is already in dollars (the chart data converts
                cents → dollars at the boundary). Format directly — do NOT
                call fmtDollars(), which expects cents and would divide
                by 100 a second time. */}
            {`${p.value < 0 ? '-' : ''}$${Math.abs(p.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          </span>
        </p>
      ))}
    </div>
  )
}

/** Granularity → ordered span options. The "best" position is the default. */
const SPAN_OPTIONS: Record<'weekly' | 'monthly', number[]> = {
  weekly:  [4, 8, 12, 26, 52],
  monthly: [3, 6, 12, 24],
}
const DEFAULT_SPAN: Record<'weekly' | 'monthly', number> = {
  weekly: 12,
  monthly: 12,
}

export function GrowthChart({
  weeklyTrend,
  monthlyTrend,
}: {
  weeklyTrend: TrendPoint[]
  monthlyTrend: TrendPoint[]
}) {
  const [granularity, setGranularity] = useState<'weekly' | 'monthly'>('monthly')
  const [span, setSpan] = useState<number>(DEFAULT_SPAN.monthly)

  // When the admin flips granularity, reset span to that granularity's default
  // (12 weeks vs 12 months) so the chart always lands on a sensible view
  // instead of carrying over a weeks-count that's nonsensical as months.
  function handleGranularityChange(g: 'weekly' | 'monthly') {
    setGranularity(g)
    setSpan(DEFAULT_SPAN[g])
  }

  // Slice the appropriate series to the chosen span (last N points).
  const sourcePoints = granularity === 'weekly' ? weeklyTrend : monthlyTrend
  const visiblePoints = sourcePoints.slice(-span)
  const spanOptions = SPAN_OPTIONS[granularity]
  const unitLabel = granularity === 'weekly' ? 'weeks' : 'months'

  // recharts wants plain numbers, so convert cents → dollars at the boundary.
  const data = visiblePoints.map(p => ({
    label: p.label,
    Revenue: p.revenueCents / 100,
    Profit: p.profitCents / 100,
  }))

  return (
    <section className="bg-card border border-border rounded-lg p-4 md:p-6">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {granularity === 'weekly' ? 'Week-over-week' : 'Month-over-month'} growth
          </h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Realized revenue and profit across all brands. Current {granularity === 'weekly' ? 'week' : 'month'} is in progress — its value reflects only shifts that have already happened.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Granularity segmented toggle */}
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => handleGranularityChange('weekly')}
              className={
                'px-3 py-1.5 text-xs font-medium transition-colors ' +
                (granularity === 'weekly'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-foreground hover:bg-secondary')
              }
            >
              Weekly
            </button>
            <button
              type="button"
              onClick={() => handleGranularityChange('monthly')}
              className={
                'px-3 py-1.5 text-xs font-medium transition-colors border-l border-border ' +
                (granularity === 'monthly'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-foreground hover:bg-secondary')
              }
            >
              Monthly
            </button>
          </div>
          {/* Span select — options change with granularity */}
          <label className="text-xs text-muted-foreground flex items-center gap-1.5">
            Span
            <select
              value={span}
              onChange={e => setSpan(Number(e.target.value))}
              className="bg-background border border-border rounded-md px-2 py-1 text-xs font-medium text-foreground"
            >
              {spanOptions.map(n => (
                <option key={n} value={n}>
                  {n} {unitLabel}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="h-64 md:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 88%)" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'hsl(0 0% 35%)' }}
              tickLine={false}
              axisLine={{ stroke: 'hsl(0 0% 88%)' }}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'hsl(0 0% 35%)' }}
              tickLine={false}
              axisLine={{ stroke: 'hsl(0 0% 88%)' }}
              tickFormatter={v => {
                // Signs render outside the $ so negatives read as "-$1k"
                // rather than the ugly "$-1k".
                const sign = v < 0 ? '-' : ''
                const abs = Math.abs(v)
                return abs >= 1000 ? `${sign}$${Math.round(abs / 1000)}k` : `${sign}$${abs}`
              }}
              width={56}
            />
            <Tooltip content={<GrowthTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
              iconType="circle"
            />
            <Line
              type="monotone"
              dataKey="Revenue"
              stroke="hsl(5 100% 60%)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="Profit"
              stroke="hsl(160 64% 40%)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
