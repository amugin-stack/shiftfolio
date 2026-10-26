'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { toE164US } from '@/lib/phone'
import type { BrandPublic } from '@/lib/supabase/types'

export interface ContactWorker {
  id: string
  name: string
  role: 'host' | 'moderator'
  isActive: boolean
  phone: string
  optInAt: string | null
  optInSource: string | null
  optedOutAt: string | null
}

interface Props {
  brands: BrandPublic[]
  moderators: { id: string; name: string; is_active: boolean }[]
  /** brand_id -> set of moderator_id already in that brand's pool. */
  initialModeratorPool: Map<string, Set<string>>
  initialContacts: ContactWorker[]
}

// --- Moderator pool: one brand at a time, mirrors HostsManager's brand
// checklist but the other direction (brand -> its moderators). ---
function ModeratorPoolEditor({ brands, moderators, initialPool }: {
  brands: BrandPublic[]
  moderators: { id: string; name: string; is_active: boolean }[]
  initialPool: Map<string, Set<string>>
}) {
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '')
  const [pool, setPool] = useState(initialPool)
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()
  const activeModerators = useMemo(
    () => moderators.filter(m => m.is_active).sort((a, b) => a.name.localeCompare(b.name)),
    [moderators],
  )
  const desired = pool.get(brandId) ?? new Set<string>()

  function toggle(modId: string) {
    setPool(prev => {
      const next = new Map(prev)
      const set = new Set(next.get(brandId) ?? [])
      if (set.has(modId)) set.delete(modId)
      else set.add(modId)
      next.set(brandId, set)
      return next
    })
  }

  async function save() {
    if (!brandId) return
    setSaving(true)
    try {
      const current = initialPool.get(brandId) ?? new Set<string>()
      const want = pool.get(brandId) ?? new Set<string>()
      const toAdd = Array.from(want).filter(m => !current.has(m))
      const toRemove = Array.from(current).filter(m => !want.has(m))
      if (toAdd.length > 0) {
        const { error } = await supabase.from('brand_moderators')
          .insert(toAdd.map(moderator_id => ({ brand_id: brandId, moderator_id })))
        if (error) throw new Error(error.message)
      }
      if (toRemove.length > 0) {
        const { error } = await supabase.from('brand_moderators')
          .delete().eq('brand_id', brandId).in('moderator_id', toRemove)
        if (error) throw new Error(error.message)
      }
      initialPool.set(brandId, new Set(want))
      toast({ title: 'Moderator pool saved' })
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unable to save.', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="font-medium text-sm">Moderator pool per brand</h3>
      <div className="max-w-xs space-y-1.5">
        <Label htmlFor="pool-brand">Brand</Label>
        <Select value={brandId} onValueChange={setBrandId}>
          <SelectTrigger id="pool-brand"><SelectValue placeholder="Choose a brand" /></SelectTrigger>
          <SelectContent>
            {brands.map(b => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {brandId && (
        <>
          {activeModerators.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No active moderators yet.</p>
          ) : (
            <div className="border border-border rounded-md max-h-48 overflow-y-auto divide-y divide-border">
              {activeModerators.map(m => (
                <label key={m.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-secondary/50">
                  <input
                    type="checkbox"
                    checked={desired.has(m.id)}
                    onChange={() => toggle(m.id)}
                    className="w-3.5 h-3.5 accent-primary"
                  />
                  <span className="text-sm text-foreground">{m.name}</span>
                </label>
              ))}
            </div>
          )}
          <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save pool'}</Button>
        </>
      )}
    </div>
  )
}

// --- SMS contact editor: one row per host/moderator roster entry. ---
function ContactsEditor({ initialContacts }: { initialContacts: ContactWorker[] }) {
  const [contacts, setContacts] = useState(initialContacts)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { toast } = useToast()
  const supabase = createClient()

  function update(key: string, patch: Partial<ContactWorker>) {
    setContacts(prev => prev.map(c => (c.role + c.id) === key ? { ...c, ...patch } : c))
  }

  async function save(worker: ContactWorker) {
    const key = worker.role + worker.id
    setErrors(prev => ({ ...prev, [key]: '' }))
    const trimmed = worker.phone.trim()
    const normalized = trimmed ? toE164US(trimmed) : null
    if (trimmed && !normalized) {
      setErrors(prev => ({ ...prev, [key]: 'Not a valid US phone number.' }))
      return
    }
    setSavingId(key)
    try {
      const original = initialContacts.find(c => c.role === worker.role && c.id === worker.id)
      const oldPhone = original?.phone.trim() ? toE164US(original.phone) : null
      const idCol = worker.role === 'host' ? 'host_id' : 'moderator_id'

      // The phone is the table's primary key, and host_id/moderator_id are
      // each UNIQUE — so changing a worker's number means detaching their old
      // row before claiming a new one. The old row is never deleted: it keeps
      // that number's consent and STOP history (compliance record).
      // Never silently move a number that already belongs to someone else.
      if (normalized && normalized !== oldPhone) {
        const { data: taken, error: takenError } = await supabase.from('sms_contacts')
          .select('host_id, moderator_id').eq('phone_e164', normalized).maybeSingle()
        if (takenError) throw new Error(takenError.message)
        const owner = taken ? (taken as Record<string, string | null>)[idCol] : null
        if (owner && owner !== worker.id) {
          setErrors(prev => ({ ...prev, [key]: 'That number already belongs to another worker.' }))
          return
        }
      }

      if (oldPhone && oldPhone !== normalized) {
        const { error: clearError } = await supabase.from('sms_contacts')
          .update({ [idCol]: null }).eq('phone_e164', oldPhone).eq(idCol, worker.id)
        if (clearError) throw new Error(clearError.message)
      }

      if (!normalized) {
        toast({ title: 'Contact cleared' })
        setContacts(prev => prev.map(c => c.role === worker.role && c.id === worker.id
          ? { ...c, phone: '', optInAt: null, optInSource: null }
          : c))
        return
      }

      // Only carry forward the prior opt-in timestamp when the number itself
      // didn't change — a new phone number is a fresh contact, so checking
      // the box for it always stamps a fresh "now", never an old date that
      // belonged to a different physical phone.
      const phoneUnchanged = oldPhone === normalized
      const optIn = worker.optInAt !== null
      const payload: Record<string, unknown> = {
        phone_e164: normalized,
        [idCol]: worker.id,
        opt_in_at: optIn ? (phoneUnchanged ? (original?.optInAt ?? new Date().toISOString()) : new Date().toISOString()) : null,
        opt_in_source: optIn ? (phoneUnchanged ? (original?.optInSource ?? 'admin-recorded') : 'admin-recorded') : null,
      }
      const { data, error } = await supabase.from('sms_contacts')
        .upsert(payload, { onConflict: 'phone_e164' })
        .select('phone_e164, opt_in_at, opt_in_source, opted_out_at')
        .single()
      if (error) throw new Error(error.message)
      const row = data as { phone_e164: string; opt_in_at: string | null; opt_in_source: string | null; opted_out_at: string | null }
      setContacts(prev => prev.map(c => c.role === worker.role && c.id === worker.id
        ? { ...c, phone: row.phone_e164, optInAt: row.opt_in_at, optInSource: row.opt_in_source, optedOutAt: row.opted_out_at }
        : c))
      toast({ title: 'Contact saved' })
    } catch (e) {
      setErrors(prev => ({ ...prev, [key]: e instanceof Error ? e.message : 'Unable to save.' }))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="font-medium text-sm">SMS contacts</h3>
      <p className="text-xs text-muted-foreground">
        A worker can only text the bot back once they have a phone here and are opted in.
        Opting out by texting STOP always overrides this and cannot be undone from here.
      </p>
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              <th className="text-left px-3 py-2 text-muted-foreground font-medium">Name</th>
              <th className="text-left px-3 py-2 text-muted-foreground font-medium">Role</th>
              <th className="text-left px-3 py-2 text-muted-foreground font-medium">Phone</th>
              <th className="text-left px-3 py-2 text-muted-foreground font-medium">Opted in</th>
              <th className="text-left px-3 py-2 text-muted-foreground font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {contacts.map(c => {
              const key = c.role + c.id
              return (
                <tr key={key} className="border-b border-border last:border-0 align-top">
                  <td className="px-3 py-2">{c.name}{!c.isActive && <span className="text-muted-foreground text-xs"> (inactive)</span>}</td>
                  <td className="px-3 py-2 capitalize">{c.role}</td>
                  <td className="px-3 py-2">
                    <Input
                      type="tel"
                      className="w-40"
                      placeholder="(310) 555-0101"
                      value={c.phone}
                      onChange={e => update(key, { phone: e.target.value })}
                    />
                    {c.optedOutAt && (
                      <p className="text-[11px] text-destructive mt-1">Opted out by texting STOP</p>
                    )}
                    {errors[key] && <p className="text-[11px] text-destructive mt-1">{errors[key]}</p>}
                  </td>
                  <td className="px-3 py-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={c.optInAt !== null}
                        onChange={e => update(key, { optInAt: e.target.checked ? (c.optInAt ?? new Date().toISOString()) : null })}
                        className="w-3.5 h-3.5 accent-primary"
                      />
                      <span className="text-xs text-muted-foreground">
                        {c.optInAt ? `Since ${c.optInAt.slice(0, 10)}` : 'Not opted in'}
                      </span>
                    </label>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => save(c)} disabled={savingId === key}>
                      {savingId === key ? 'Saving…' : 'Save'}
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function PoolsContactsSection({ brands, moderators, initialModeratorPool, initialContacts }: Props) {
  return (
    <div className="rounded-lg border p-4 space-y-6">
      <h2 className="font-semibold">Pools &amp; contacts</h2>
      <ModeratorPoolEditor brands={brands} moderators={moderators} initialPool={initialModeratorPool} />
      <ContactsEditor initialContacts={initialContacts} />
    </div>
  )
}
