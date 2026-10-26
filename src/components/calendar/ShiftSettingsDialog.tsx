'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Brand } from '@/lib/supabase/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/hooks/use-toast'
import { minutesToInputTime, timeStringToMinutes, minutesToLabel } from '@/lib/utils'

interface ShiftSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  brand: Pick<
    Brand,
    'id' | 'name' | 'block_size_minutes' | 'day_start_minutes' | 'day_end_minutes'
  >
}

export function ShiftSettingsDialog({ open, onOpenChange, brand }: ShiftSettingsDialogProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [blockSize, setBlockSize] = useState(brand.block_size_minutes)
  const [dayStart, setDayStart]   = useState(minutesToInputTime(brand.day_start_minutes))
  const [dayEnd, setDayEnd]       = useState(minutesToInputTime(brand.day_end_minutes >= 1440 ? 0 : brand.day_end_minutes))
  const [endsAtMidnight, setEndsAtMidnight] = useState(brand.day_end_minutes >= 1440)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setBlockSize(brand.block_size_minutes)
    setDayStart(minutesToInputTime(brand.day_start_minutes))
    setEndsAtMidnight(brand.day_end_minutes >= 1440)
    setDayEnd(minutesToInputTime(brand.day_end_minutes >= 1440 ? 0 : brand.day_end_minutes))
    setError(null)
  }, [open, brand])

  const startMins = timeStringToMinutes(dayStart)
  const endMins   = endsAtMidnight ? 1440 : timeStringToMinutes(dayEnd)
  const windowMins = endMins - startMins
  const blockCount = blockSize > 0 ? Math.floor(windowMins / blockSize) : 0
  const evenDivision = blockSize > 0 && windowMins > 0 && windowMins % blockSize === 0

  async function handleSave() {
    setError(null)
    if (blockSize < 15 || blockSize > 1440) {
      setError('Block size must be between 15 and 1440 minutes.')
      return
    }
    if (endMins <= startMins) {
      setError('End time must be after start time.')
      return
    }
    if (!evenDivision) {
      setError(`Day window (${windowMins} min) is not evenly divisible by block size (${blockSize} min).`)
      return
    }

    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('brands')
      .update({
        block_size_minutes: blockSize,
        day_start_minutes:  startMins,
        day_end_minutes:    endMins,
      })
      .eq('id', brand.id)

    setSaving(false)

    if (error) {
      setError(error.message)
      return
    }

    toast({ title: 'Shift settings saved' })
    onOpenChange(false)
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Shift Settings — {brand.name}</DialogTitle>
          <DialogDescription>
            Configure how the day is divided into shift blocks. Use <strong>Edit Rates</strong> on the calendar to set per-shift hourly rates.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="shift-block-size">Block size (minutes)</Label>
            <Input
              id="shift-block-size"
              type="number"
              inputMode="numeric"
              min={15}
              max={1440}
              step={15}
              value={blockSize}
              onChange={e => setBlockSize(parseInt(e.target.value || '0', 10))}
            />
            <p className="text-[11px] text-muted-foreground">
              Common: 60, 90, 120, 180. Must divide the day window evenly.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="shift-day-start">Day starts</Label>
              <Input
                id="shift-day-start"
                type="time"
                value={dayStart}
                onChange={e => setDayStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-day-end">Day ends</Label>
              <Input
                id="shift-day-end"
                type="time"
                value={dayEnd}
                disabled={endsAtMidnight}
                onChange={e => setDayEnd(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={endsAtMidnight}
              onChange={e => setEndsAtMidnight(e.target.checked)}
              className="w-3.5 h-3.5 accent-primary"
            />
            Day ends at midnight (12:00 AM)
          </label>

          <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
            <p className="font-medium text-foreground mb-1">
              {evenDivision && blockCount > 0
                ? `${blockCount} shift block${blockCount === 1 ? '' : 's'} per day`
                : 'Invalid configuration'}
            </p>
            <p className="text-muted-foreground">
              {minutesToLabel(startMins)} – {minutesToLabel(endMins)} · {blockSize} min each
            </p>
          </div>

          {error && (
            <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !evenDivision}>
            {saving ? 'Saving…' : 'Save Settings'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
