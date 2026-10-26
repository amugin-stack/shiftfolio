'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { toE164US } from '@/lib/phone'
import type { SchedulerRuntime, BrandPublic } from '@/lib/supabase/types'

interface Props {
  runtime: SchedulerRuntime
  brands: BrandPublic[]
  onSaved: (next: SchedulerRuntime) => void
}

// Mirrors the CHECK constraints on scheduler_runtime (migration 089). UI
// validation only — these ranges are the real boundary at the DB, so a value
// that slips past this and reaches the server still gets rejected there.
const RANGES = {
  lookahead_days: [1, 60],
  expiry_same_day_minutes: [5, 240],
  expiry_soon_minutes: [5, 1440],
  expiry_later_minutes: [5, 2880],
  escalate_before_minutes: [0, 1440],
  quiet_start_hour: [0, 23],
  quiet_end_hour: [0, 23],
  daily_send_cap: [0, 5000],
} as const

type NumericField = keyof typeof RANGES

function fieldLabel(field: NumericField): string {
  return {
    lookahead_days: 'Lookahead (days)',
    expiry_same_day_minutes: 'Expiry — same day (min)',
    expiry_soon_minutes: 'Expiry — within 48h (min)',
    expiry_later_minutes: 'Expiry — later (min)',
    escalate_before_minutes: 'Escalate before start (min)',
    quiet_start_hour: 'Quiet hours start (PT, 0–23)',
    quiet_end_hour: 'Quiet hours end (PT, 0–23)',
    daily_send_cap: 'Daily text cap',
  }[field]
}

export function SchedulerSettingsCard({ runtime, brands, onSaved }: Props) {
  const [form, setForm] = useState(runtime)
  const [phoneInput, setPhoneInput] = useState(runtime.escalation_phone_e164 ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDryRunOff, setConfirmDryRunOff] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()

  const allowlistSet = useMemo(() => new Set(form.brand_allowlist ?? []), [form.brand_allowlist])

  function setNumber(field: NumericField, value: string) {
    const n = Number.parseInt(value, 10)
    setForm(f => ({ ...f, [field]: Number.isFinite(n) ? n : f[field] }))
  }

  function toggleBrand(brandId: string) {
    setForm(f => {
      const next = new Set(f.brand_allowlist ?? [])
      if (next.has(brandId)) next.delete(brandId)
      else next.add(brandId)
      return { ...f, brand_allowlist: next.size === 0 ? null : Array.from(next) }
    })
  }

  function validate(): string | null {
    for (const field of Object.keys(RANGES) as NumericField[]) {
      const [min, max] = RANGES[field]
      const v = form[field]
      if (!Number.isInteger(v) || v < min || v > max) {
        return `${fieldLabel(field)} must be between ${min} and ${max}.`
      }
    }
    if (form.expiry_same_day_minutes > form.expiry_soon_minutes
      || form.expiry_soon_minutes > form.expiry_later_minutes) {
      return 'Expiry windows should increase from same-day to soon to later.'
    }
    if (phoneInput.trim() && !toE164US(phoneInput)) {
      return 'Escalation phone must be a valid US number, e.g. (310) 555-0101.'
    }
    return null
  }

  async function doSave() {
    const escalation_phone_e164 = phoneInput.trim() ? toE164US(phoneInput) : null
    setSaving(true)
    setError('')
    try {
      const { data, error } = await supabase
        .from('scheduler_runtime')
        .update({
          enabled: form.enabled,
          dry_run: form.dry_run,
          lookahead_days: form.lookahead_days,
          expiry_same_day_minutes: form.expiry_same_day_minutes,
          expiry_soon_minutes: form.expiry_soon_minutes,
          expiry_later_minutes: form.expiry_later_minutes,
          escalate_before_minutes: form.escalate_before_minutes,
          quiet_start_hour: form.quiet_start_hour,
          quiet_end_hour: form.quiet_end_hour,
          daily_send_cap: form.daily_send_cap,
          escalation_phone_e164,
          brand_allowlist: form.brand_allowlist,
        })
        .eq('singleton', true)
        .select('*')
        .single()
      if (error) throw new Error(error.message)
      const row = data as SchedulerRuntime
      setForm(row)
      setPhoneInput(row.escalation_phone_e164 ?? '')
      onSaved(row)
      toast({ title: 'Scheduler settings saved' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save settings.')
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    const v = validate()
    if (v) { setError(v); return }
    setError('')
    // Turning dry-run OFF starts texting real people — confirm explicitly
    // rather than let a settings-page slip send live SMS.
    if (runtime.dry_run && !form.dry_run) {
      setConfirmDryRunOff(true)
      return
    }
    await doSave()
  }

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div>
        <h2 className="font-semibold">Status &amp; settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Controls the bot everywhere at once. Changes here take effect on its next tick.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
            className="w-3.5 h-3.5 mt-1 accent-primary"
          />
          <span>
            <span className="text-sm text-foreground font-medium">Enabled</span>
            <span className="block text-[11px] text-muted-foreground">Kill switch. Off means the bot does nothing at all.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.dry_run}
            onChange={e => setForm(f => ({ ...f, dry_run: e.target.checked }))}
            className="w-3.5 h-3.5 mt-1 accent-primary"
          />
          <span>
            <span className="text-sm text-foreground font-medium">Dry run</span>
            <span className="block text-[11px] text-muted-foreground">
              While on, offers and texts are logged but never sent to a real phone.
            </span>
          </span>
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(RANGES) as NumericField[]).map(field => (
          <div key={field} className="space-y-1.5">
            <Label htmlFor={`sched-${field}`}>{fieldLabel(field)}</Label>
            <Input
              id={`sched-${field}`}
              type="number"
              min={RANGES[field][0]}
              max={RANGES[field][1]}
              value={form[field]}
              onChange={e => setNumber(field, e.target.value)}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="sched-escalation-phone">Escalation phone</Label>
          <Input
            id="sched-escalation-phone"
            type="tel"
            placeholder="(310) 555-0101"
            value={phoneInput}
            onChange={e => setPhoneInput(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">Texted when a shift can&apos;t be filled. Blank = no escalation texts.</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Brand pilot allowlist</Label>
          {brands.length > 0 && (
            <button type="button" className="text-[11px] text-muted-foreground hover:underline"
              onClick={() => setForm(f => ({ ...f, brand_allowlist: null }))}>
              Clear (all brands)
            </button>
          )}
        </div>
        {brands.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No brands exist yet.</p>
        ) : (
          <div className="border border-border rounded-md max-h-40 overflow-y-auto divide-y divide-border">
            {brands.map(b => (
              <label key={b.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-secondary/50">
                <input
                  type="checkbox"
                  checked={allowlistSet.has(b.id)}
                  onChange={() => toggleBrand(b.id)}
                  className="w-3.5 h-3.5 accent-primary"
                />
                <span className="text-sm text-foreground">{b.name}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          {form.brand_allowlist === null ? 'Empty — the bot runs on all brands.' : `${form.brand_allowlist.length} brand${form.brand_allowlist.length === 1 ? '' : 's'} selected — the bot runs on only these.`}
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>

      <AlertDialog open={confirmDryRunOff} onOpenChange={setConfirmDryRunOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off dry run?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot will text real people. Every offer and escalation from now on sends an
              actual SMS instead of just being logged. Make sure the pools, contacts, and
              settings above are ready first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setForm(f => ({ ...f, dry_run: true }))}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { setConfirmDryRunOff(false); await doSave() }}>
              Yes, start texting real people
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
