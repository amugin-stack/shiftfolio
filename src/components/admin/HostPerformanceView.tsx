'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ChevronLeft, ChevronRight, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatCents } from '@/lib/utils'
import { MIN_SESSIONS_FOR_STATS, type TimeBlock } from '@/lib/performanceStats'

export type PerfTab = 'hosts' | 'moderators' | 'pairings'

/** One row of the table, whatever it is grouped by. `key` is a host id on the
 *  Hosts tab, a moderator id on Moderators, and "hostId|moderatorId" on
 *  Pairings — so the same table renders all three. */
export interface HostPerfRow {
  key: string
  label: string
  /** Set only where a detail page exists to link to (Hosts). */
  href?: string
  /** GMV reported across this group's sessions in the selected window. */
  monthGmvCents: number
  /** GMV in the current PT week (Mon–Sun), regardless of the window. */
  weekGmvCents: number
  /** Window GMV ÷ reported hours. Null when nothing has been reported. */
  gmvPerHourCents: number | null
  sessionsWithGmv: number
  totalSessions: number
}

const TABS: { id: PerfTab; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'moderators', label: 'Moderators' },
  { id: 'pairings', label: 'Host + Mod' },
]

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const BLOCKS: { id: TimeBlock; label: string }[] = [
  { id: 'morning', label: 'Morning' },
  { id: 'afternoon', label: 'Afternoon' },
  { id: 'evening', label: 'Evening' },
]

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

function gmvPerHourLabel(cents: number | null): string {
  return cents == null ? '—' : `${formatCents(cents)}/hr`
}

export function HostPerformanceView({
  monthKey,
  tab,
  rows,
  weekTotalCents,
  monthTotalCents,
  fromKey,
  toKey,
  isCustomRange,
  dow,
  block,
}: {
  monthKey: string
  tab: PerfTab
  rows: HostPerfRow[]
  weekTotalCents: number
  monthTotalCents: number
  fromKey?: string
  toKey?: string
  isCustomRange: boolean
  dow: number | null
  block: TimeBlock | null
}) {
  const router = useRouter()
  const [from, setFrom] = useState(fromKey ?? '')
  const [to, setTo] = useState(toKey ?? '')

  /** Rebuild the URL keeping every other control's state. */
  function go(overrides: Record<string, string | null>) {
    const params = new URLSearchParams()
    const base: Record<string, string | null> = {
      tab: tab === 'hosts' ? null : tab,
      dow: dow == null ? null : String(dow),
      block: block ?? null,
      ...(isCustomRange ? { from: fromKey ?? null, to: toKey ?? null } : { month: monthKey }),
      ...overrides,
    }
    for (const [k, v] of Object.entries(base)) if (v) params.set(k, v)
    router.push(`/admin/performance?${params.toString()}`)
  }

  function changeMonth(delta: number) {
    // Stepping months always leaves a custom range — the two are alternatives,
    // and silently keeping a stale from/to would make the arrows do nothing.
    go({ month: shiftMonth(monthKey, delta), from: null, to: null })
  }

  const rangeLabel = isCustomRange && fromKey && toKey
    ? `${fromKey} → ${toKey}`
    : formatMonthLabel(monthKey)

  const filtered = dow != null || block != null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Performance</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            GMV by host, moderator, and pairing
          </p>
        </div>
        {!isCustomRange && (
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
        )}
      </div>

      {/* Tabs */}
      <div className="inline-flex items-center gap-1 p-1 bg-card border border-border rounded-md">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => go({ tab: t.id === 'hosts' ? null : t.id })}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              tab === t.id
                ? 'bg-primary text-primary-foreground font-semibold'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters + custom range */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1">
            <Label htmlFor="perf-from" className="text-xs">From</Label>
            <Input id="perf-from" type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="perf-to" className="text-xs">To</Label>
            <Input id="perf-to" type="date" value={to} onChange={e => setTo(e.target.value)} className="h-9" />
          </div>
          <Button
            variant="outline"
            className="h-9"
            disabled={!from || !to || from > to}
            onClick={() => go({ from, to, month: null })}
          >
            Apply range
          </Button>
          {isCustomRange && (
            <Button variant="ghost" className="h-9" onClick={() => go({ from: null, to: null, month: monthKey })}>
              Back to months
            </Button>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <select
            aria-label="Day of week"
            value={dow == null ? '' : String(dow)}
            onChange={e => go({ dow: e.target.value || null })}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">Any day</option>
            {DAYS.map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
          </select>

          <div className="inline-flex items-center gap-1 p-1 border border-border rounded-md">
            <button
              type="button"
              onClick={() => go({ block: null })}
              className={`px-2.5 py-1 text-xs rounded ${block == null ? 'bg-secondary font-semibold' : 'text-muted-foreground'}`}
            >
              Any time
            </button>
            {BLOCKS.map(b => (
              <button
                key={b.id}
                type="button"
                onClick={() => go({ block: b.id })}
                className={`px-2.5 py-1 text-xs rounded ${block === b.id ? 'bg-secondary font-semibold' : 'text-muted-foreground'}`}
              >
                {b.label}
              </button>
            ))}
          </div>

          {filtered && (
            <Button variant="ghost" className="h-9 text-xs" onClick={() => go({ dow: null, block: null })}>
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {/* Summary tiles. Deliberately NOT filtered — they are the period's whole
          totals, so there is always a way to see the full picture next to a
          filtered table. The hint says so rather than leaving it ambiguous. */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="GMV this week" value={formatCents(weekTotalCents)} hint="Current PT week, all hosts" />
        <StatTile
          label={`GMV · ${rangeLabel}`}
          value={formatCents(monthTotalCents)}
          hint={filtered ? 'All hosts — not affected by the filters below' : 'All hosts'}
          highlight
        />
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="hidden md:grid grid-cols-[2fr_1fr_1.1fr_1.1fr] items-center gap-4 px-4 py-2.5 border-b border-border bg-secondary/40">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {tab === 'hosts' ? 'Host' : tab === 'moderators' ? 'Moderator' : 'Host + Moderator'}
          </p>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">Sessions</p>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">GMV</p>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider text-right">GMV / hr</p>
        </div>

        {rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {filtered ? 'No sessions match these filters.' : 'No sessions in this period.'}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(r => {
              const inner = (
                <>
                  <div className="col-span-2 md:col-span-1 flex items-center gap-2.5 min-w-0">
                    <TrendingUp className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-sm font-semibold text-foreground truncate">{r.label}</span>
                    {/* Thin samples are marked rather than hidden: the row's GMV
                        is real, but nothing derived from it should be trusted
                        yet. Same threshold the stats module gates on. */}
                    {r.sessionsWithGmv > 0 && r.sessionsWithGmv < MIN_SESSIONS_FOR_STATS && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        thin data
                      </span>
                    )}
                  </div>
                  <Cell label="Sessions" value={`${r.sessionsWithGmv}/${r.totalSessions}`} />
                  <Cell label="GMV" value={formatCents(r.monthGmvCents)} highlight />
                  <Cell label="GMV / hr" value={gmvPerHourLabel(r.gmvPerHourCents)} />
                </>
              )
              const cls =
                'grid grid-cols-2 md:grid-cols-[2fr_1fr_1.1fr_1.1fr] items-center gap-4 px-4 py-3'
              return (
                <li key={r.key}>
                  {r.href ? (
                    <Link href={r.href} className={`${cls} hover:bg-secondary/40 transition-colors`}>
                      {inner}
                    </Link>
                  ) : (
                    <div className={cls}>{inner}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Said once, plainly, where the pairing numbers are read. This view can
          rank people, and with a handful of sessions per pairing the ordering is
          mostly noise. Brand, time slot and product mix move GMV as much as
          people do, and none of them are held constant here. */}
      {tab === 'pairings' && rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Pairings show what happened, not who caused it — brand, time slot and product mix
          move GMV as much as people do. Rows marked “thin data” have fewer than{' '}
          {MIN_SESSIONS_FOR_STATS} reported sessions; treat their ordering as noise.
        </p>
      )}
    </div>
  )
}

function StatTile({ label, value, hint, highlight }: { label: string; value: string; hint: string; highlight?: boolean }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={'mt-1 text-2xl font-bold ' + (highlight ? 'text-primary' : 'text-foreground')}>{value}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>
    </div>
  )
}

function Cell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="md:text-right">
      <p className="md:hidden text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={'text-sm font-medium tabular-nums ' + (highlight ? 'text-primary' : 'text-foreground')}>{value}</p>
    </div>
  )
}
