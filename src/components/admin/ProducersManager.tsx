'use client'

import { useState } from 'react'
import { Plus, Pencil, Trash2, Link as LinkIcon } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Producer, Profile } from '@/lib/supabase/types'
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

interface ProducersManagerProps {
  initialProducers: Producer[]
  profiles: Profile[]
}

interface FormState {
  name: string
  email: string
  user_id: string
}

const EMPTY_FORM: FormState = { name: '', email: '', user_id: '' }

export function ProducersManager({ initialProducers, profiles }: ProducersManagerProps) {
  const [producers, setProducers] = useState<Producer[]>(initialProducers)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [editingProducer, setEditingProducer] = useState<Producer | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()
  const supabase = createClient()

  function openCreate() {
    setEditingProducer(null)
    setForm(EMPTY_FORM)
    setError(null)
    setDialogOpen(true)
  }

  function openEdit(producer: Producer) {
    setEditingProducer(producer)
    setForm({ name: producer.name, email: producer.email ?? '', user_id: producer.user_id ?? '' })
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

    const payload = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      user_id: form.user_id || null,
    }

    if (editingProducer) {
      const { data, error } = await supabase
        .from('producers')
        .update(payload)
        .eq('id', editingProducer.id)
        .select()
        .single()

      if (error) { setError(error.message); setSaving(false); return }
      setProducers(prev => prev.map(p => p.id === editingProducer.id ? data : p))
      toast({ title: 'Producer updated' })
    } else {
      const { data, error } = await supabase
        .from('producers')
        .insert(payload)
        .select()
        .single()

      if (error) { setError(error.message); setSaving(false); return }
      setProducers(prev => [...prev, data])
      toast({ title: 'Producer added' })
    }

    setSaving(false)
    setDialogOpen(false)
  }

  async function handleDelete(id: string) {
    const { error } = await supabase.from('producers').delete().eq('id', id)
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
    } else {
      setProducers(prev => prev.filter(p => p.id !== id))
      toast({ title: 'Producer deleted' })
    }
    setDeleteId(null)
  }

  const profileMap = new Map(profiles.map(p => [p.id, p]))

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Producers</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage stream producers and their linked accounts.</p>
        </div>
        <Button onClick={openCreate} size="sm" className="gap-2">
          <Plus className="w-4 h-4" />
          Add Producer
        </Button>
      </div>

      {producers.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">No producers yet. Add your first producer to get started.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Name</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Email</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Linked User</th>
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {producers.map((producer, i) => {
                const linkedProfile = producer.user_id ? profileMap.get(producer.user_id) : null
                return (
                  <tr key={producer.id} className={`border-b border-border last:border-0 ${i % 2 === 0 ? '' : 'bg-secondary/20'}`}>
                    <td className="px-4 py-3 font-medium text-foreground">{producer.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{producer.email || '—'}</td>
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
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => openEdit(producer)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-destructive hover:text-destructive"
                          onClick={() => setDeleteId(producer.id)}
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
            <DialogTitle>{editingProducer ? 'Edit Producer' : 'Add Producer'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="producer-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="producer-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Producer name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="producer-email">
                Email <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="producer-email"
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="producer@example.invalid"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="producer-user">Linked Profile</Label>
              <Select value={form.user_id} onValueChange={v => setForm(f => ({ ...f, user_id: v === 'none' ? '' : v }))}>
                <SelectTrigger id="producer-user">
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
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editingProducer ? 'Save Changes' : 'Add Producer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Producer?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this producer. You cannot delete a producer that has streams assigned to them.
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
