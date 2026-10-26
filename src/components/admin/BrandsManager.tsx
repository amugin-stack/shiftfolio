'use client'

import { useState } from 'react'
import { Plus, Pencil, Trash2, Link as LinkIcon } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Brand, Producer, Profile } from '@/lib/supabase/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { BrandLogoUploader } from './BrandLogoUploader'
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
import { colorFromHex, BRAND_COLORS } from '@/lib/utils'
import { buildBrandColorMap } from '@/lib/masterSchedule'

// client_rate_cents + contracted_hours_per_month are column-locked (migration
// 055) — writes can't return them, so mutations select the safe columns and we
// re-attach the pricing values into local state for display.
const BRAND_SAFE_SELECT =
  'id, name, email, user_id, block_size_minutes, day_start_minutes, day_end_minutes, logo_path, producer_id, color, created_at'

interface BrandsManagerProps {
  initialBrands: Brand[]
  profiles: Profile[]
  producers: Producer[]
  /** When false (producer-not-admin), the client_rate column + input are
   *  hidden and the rate field is omitted from save payloads. */
  canEditRates?: boolean
}

interface FormState {
  name: string
  email: string
  user_id: string
  producer_id: string
  client_rate: string // dollars as entered; converted to cents on save
  contracted_hours: string // whole hours as entered; null when blank
  color: string // #RRGGBB, or '' = automatic (index-palette fallback)
}

const EMPTY_FORM: FormState = { name: '', email: '', user_id: '', producer_id: '', client_rate: '', contracted_hours: '', color: '' }

function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents == null) return ''
  return (cents / 100).toFixed(2).replace(/\.00$/, '')
}

function formatRateLabel(cents: number | null | undefined): string {
  if (cents == null) return ''
  const dollars = cents / 100
  return `$${dollars.toLocaleString('en-US', { maximumFractionDigits: 2 })}/hr`
}

export function BrandsManager({ initialBrands, profiles, producers, canEditRates = true }: BrandsManagerProps) {
  const [brands, setBrands] = useState<Brand[]>(initialBrands)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()
  const supabase = createClient()

  // Index-palette color each brand falls back to on the master schedule when it
  // has no explicit color. Mirrors buildBrandColorMap on the master-schedule
  // page (both order brands by name), so the swatch/preview match what renders.
  const paletteByIndex = buildBrandColorMap(brands.map(b => b.id))
  const fallbackBg = (brandId: string | null) =>
    (brandId ? paletteByIndex.get(brandId)?.bg : undefined) ?? BRAND_COLORS[0].bg
  // The color the picker should display: explicit pick, else the brand's
  // automatic palette color (so the wheel always opens on the current color).
  const pickerHex = form.color || fallbackBg(editingBrand?.id ?? null)

  function openCreate() {
    setEditingBrand(null)
    setForm(EMPTY_FORM)
    setError(null)
    setDialogOpen(true)
  }

  function openEdit(brand: Brand) {
    setEditingBrand(brand)
    setForm({
      name: brand.name,
      email: brand.email ?? '',
      user_id: brand.user_id ?? '',
      producer_id: brand.producer_id ?? '',
      client_rate: centsToDollarsInput(brand.client_rate_cents),
      contracted_hours: brand.contracted_hours_per_month != null ? String(brand.contracted_hours_per_month) : '',
      color: brand.color ?? '',
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

    // Client rate: empty input → null (unset). Otherwise must parse as
    // a non-negative number; convert dollars to cents (round to handle FP).
    // Producers (canEditRates=false) cannot write this field at all — omit
    // it from the payload so an existing value isn't blown away.
    let clientRateCents: number | null = null
    if (canEditRates) {
      const rateStr = form.client_rate.trim()
      if (rateStr !== '') {
        const parsed = Number(rateStr)
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError('Client rate must be a non-negative number.')
          setSaving(false)
          return
        }
        clientRateCents = Math.round(parsed * 100)
      }
    }

    // Contracted hours: blank → null (unset). Otherwise must be a whole
    // non-negative number. Producers (canEditRates=false) can't write it.
    let contractedHours: number | null = null
    if (canEditRates) {
      const chStr = form.contracted_hours.trim()
      if (chStr !== '') {
        const parsed = Number(chStr)
        if (!Number.isInteger(parsed) || parsed < 0) {
          setError('Contracted hours must be a whole non-negative number.')
          setSaving(false)
          return
        }
        contractedHours = parsed
      }
    }

    const basePayload = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      user_id: form.user_id || null,
      producer_id: form.producer_id || null,
      color: form.color || null, // '' → automatic (palette fallback)
    }
    const payload = canEditRates
      ? { ...basePayload, client_rate_cents: clientRateCents, contracted_hours_per_month: contractedHours }
      : basePayload

    if (editingBrand) {
      const { data, error } = await supabase
        .from('brands')
        .update(payload)
        .eq('id', editingBrand.id)
        .select(BRAND_SAFE_SELECT)
        .single()

      if (error) { setError(error.message); setSaving(false); return }
      const row = data as Brand
      setBrands(prev => prev.map(b => b.id === editingBrand.id
        ? { ...row,
            client_rate_cents: canEditRates ? clientRateCents : b.client_rate_cents,
            contracted_hours_per_month: canEditRates ? contractedHours : b.contracted_hours_per_month }
        : b))
      toast({ title: 'Brand updated' })
    } else {
      const { data, error } = await supabase
        .from('brands')
        .insert(payload)
        .select(BRAND_SAFE_SELECT)
        .single()

      if (error) { setError(error.message); setSaving(false); return }
      const row = data as Brand
      setBrands(prev => [...prev, { ...row, client_rate_cents: clientRateCents, contracted_hours_per_month: contractedHours }])
      toast({ title: 'Brand added' })
    }

    setSaving(false)
    setDialogOpen(false)
  }

  async function handleDelete(id: string) {
    const { error } = await supabase.from('brands').delete().eq('id', id)
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
    } else {
      setBrands(prev => prev.filter(b => b.id !== id))
      toast({ title: 'Brand deleted' })
    }
    setDeleteId(null)
  }

  const profileMap = new Map(profiles.map(p => [p.id, p]))
  const producerMap = new Map(producers.map(p => [p.id, p]))

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Brands</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage brands and their linked accounts.</p>
        </div>
        <Button onClick={openCreate} size="sm" className="gap-2">
          <Plus className="w-4 h-4" />
          Add Brand
        </Button>
      </div>

      {brands.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">No brands yet. Add your first brand to get started.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-3 text-muted-foreground font-medium w-12"></th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Name</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Email</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Linked User</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Producer</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Color</th>
                {canEditRates && (
                  <th className="text-right px-4 py-3 text-muted-foreground font-medium">Client Rate</th>
                )}
                {canEditRates && (
                  <th className="text-right px-4 py-3 text-muted-foreground font-medium">Contracted</th>
                )}
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {brands.map((brand, i) => {
                const linkedProfile = brand.user_id ? profileMap.get(brand.user_id) : null
                return (
                  <tr key={brand.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? '' : 'bg-secondary/20'}`}>
                    <td className="px-4 py-3">
                      <BrandLogo name={brand.name} logoPath={brand.logo_path} size="md" />
                    </td>
                    <td className="px-4 py-3 font-medium text-foreground">{brand.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{brand.email || '—'}</td>
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
                      {brand.producer_id ? (
                        <span className="text-sm text-foreground">{producerMap.get(brand.producer_id)?.name ?? 'Unknown'}</span>
                      ) : (
                        <span className="text-muted-foreground text-xs italic">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-block h-5 w-5 rounded-md border border-border align-middle"
                        style={{ backgroundColor: brand.color ?? fallbackBg(brand.id) }}
                        title={brand.color ? brand.color : `${fallbackBg(brand.id)} (automatic)`}
                      />
                    </td>
                    {canEditRates && (
                      <td className="px-4 py-3 text-right tabular-nums">
                        {brand.client_rate_cents != null ? (
                          <span className="text-sm font-medium text-foreground">{formatRateLabel(brand.client_rate_cents)}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Not set</span>
                        )}
                      </td>
                    )}
                    {canEditRates && (
                      <td className="px-4 py-3 text-right tabular-nums">
                        {brand.contracted_hours_per_month != null ? (
                          <span className="text-sm font-medium text-foreground">{brand.contracted_hours_per_month} hrs/mo</span>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Not set</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => openEdit(brand)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive hover:text-destructive"
                          onClick={() => setDeleteId(brand.id)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
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
            <DialogTitle>{editingBrand ? 'Edit Brand' : 'Add Brand'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="brand-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="brand-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Brand name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="brand-email">
                Email <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="brand-email"
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="brand@example.invalid"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="brand-user">Linked Profile</Label>
              <Select value={form.user_id} onValueChange={v => setForm(f => ({ ...f, user_id: v === 'none' ? '' : v }))}>
                <SelectTrigger id="brand-user">
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
            <div className="space-y-1.5">
              <Label htmlFor="brand-producer">Assigned Producer</Label>
              <Select value={form.producer_id || 'none'} onValueChange={v => setForm(f => ({ ...f, producer_id: v === 'none' ? '' : v }))}>
                <SelectTrigger id="brand-producer">
                  <SelectValue placeholder="No producer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No producer (admin-only)</SelectItem>
                  {producers.map(p => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}{p.email ? ` (${p.email})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Producers run shifts, rates, and host links for their assigned brands. One producer per brand.
              </p>
            </div>
            {/* Master-schedule color */}
            <div className="space-y-1.5">
              <Label htmlFor="brand-color">Master schedule color</Label>
              <div className="flex items-center gap-3">
                <input
                  id="brand-color"
                  type="color"
                  value={pickerHex.toLowerCase()}
                  onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                  className="h-9 w-12 cursor-pointer rounded-md border border-border bg-transparent p-1"
                  aria-label="Pick brand color"
                />
                {(() => {
                  const c = colorFromHex(pickerHex)
                  return (
                    <span
                      className="inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-semibold"
                      style={{ backgroundColor: c.bg, borderColor: c.border, color: c.text }}
                    >
                      {form.name.trim() || 'Brand'}
                    </span>
                  )
                })()}
                {form.color && (
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, color: '' }))}
                    className="text-[11px] text-primary hover:underline"
                  >
                    Reset to automatic
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {BRAND_COLORS.map(c => (
                  <button
                    key={c.bg}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, color: c.bg.toLowerCase() }))}
                    className="h-5 w-5 rounded-full border border-border ring-offset-background transition hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
                    style={{ backgroundColor: c.bg }}
                    aria-label={`Use ${c.bg}`}
                  />
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                How this brand appears on the master schedule. Leave automatic to use a palette-assigned color.
              </p>
            </div>
            {canEditRates && (
              <div className="space-y-1.5">
                <Label htmlFor="brand-rate">
                  Client Rate <span className="text-muted-foreground font-normal">($ per hour, optional)</span>
                </Label>
                <Input
                  id="brand-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={form.client_rate}
                  onChange={e => setForm(f => ({ ...f, client_rate: e.target.value }))}
                  placeholder="150"
                />
                <p className="text-[11px] text-muted-foreground">
                  What this brand pays us per hour. Used to calculate expected revenue on the dashboard. Admin-only.
                </p>
              </div>
            )}
            {canEditRates && (
              <div className="space-y-1.5">
                <Label htmlFor="brand-contracted">
                  Contracted hours / month <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="brand-contracted"
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={form.contracted_hours}
                  onChange={e => setForm(f => ({ ...f, contracted_hours: e.target.value }))}
                  placeholder="160"
                />
                <p className="text-[11px] text-muted-foreground">
                  Hours/month we contract this brand for. Drives the dashboard Fill %. Admin-only.
                </p>
              </div>
            )}
            {editingBrand ? (
              <div className="pt-2 border-t border-border">
                <BrandLogoUploader
                  brandId={editingBrand.id}
                  brandName={editingBrand.name}
                  currentPath={editingBrand.logo_path}
                  onChange={async newPath => {
                    const { data, error: updErr } = await supabase
                      .from('brands')
                      .update({ logo_path: newPath })
                      .eq('id', editingBrand.id)
                      .select(BRAND_SAFE_SELECT)
                      .single()
                    if (updErr) {
                      toast({ title: 'Error', description: updErr.message, variant: 'destructive' })
                      return
                    }
                    // RETURNING omits the column-locked pricing fields; keep them.
                    const updated = { ...editingBrand, ...(data as Brand) }
                    setEditingBrand(updated)
                    setBrands(prev => prev.map(b => b.id === editingBrand.id ? updated : b))
                    toast({ title: newPath ? 'Logo updated' : 'Logo removed' })
                  }}
                />
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">
                Add a logo after creating the brand by clicking Edit on its row.
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editingBrand ? 'Save Changes' : 'Add Brand'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Brand?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this brand. You cannot delete a brand that has streams assigned to it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteId && handleDelete(deleteId)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
