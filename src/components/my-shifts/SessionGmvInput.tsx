'use client'

import { useState } from 'react'
import { DollarSign } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatPT } from '@/lib/utils'

function centsToInput(cents: number | null): string {
  if (cents == null) return ''
  return (cents / 100).toFixed(2).replace(/\.00$/, '')
}

/** Per-session GMV entry. Writes go through the set_session_gmv RPC, which
 *  enforces ownership + "session has ended" server-side.
 *
 *  Since migration 074 the HOST or the MODERATOR of a session can save here,
 *  and they share one figure. `lastSavedByName` is what stops that being a
 *  silent overwrite: if the number changed under you, the line below says who
 *  changed it. The RPC also resolves the canonical session anchor server-side,
 *  so both people always write the same row however their shifts line up. */
export function SessionGmvInput({
  anchorId,
  initialGmvCents,
  lastSavedByName = null,
  lastSavedAtISO = null,
}: {
  anchorId: string
  initialGmvCents: number | null
  lastSavedByName?: string | null
  lastSavedAtISO?: string | null
}) {
  const [value, setValue] = useState(centsToInput(initialGmvCents))
  const [savedCents, setSavedCents] = useState<number | null>(initialGmvCents)
  const [saving, setSaving] = useState(false)
  // Cleared once the current user saves — at that point they ARE the last
  // saver, so attributing it to someone else would be wrong.
  const [showLastSaved, setShowLastSaved] = useState(true)
  const { toast } = useToast()

  // Parse the dollar input → cents (blank clears to null).
  const trimmed = value.trim()
  const parsedCents = trimmed === '' ? null : Math.round(Number(trimmed) * 100)
  const valid = trimmed === '' || (Number.isFinite(Number(trimmed)) && Number(trimmed) >= 0)
  const dirty = valid && parsedCents !== savedCents

  async function save() {
    if (!valid) {
      toast({ title: 'Enter a valid dollar amount' })
      return
    }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('set_session_gmv', {
      p_stream_id: anchorId,
      p_gmv_cents: parsedCents,
    })
    setSaving(false)
    if (error) {
      toast({ title: 'Could not save GMV', description: error.message })
      return
    }
    setSavedCents(parsedCents)
    setShowLastSaved(false)
    toast({ title: parsedCents == null ? 'GMV cleared' : 'GMV saved' })
  }

  const attribution =
    showLastSaved && lastSavedByName
      ? `Last saved by ${lastSavedByName}${lastSavedAtISO ? ` · ${formatPT(lastSavedAtISO, 'MMM d')}` : ''}`
      : null

  return (
    <div className="flex flex-col items-end gap-1">
    <div className="flex items-center gap-2">
      <div className="relative">
        <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="0"
          className="h-8 w-32 pl-7 text-sm tabular-nums"
          aria-label="Session GMV in dollars"
        />
      </div>
      <Button size="sm" className="h-8" disabled={saving || !dirty} onClick={save}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
      {attribution && (
        <p className="text-[11px] text-muted-foreground">{attribution}</p>
      )}
    </div>
  )
}
