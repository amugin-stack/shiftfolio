'use client'

import { useState } from 'react'
import { Plus, Pencil, Trash2, RotateCcw, Link as LinkIcon, Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Moderator, Profile } from '@/lib/supabase/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { formatCents } from '@/lib/utils'

// rate_cents is column-locked (migration 055) — writes can't return it, so
// mutations select safe columns and we re-attach rate_cents into local state.
// email/phone are column-locked too now (migration 066), so a write's
// RETURNING cannot include them either — the manager re-attaches the
// values it just wrote into local state, same as it does for rate_cents.
const MODERATOR_SAFE_SELECT =
  'id, name, user_id, is_active, email_disabled_at, email_disabled_reason, created_at'

interface ModeratorsManagerProps {
  initialModerators: Moderator[]
  profiles: Profile[]
  /** When false (producer-not-admin), the rate column + input are hidden
   *  and rate_cents is omitted from the save payload. */
  canEditRates?: boolean
}

interface FormState {
  name: string
  email: string
  phone: string
  user_id: string
  /** Dollars as a string in the input — converted to cents on save. */
  rate: string
}

const EMPTY_FORM: FormState = { name: '', email: '', phone: '', user_id: '', rate: '' }

export function ModeratorsManager({ initialModerators, profiles, canEditRates = true }: ModeratorsManagerProps) {
  const [moderators, setModerators] = useState<Moderator[]>(initialModerators)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deactivateId, setDeactivateId] = useState<string | null>(null)
  // Deactivated moderators stay in the table forever (history), so hide them by default.
  const [showInactive, setShowInactive] = useState(false)
  const [editingModerator, setEditingModerator] = useState<Moderator | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()
  const supabase = createClient()

  function openCreate() {
    setEditingModerator(null)
    setForm(EMPTY_FORM)
    setError(null)
    setDialogOpen(true)
  }

  function openEdit(moderator: Moderator) {
    setEditingModerator(moderator)
    setForm({
      name: moderator.name,
      email: moderator.email ?? '',
      phone: moderator.phone ?? '',
      user_id: moderator.user_id ?? '',
      rate: moderator.rate_cents ? (moderator.rate_cents / 100).toFixed(2) : '',
    })
    setError(null)
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setError('Name is required.')
      return
    }
    setSaving(true)
    setError(null)

    // Rate input is in dollars; persist as integer cents.
    //
    // A BLANK rate means "leave the stored rate alone" when EDITING, not
    // "write 0". The rate shown here comes from the admin_moderator_rate_map
    // RPC (the column is locked by migration 055); if that RPC returns nothing
    // the page renders every moderator at 0, which seeds this field blank. The
    // old rule then let an admin editing a phone number silently write a 0
    // rate — and a 0 rate means the moderator is paid NOTHING for the period,
    // with the payroll CSV showing $0.00 and nothing flagging it.
    //
    // On CREATE, blank still means 0 (no existing value to protect).
    const rateDollars = parseFloat(form.rate)
    const rateBlank = form.rate.trim() === '' || isNaN(rateDollars) || rateDollars < 0
    const rateCents = rateBlank ? 0 : Math.round(rateDollars * 100)
    // Editing + blank → omit the key entirely so the UPDATE doesn't touch it.
    const writeRate = canEditRates && !(editingModerator && rateBlank)

    const basePayload = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      user_id: form.user_id || null,
    }
    const payload = writeRate
      ? { ...basePayload, rate_cents: rateCents }
      : basePayload

    if (editingModerator) {
      const { data, error } = await supabase
        .from('moderators')
        .update(payload)
        .eq('id', editingModerator.id)
        .select(MODERATOR_SAFE_SELECT)
        .single()

      if (error) { setError(error.message); setSaving(false); return }
      const row = data as Moderator
      // email/phone are column-locked (mig 066) so the RETURNING above omits
      // them; re-attach what we just wrote, same as rate_cents.
      setModerators(prev => prev.map(m => m.id === editingModerator.id
        ? {
            ...row,
            rate_cents: canEditRates ? rateCents : m.rate_cents,
            email: basePayload.email,
            phone: basePayload.phone,
          }
        : m))
      toast({ title: 'Moderator updated' })
    } else {
      const { data, error } = await supabase
        .from('moderators')
        .insert(payload)
        .select(MODERATOR_SAFE_SELECT)
        .single()

      if (error) { setError(error.message); setSaving(false); return }
      const row = data as Moderator
      setModerators(prev => [...prev, {
        ...row,
        rate_cents: canEditRates ? rateCents : 0,
        email: basePayload.email,
        phone: basePayload.phone,
      }])
      toast({ title: 'Moderator added' })
    }

    setSaving(false)
    setDialogOpen(false)
  }

  // Soft-delete: flip is_active off. Row + rate + any stream assignments stay,
  // so payroll history is preserved; the moderator drops off active rosters
  // and assignment dropdowns. Reversible.
  async function handleDeactivate(id: string) {
    const { data, error } = await supabase
      .from('moderators')
      .update({ is_active: false })
      .eq('id', id)
      .select(MODERATOR_SAFE_SELECT)
      .single()
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
    } else {
      // MERGE, don't replace — the write RETURNs only safe columns now
      // (mig 055 locks rate_cents); a wholesale assign would blank the rate.
      setModerators(prev => prev.map(m => m.id === id ? { ...m, ...(data as Moderator) } : m))
      // They vanish from the default view, so say where they went.
      toast({
        title: 'Moderator deactivated',
        description: showInactive ? undefined : 'Hidden from this list — use “Show inactive” to see them.',
      })
    }
    setDeactivateId(null)
  }

  async function handleReactivate(id: string) {
    const { data, error } = await supabase
      .from('moderators')
      .update({ is_active: true })
      .eq('id', id)
      .select(MODERATOR_SAFE_SELECT)
      .single()
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
    } else {
      setModerators(prev => prev.map(m => m.id === id ? { ...m, ...(data as Moderator) } : m))
      toast({ title: 'Moderator reactivated' })
    }
  }

  const profileMap = new Map(profiles.map(p => [p.id, p]))

  // Deactivated moderators are kept forever (pay history depends on the row
  // surviving — see mig 054) but shouldn't clutter the working roster.
  const inactiveCount = moderators.reduce((n, m) => n + (m.is_active ? 0 : 1), 0)
  const visibleModerators = showInactive ? moderators : moderators.filter(m => m.is_active)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Moderators</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage stream moderators and their linked accounts.</p>
        </div>
        <div className="flex items-center gap-2">
          {inactiveCount > 0 && (
            <Button
              onClick={() => setShowInactive(v => !v)}
              size="sm"
              variant="outline"
              className="gap-2"
            >
              {showInactive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              {showInactive ? 'Hide inactive' : `Show inactive (${inactiveCount})`}
            </Button>
          )}
          <Button onClick={openCreate} size="sm" className="gap-2">
            <Plus className="w-4 h-4" />
            Add Moderator
          </Button>
        </div>
      </div>

      {visibleModerators.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">
            {moderators.length === 0
              ? 'No moderators yet. Add your first moderator to get started.'
              : 'No active moderators. Use “Show inactive” to see deactivated ones.'}
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Name</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Email</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Phone</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Linked User</th>
                {canEditRates && (
                  <th className="text-right px-4 py-3 text-muted-foreground font-medium">Rate</th>
                )}
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleModerators.map((moderator, i) => {
                const linkedProfile = moderator.user_id ? profileMap.get(moderator.user_id) : null
                return (
                  <tr key={moderator.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? '' : 'bg-secondary/20'} ${!moderator.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3 font-medium text-foreground">
                      {moderator.name}
                      {!moderator.is_active && (
                        <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground align-middle">Inactive</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{moderator.email || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{moderator.phone || '—'}</td>
                    <td className="px-4 py-3">
                      {linkedProfile ? (
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <LinkIcon className="w-2.5 h-2.5" />
                          {linkedProfile.email}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">Not linked</span>
                      )}
                    </td>
                    {canEditRates && (
                      <td className="px-4 py-3 text-right tabular-nums">
                        {moderator.rate_cents > 0 ? (
                          <span className="text-foreground font-medium">{formatCents(moderator.rate_cents)}/hr</span>
                        ) : (
                          <span className="text-muted-foreground text-xs italic">Not set</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => openEdit(moderator)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        {moderator.is_active ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-destructive hover:text-destructive"
                            onClick={() => setDeactivateId(moderator.id)}
                            title="Deactivate moderator"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9"
                            onClick={() => handleReactivate(moderator.id)}
                            title="Reactivate moderator"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingModerator ? 'Edit Moderator' : 'Add Moderator'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="moderator-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="moderator-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Moderator name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="moderator-email">
                Email <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="moderator-email"
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="moderator@example.invalid"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="moderator-phone">
                Phone <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="moderator-phone"
                type="tel"
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="(555) 123-4567"
              />
            </div>
            {canEditRates && (
              <div className="space-y-1.5">
                <Label htmlFor="moderator-rate">Hourly rate ($)</Label>
                <Input
                  id="moderator-rate"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.rate}
                  onChange={e => setForm(f => ({ ...f, rate: e.target.value }))}
                  placeholder="25.00"
                />
                <p className="text-[11px] text-muted-foreground">
                  Applied as a flat rate × hours worked on every shift this moderator is assigned to.
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="moderator-user">Linked Profile</Label>
              <Select value={form.user_id} onValueChange={v => setForm(f => ({ ...f, user_id: v === 'none' ? '' : v }))}>
                <SelectTrigger id="moderator-user">
                  <SelectValue placeholder="No linked account" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No linked account</SelectItem>
                  {profiles.map(p => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.full_name ? `${p.full_name} (${p.email})` : p.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Linked users can log in and view every brand schedule.</p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editingModerator ? 'Save Changes' : 'Add Moderator'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate Confirm — soft-delete, reversible */}
      <AlertDialog open={!!deactivateId} onOpenChange={() => setDeactivateId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate Moderator?</AlertDialogTitle>
            <AlertDialogDescription>
              They&apos;ll be hidden from the active roster and from assignment dropdowns. Any streams they&apos;re already assigned to stay as-is — reassign those separately. Their past assignments and pay history are kept for the record, and you can reactivate them anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deactivateId && handleDeactivate(deactivateId)}>
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
