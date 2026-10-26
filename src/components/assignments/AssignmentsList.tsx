'use client'

import { useState } from 'react'
import { Mic, Megaphone } from 'lucide-react'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { formatPT } from '@/lib/utils'
import { AssignmentDetailDialog } from './AssignmentDetailDialog'
import type { AssignmentRow } from '@/app/(dashboard)/assignments/page'

interface AssignmentsListProps {
  upcoming: AssignmentRow[]
  past: AssignmentRow[]
}

export function AssignmentsList({ upcoming, past }: AssignmentsListProps) {
  const [activeRow, setActiveRow] = useState<AssignmentRow | null>(null)

  return (
    <>
      <Section title={`Upcoming (${upcoming.length})`} rows={upcoming} onSelect={setActiveRow} />
      {past.length > 0 && (
        <Section title={`Past (${past.length})`} rows={past} dim onSelect={setActiveRow} />
      )}

      <AssignmentDetailDialog
        row={activeRow}
        open={!!activeRow}
        onOpenChange={open => { if (!open) setActiveRow(null) }}
      />
    </>
  )
}

function Section({
  title,
  rows,
  dim,
  onSelect,
}: {
  title: string
  rows: AssignmentRow[]
  dim?: boolean
  onSelect: (row: AssignmentRow) => void
}) {
  if (rows.length === 0) return null
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <ul className="bg-card border border-border rounded-lg overflow-hidden divide-y divide-border">
        {rows.map(r => {
          const Icon = r.role === 'producer' ? Mic : Megaphone
          return (
            <li key={`${r.id}:${r.role}`} className={dim ? 'opacity-70' : ''}>
              <button
                type="button"
                onClick={() => onSelect(r)}
                className="w-full text-left flex items-center gap-3 p-3 hover:bg-secondary/40 transition-colors focus:outline-none focus-visible:bg-secondary/40"
              >
                <BrandLogo name={r.brand.name} logoPath={r.brand.logo_path} size="md" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{r.brand.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatPT(r.startISO, 'EEE, MMM d')} · {formatPT(r.startISO, 'h:mm a')} – {formatPT(r.endISO, 'h:mm a')}
                    {r.hostName && <> · Host: <span className="text-foreground">{r.hostName}</span></>}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/15 text-primary">
                  <Icon className="w-3 h-3" />
                  {r.role}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
