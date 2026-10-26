'use client'

import { useState } from 'react'
import { Plus, Pencil, Trash2, RotateCcw, Link as LinkIcon, Building2, Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Brand, BrandHost, Host, Profile } from '@/lib/supabase/types'
import { HostProfileDialog } from '@/components/profile/HostProfileDialog'
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
import { findOrphanRisks } from '@/lib/brandHosts'
import { formatCents } from '@/lib/utils'

// rate_cents is column-locked (migration 055) — a write's RETURNING can't
// include it, so mutations select the safe columns and we re-attach rate_cents
// (the value we just wrote, or the existing one) into local state for display.
// email/phone are column-locked too now (migration 066), so a write's
// RETURNING cannot include them either — the manager re-attaches the
// values it just wrote into local state, same as it does for rate_cents.
const HOST_SAFE_SELECT =
  'id, name, user_id, is_active, self_moderating, monthly_gmv_goal_cents, email_disabled_at, email_disabled_reason, created_at'

interface HostsManagerProps {
  initialHosts: Host[]
  profiles: Profile[]
  brands: Brand[]
  initialBrandHosts: BrandHost[]
  /** When false (producer-not-admin), the rate column + input are hidden
   *  and rate_cents is omitted from the save payload. */
  canEditRates?: boolean
}

interface OrphanRisk {
  brandId: string
  brandName: string
  count: number
}

interface FormState {
  name: string
  email: string
  phone: string
  user_id: string
  /** Dollars as a string in the input — converted to cents on save. */
  rate: string
  /** This host moderates their own shifts, so they may report GMV (mig 075). */
  selfModerating: boolean
  /** Dollars as a string — the monthly GMV-per-hour goal. Blank = no goal. */
  gmvGoal: string
  brandIds: Set<string>
}

const EMPTY_FORM: FormState = {
  name: '', email: '', phone: '', user_id: '', rate: '',
  selfModerating: false, gmvGoal: '', brandIds: new Set(),
}

export function HostsManager({ initialHosts, profiles, brands, initialBrandHosts, canEditRates = true }: HostsManagerProps) {
  const [hosts, setHosts] = useState<Host[]>(initialHosts)
  const [brandHosts, setBrandHosts] = useState<BrandHost[]>(initialBrandHosts)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deactivateId, setDeactivateId] = useState<string | null>(null)
  // Deactivated hosts stay in the table forever (history), so hide them by default.
  const [showInactive, setShowInactive] = useState(false)
  const [editingHost, setEditingHost] = useState<Host | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // When the admin's pending Save would unlink the host from one or more
  // brands that still have active future streams, surface a confirm dialog
  // before mutating anything. Cleared on confirm OR cancel.
  const [orphanRisks, setOrphanRisks] = useState<OrphanRisk[] | null>(null)
  // Profile viewer dialog state
  const [profileTarget, setProfileTarget] = useState<{ userId: string | null; name: string } | null>(null)
  const { toast } = useToast()
  const supabase = createClient()

  // Map host_id → set of brand_ids they have access to
  const hostBrandMap = new Map<string, Set<string>>()
  for (const row of brandHosts) {
    if (!hostBrandMap.has(row.host_id)) hostBrandMap.set(row.host_id, new Set())
    hostBrandMap.get(row.host_id)!.add(row.brand_id)
  }

  function openCreate() {
    setEditingHost(null)
    // New hosts default to all brands so admins don't have to assign one-by-one
    // for the common case. Rate pre-fills the $30/hr default (migration 046).
    setForm({ ...EMPTY_FORM, rate: '30.00', brandIds: new Set(brands.map(b => b.id)) })
    setError(null)
    setDialogOpen(true)
  }

  function openEdit(host: Host) {
    setEditingHost(host)
    setForm({
      name: host.name,
      email: host.email ?? '',
      phone: host.phone ?? '',
      user_id: host.user_id ?? '',
      rate: host.rate_cents ? (host.rate_cents / 100).toFixed(2) : '',
      selfModerating: host.self_moderating ?? false,
      // Blank when unset, so "no goal" round-trips as blank rather than "0.00"
      // — the column is nullable precisely so those two stay distinguishable.
      gmvGoal: host.monthly_gmv_goal_cents == null
        ? ''
        : (host.monthly_gmv_goal_cents / 100).toFixed(2),
      brandIds: new Set(hostBrandMap.get(host.id) ?? []),
    })
    setError(null)
    setDialogOpen(true)
  }

  function toggleBrand(brandId: string) {
    setForm(f => {
      const next = new Set(f.brandIds)
      if (next.has(brandId)) next.delete(brandId)
      else next.add(brandId)
      return { ...f, brandIds: next }
    })
  }

  async function syncBrandAssignments(hostId: string, desired: Set<string>) {
    const current = hostBrandMap.get(hostId) ?? new Set<string>()
    const toAdd    = Array.from(desired).filter(b => !current.has(b))
    const toRemove = Array.from(current).filter(b => !desired.has(b))

    if (toAdd.length > 0) {
      const { error } = await supabase
        .from('brand_hosts')
        .insert(toAdd.map(brand_id => ({ brand_id, host_id: hostId })))
      if (error) throw error
    }
    if (toRemove.length > 0) {
      const { error } = await supabase
        .from('brand_hosts')
        .delete()
        .eq('host_id', hostId)
        .in('brand_id', toRemove)
      if (error) throw error
    }

    // Update local state
    setBrandHosts(prev => {
      const filtered = prev.filter(r => !(r.host_id === hostId && toRemove.includes(r.brand_id)))
      const added: BrandHost[] = toAdd.map(brand_id => ({
        brand_id,
        host_id: hostId,
        created_at: new Date().toISOString(),
      }))
      return [...filtered, ...added]
    })
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setError('Name is required.')
      return
    }
    setError(null)

    // Pre-flight safeguard: when editing an existing host, an unlink (brands
    // that were in current but aren't in desired) silently orphans any
    // active future streams on that (host, brand) pair. Block the save and
    // surface a confirm dialog before mutating anything. Skipped entirely
    // for new-host creates (current = empty) and for no-unlink edits.
    if (editingHost) {
      const current = hostBrandMap.get(editingHost.id) ?? new Set<string>()
      const toRemove = Array.from(current).filter(b => !form.brandIds.has(b))
      if (toRemove.length > 0) {
        setSaving(true)
        try {
          const risks = await findOrphanRisks(supabase, editingHost.id, toRemove)
          if (risks.length > 0) {
            setOrphanRisks(
              risks.map(r => ({
                brandId: r.brandId,
                brandName: brands.find(b => b.id === r.brandId)?.name ?? 'Unknown brand',
                count: r.count,
              })),
            )
            setSaving(false)
            return
          }
        } catch {
          // Network blip on the risk check: fail-open and let the save run
          // through. The DB still enforces the link-removal; the only thing
          // we lose is the warning.
        }
        // No risks — drop the saving flag and continue through to performSave.
        setSaving(false)
      }
    }
    await performSave()
  }

  async function performSave() {
    setSaving(true)
    setError(null)

    // Rate input is in dollars; persist as integer cents.
    //
    // A BLANK rate no longer means "write the default" when EDITING — it means
    // "leave the stored rate alone". That distinction is load-bearing: the rate
    // shown here comes from the admin_host_rate_map RPC (the column itself is
    // locked by migration 055), and if that RPC ever returns nothing the page
    // renders every host at 0, which seeds this field BLANK. Under the old
    // rule, an admin who opened the dialog to fix a phone number and hit Save
    // would silently rewrite a $45/hr host to $30/hr — no confirmation, no
    // audit trail, and the wrong number flows straight into payroll.
    //
    // On CREATE a blank field still takes the $30/hr default (3000, matching
    // migration 046's column default) — there is no existing value to protect.
    //
    // Producers (canEditRates=false) can't write the rate at all — omit so the
    // existing value isn't blown away.
    const rateDollars = parseFloat(form.rate)
    const rateBlank = form.rate.trim() === '' || isNaN(rateDollars) || rateDollars < 0
    const rateCents = rateBlank ? 3000 : Math.round(rateDollars * 100)
    // Editing + blank → omit the key entirely so the UPDATE doesn't touch it.
    const writeRate = canEditRates && !(editingHost && rateBlank)

    const basePayload = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      user_id: form.user_id || null,
    }
    // Self-mod flag and GMV goal are ADMIN-ONLY at the database (triggers,
    // migration 075), so a producer's save must omit them entirely rather than
    // send the unchanged value -- the trigger fires on IS DISTINCT FROM, so
    // resending an identical value is fine, but sending a value a producer
    // cannot legitimately set would raise and fail their whole save.
    // canEditRates is the admin flag (admin/hosts/page.tsx passes
    // effectiveIsAdmin), so it gates these too.
    //
    // Unlike the rate, a BLANK goal means "clear it" rather than "leave alone".
    // That is safe here precisely because the goal is read straight off the
    // table, not via an RPC that could fail and render a misleading 0 -- the
    // hazard the rate's blank-means-omit rule exists to prevent. Blank really
    // does mean the admin wants no goal, and the column is nullable so that
    // "no goal" and "a goal of zero" stay distinguishable.
    const goalDollars = parseFloat(form.gmvGoal)
    const goalBlank = form.gmvGoal.trim() === '' || isNaN(goalDollars) || goalDollars < 0
    const adminOnlyPayload = canEditRates
      ? {
          self_moderating: form.selfModerating,
          monthly_gmv_goal_cents: goalBlank ? null : Math.round(goalDollars * 100),
        }
      : {}

    const payload = writeRate
      ? { ...basePayload, ...adminOnlyPayload, rate_cents: rateCents }
      : { ...basePayload, ...adminOnlyPayload }

    try {
      let hostId: string
      if (editingHost) {
        const { data, error } = await supabase
          .from('hosts')
          .update(payload)
          .eq('id', editingHost.id)
          .select(HOST_SAFE_SELECT)
          .single()
        if (error) throw error
        const row = data as Host
        hostId = row.id
          // email/phone are column-locked (mig 066) so the RETURNING above
          // omits them; re-attach what we just wrote, same as rate_cents.
        setHosts(prev => prev.map(h => h.id === editingHost.id
          ? {
              ...row,
              rate_cents: canEditRates ? rateCents : h.rate_cents,
              email: basePayload.email,
              phone: basePayload.phone,
            }
          : h))
      } else {
        const { data, error } = await supabase
          .from('hosts')
          .insert(payload)
          .select(HOST_SAFE_SELECT)
          .single()
        if (error) throw error
        const row = data as Host
        hostId = row.id
        setHosts(prev => [...prev, {
          ...row,
          rate_cents: canEditRates ? rateCents : 3000,
          email: basePayload.email,
          phone: basePayload.phone,
        }])
      }

      await syncBrandAssignments(hostId, form.brandIds)

      toast({ title: editingHost ? 'Host updated' : 'Host added' })
      setDialogOpen(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  // Soft-delete: "deleting" a host just flips is_active off. The row, its
  // brand links, and all pay/GMV history stay intact (bookkeeping), and the
  // host drops off active rosters + assignment dropdowns. Reversible.
  async function handleDeactivate(id: string) {
    const { data, error } = await supabase
      .from('hosts')
      .update({ is_active: false })
      .eq('id', id)
      .select(HOST_SAFE_SELECT)
      .single()
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
    } else {
      // MERGE, don't replace: the write now RETURNs only safe columns (mig 055
      // locks rate_cents), so assigning `data` wholesale would blank the rate
      // in local state and the row would render as $0 until a refresh.
      setHosts(prev => prev.map(h => h.id === id ? { ...h, ...(data as Host) } : h))
      // They vanish from the default view, so say where they went.
      toast({
        title: 'Host deactivated',
        description: showInactive ? undefined : 'Hidden from this list — use “Show inactive” to see them.',
      })
    }
    setDeactivateId(null)
  }

  async function handleReactivate(id: string) {
    const { data, error } = await supabase
      .from('hosts')
      .update({ is_active: true })
      .eq('id', id)
      .select(HOST_SAFE_SELECT)
      .single()
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
    } else {
      setHosts(prev => prev.map(h => h.id === id ? { ...h, ...(data as Host) } : h))
      toast({ title: 'Host reactivated' })
    }
  }

  const profileMap = new Map(profiles.map(p => [p.id, p]))

  // Deactivated hosts are kept forever (their pay/GMV history depends on the
  // row surviving — see mig 054), but they shouldn't clutter the working
  // roster. Hidden by default; the toggle only appears once there's something
  // to reveal.
  const inactiveCount = hosts.reduce((n, h) => n + (h.is_active ? 0 : 1), 0)
  const visibleHosts = showInactive ? hosts : hosts.filter(h => h.is_active)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Hosts</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage stream hosts, their linked accounts, and which brands they can book.</p>
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
            Add Host
          </Button>
        </div>
      </div>

      {visibleHosts.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">
            {hosts.length === 0
              ? 'No hosts yet. Add your first host to get started.'
              : 'No active hosts. Use “Show inactive” to see deactivated ones.'}
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
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Brands</th>
                {canEditRates && (
                  <th className="text-right px-4 py-3 text-muted-foreground font-medium">Rate</th>
                )}
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleHosts.map((host, i) => {
                const linkedProfile = host.user_id ? profileMap.get(host.user_id) : null
                const accessibleCount = hostBrandMap.get(host.id)?.size ?? 0
                const allBrands = accessibleCount === brands.length && brands.length > 0
                return (
                  <tr key={host.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? '' : 'bg-secondary/20'} ${!host.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3 font-medium text-foreground">
                      <button
                        type="button"
                        className="hover:text-primary transition-colors text-left"
                        onClick={() => setProfileTarget({ userId: host.user_id, name: host.name })}
                        title="View profile"
                      >
                        {host.name}
                      </button>
                      {!host.is_active && (
                        <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground align-middle">Inactive</Badge>
                      )}
                      {/* Visible at a glance because it decides who can report
                          this host's GMV. A shift with no moderator and a host
                          who is NOT flagged has nobody able to enter it. */}
                      {host.self_moderating && (
                        <Badge variant="outline" className="ml-2 text-[10px] text-muted-foreground align-middle">Self-mod</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{host.email || '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{host.phone || '—'}</td>
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
                    <td className="px-4 py-3">
                      {accessibleCount === 0 ? (
                        <span className="text-muted-foreground text-xs italic">None</span>
                      ) : (
                        <Badge variant="secondary" className="gap-1 text-xs">
                          <Building2 className="w-2.5 h-2.5" />
                          {allBrands ? 'All brands' : `${accessibleCount} of ${brands.length}`}
                        </Badge>
                      )}
                    </td>
                    {canEditRates && (
                      <td className="px-4 py-3 text-right tabular-nums">
                        {host.rate_cents > 0 ? (
                          <span className="text-foreground font-medium">{formatCents(host.rate_cents)}/hr</span>
                        ) : (
                          <span className="text-muted-foreground text-xs italic">Not set</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => openEdit(host)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        {host.is_active ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-destructive hover:text-destructive"
                            onClick={() => setDeactivateId(host.id)}
                            title="Deactivate host"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9"
                            onClick={() => handleReactivate(host.id)}
                            title="Reactivate host"
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
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingHost ? 'Edit Host' : 'Add Host'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="host-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="host-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Host name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-email">
                Email <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="host-email"
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="host@example.invalid"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-phone">
                Phone <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="host-phone"
                type="tel"
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="(555) 123-4567"
              />
            </div>
            {canEditRates && (
              <div className="space-y-1.5">
                <Label htmlFor="host-rate">Hourly rate ($)</Label>
                <Input
                  id="host-rate"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={form.rate}
                  onChange={e => setForm(f => ({ ...f, rate: e.target.value }))}
                  placeholder="30.00"
                />
                <p className="text-[11px] text-muted-foreground">
                  Flat rate × hours worked on every shift this host books. Defaults to $30.00/hr.
                </p>
              </div>
            )}

            {/* Both admin-only, and enforced by triggers at the database
                (migration 075) — this check is UX, not the boundary. */}
            {canEditRates && (
              <>
                <div className="space-y-1.5">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.selfModerating}
                      onChange={e => setForm(f => ({ ...f, selfModerating: e.target.checked }))}
                      className="w-3.5 h-3.5 mt-1 accent-primary"
                    />
                    <span>
                      <span className="text-sm text-foreground">Self-moderating</span>
                      <span className="block text-[11px] text-muted-foreground">
                        This host moderates their own shifts, so they report their own session
                        GMV. Leave off and only the moderator on a shift can enter it.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="host-gmv-goal">Monthly GMV goal ($ per hour)</Label>
                  <Input
                    id="host-gmv-goal"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={form.gmvGoal}
                    onChange={e => setForm(f => ({ ...f, gmvGoal: e.target.value }))}
                    placeholder="No goal set"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Target revenue per hour, shown to this host on their own page. Leave blank
                    for no goal — that is different from a goal of $0.
                  </p>
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="host-user">Linked Profile</Label>
              <Select value={form.user_id} onValueChange={v => setForm(f => ({ ...f, user_id: v === 'none' ? '' : v }))}>
                <SelectTrigger id="host-user">
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
              <p className="text-[11px] text-muted-foreground">Linked users can log in and view their assigned streams.</p>
            </div>

            {/* Brand assignments */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Brand Access</Label>
                {brands.length > 0 && (
                  <div className="flex gap-3 text-[11px]">
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setForm(f => ({ ...f, brandIds: new Set(brands.map(b => b.id)) }))}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:underline"
                      onClick={() => setForm(f => ({ ...f, brandIds: new Set() }))}
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              {brands.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No brands exist yet.</p>
              ) : (
                <div className="border border-border rounded-md max-h-40 overflow-y-auto divide-y divide-border">
                  {brands.map(b => {
                    const checked = form.brandIds.has(b.id)
                    return (
                      <label
                        key={b.id}
                        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-secondary/50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleBrand(b.id)}
                          className="w-3.5 h-3.5 accent-primary"
                        />
                        <span className="text-sm text-foreground">{b.name}</span>
                      </label>
                    )
                  })}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                {form.brandIds.size} of {brands.length} brand{brands.length === 1 ? '' : 's'} selected. Hosts only see calendars for brands they&apos;re assigned to.
              </p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editingHost ? 'Save Changes' : 'Add Host'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate Confirm — soft-delete, reversible */}
      <AlertDialog open={!!deactivateId} onOpenChange={() => setDeactivateId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate Host?</AlertDialogTitle>
            <AlertDialogDescription>
              They&apos;ll be hidden from the active roster and from assignment dropdowns. Any upcoming shifts they&apos;re already on stay scheduled — reassign or cancel those separately. Their past shifts and pay history are kept for the record, and you can reactivate them anytime.
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

      {/* Orphan-risk Confirm — fires when unlinking a host from a brand
          that still has active future streams on that pair. */}
      <AlertDialog open={!!orphanRisks} onOpenChange={(o) => !o && setOrphanRisks(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink host from {orphanRisks?.length === 1 ? 'this brand' : `${orphanRisks?.length} brands`}?</AlertDialogTitle>
            <AlertDialogDescription>
              This host still has upcoming shifts on the following brand{orphanRisks?.length === 1 ? '' : 's'}.
              Removing the brand link does NOT cancel those shifts — they stay scheduled but the host
              loses access to view the brand calendar. You probably want to reassign or cancel them first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {orphanRisks && orphanRisks.length > 0 && (
            <ul className="text-sm border border-border rounded-md divide-y divide-border">
              {orphanRisks.map(r => (
                <li key={r.brandId} className="px-3 py-2 flex items-center justify-between">
                  <span className="text-foreground font-medium truncate">{r.brandName}</span>
                  <span className="text-destructive font-semibold tabular-nums">
                    {r.count} upcoming shift{r.count === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={async () => {
                setOrphanRisks(null)
                await performSave()
              }}
            >
              Unlink anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Profile viewer (admin-only data) */}
      <HostProfileDialog
        open={!!profileTarget}
        onOpenChange={(o) => !o && setProfileTarget(null)}
        userId={profileTarget?.userId ?? null}
        displayName={profileTarget?.name ?? ''}
      />
    </div>
  )
}
