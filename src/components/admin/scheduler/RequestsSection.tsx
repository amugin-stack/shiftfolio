'use client'

import { Badge } from '@/components/ui/badge'
import { OFFER_STATE_LABEL, REQUEST_STATUS_LABEL, shiftLabelPT } from './schedulerShared'

export interface OfferRow {
  workerName: string
  state: string
}

export interface RequestRow {
  id: string
  brandName: string
  role: 'host' | 'moderator'
  runStart: string
  runEnd: string
  status: string
  offers: OfferRow[]
}

export function RequestsSection({ rows }: { rows: RequestRow[] }) {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="font-semibold">Open &amp; escalated requests</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open coverage requests right now.</p>
      ) : (
        <div className="space-y-3">
          {rows.map(r => (
            <div key={r.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{r.brandName} <span className="text-muted-foreground text-sm capitalize">({r.role})</span></p>
                  <p className="text-sm text-muted-foreground">{shiftLabelPT(r.runStart, r.runEnd)}</p>
                </div>
                <Badge variant={r.status === 'escalated' ? 'destructive' : 'secondary'}>
                  {REQUEST_STATUS_LABEL[r.status] ?? r.status}
                </Badge>
              </div>
              {r.offers.length > 0 && (
                <ul className="mt-2 text-sm space-y-1">
                  {r.offers.map((o, i) => (
                    <li key={i} className="flex items-center justify-between text-muted-foreground">
                      <span>{o.workerName}</span>
                      <span>{OFFER_STATE_LABEL[o.state] ?? o.state}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
