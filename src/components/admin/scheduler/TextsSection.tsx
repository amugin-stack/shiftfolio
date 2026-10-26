'use client'

import { Badge } from '@/components/ui/badge'
import { formatPT } from '@/lib/utils'
import { maskPhone } from './schedulerShared'
import type { SmsOutboxRow } from '@/lib/supabase/types'

const STATE_LABEL: Record<string, string> = {
  queued: 'Queued',
  accepted: 'Sent',
  failed: 'Failed',
  canceled: 'Canceled',
  dry_run: 'Dry run — not sent',
}

export function TextsSection({ rows }: { rows: SmsOutboxRow[] }) {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="font-semibold">Recent texts (latest 50)</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No texts queued yet.</p>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">To</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Kind</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">State</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Created</th>
                <th className="text-left px-3 py-2 text-muted-foreground font-medium">Body</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={`border-b border-border last:border-0 align-top ${i % 2 ? 'bg-secondary/20' : ''}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{maskPhone(r.to_e164)}</td>
                  <td className="px-3 py-2 capitalize">{r.kind}</td>
                  <td className="px-3 py-2">
                    <Badge variant={r.state === 'dry_run' ? 'outline' : r.state === 'failed' ? 'destructive' : 'secondary'}>
                      {STATE_LABEL[r.state] ?? r.state}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{formatPT(r.created_at, 'M/d h:mmaaa')}</td>
                  <td className="px-3 py-2 max-w-md">{r.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
