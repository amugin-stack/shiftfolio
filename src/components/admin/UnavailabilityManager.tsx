'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface Absence {
  id: string
  host_id: string | null
  moderator_id: string | null
  start_date: string
  end_date: string
}
export interface Worker { id: string; name: string; is_active: boolean }

export function UnavailabilityManager({ initialAbsences, hosts, moderators }: {
  initialAbsences: Absence[]; hosts: Worker[]; moderators: Worker[]
}) {
  const router = useRouter()
  const absences = initialAbsences
  const [role, setRole] = useState('host')
  const [workerId, setWorkerId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removeId, setRemoveId] = useState<string | null>(null)
  const hostNames = useMemo(() => new Map(hosts.map(w => [w.id, w])), [hosts])
  const moderatorNames = useMemo(() => new Map(moderators.map(w => [w.id, w])), [moderators])
  const activeHosts = useMemo(() => hosts.filter(w => w.is_active).sort((a, b) => a.name.localeCompare(b.name)), [hosts])
  const activeModerators = useMemo(() => moderators.filter(w => w.is_active).sort((a, b) => a.name.localeCompare(b.name)), [moderators])
  const roster = role === 'host' ? activeHosts : activeModerators

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(''); setNotice('')
    if (!workerId || !start || !end || end < start) {
      setError('Choose a person and valid dates. The last day must be on or after the first day.')
      return
    }
    setBusy(true)
    try {
      const { error } = await createClient().from('staff_unavailability').insert({
        host_id: role === 'host' ? workerId : null,
        moderator_id: role === 'moderator' ? workerId : null,
        start_date: start, end_date: end,
      }).select('id, host_id, moderator_id, start_date, end_date').single()
      if (error) throw new Error(error.message)
      router.refresh()
      setStart(''); setEnd('')
      setNotice('Unavailability saved. Conflicting bookings will be blocked.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save. Please try again.') }
    finally { setBusy(false) }
  }

  async function remove(id: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const { data, error } = await createClient().from('staff_unavailability').delete().eq('id', id).select('id')
      if (error) throw new Error(error.message)
      if (!data?.length) throw new Error('The absence was not removed. Refresh and check your access.')
      router.refresh()
      setRemoveId(null)
      setNotice('Unavailability removed.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to remove. Please try again.') }
    finally { setBusy(false) }
  }

  return <div className="max-w-3xl space-y-6">
    <div><h1 className="text-xl font-bold">Unavailability</h1>
      <p className="text-sm text-muted-foreground mt-2">Block dates when a host or moderator cannot work. All dates are full days in Pacific time, including the first and last day.</p>
      <p className="text-sm text-muted-foreground mt-2">Existing work must be reassigned or canceled first. If someone has both roles linked to the same account, their dates are blocked in both roles. No personal or medical reason is needed.</p>
    </div>
    <form onSubmit={save} className="rounded-lg border p-4 space-y-4">
      <fieldset disabled={busy} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="absence-role">Role</Label>
            <select id="absence-role" className="w-full rounded-md border bg-background p-2" value={role} onChange={e => { setRole(e.target.value); setWorkerId('') }}>
              <option value="host">Host</option><option value="moderator">Moderator</option>
            </select></div>
          <div className="space-y-2"><Label htmlFor="absence-worker">Person</Label>
            <select id="absence-worker" required className="w-full rounded-md border bg-background p-2" value={workerId} onChange={e => setWorkerId(e.target.value)}>
              <option value="">Choose a person</option>
              {roster.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select></div>
          <div className="space-y-2"><Label htmlFor="absence-start">First unavailable day</Label>
            <Input id="absence-start" type="date" required value={start} onChange={e => { setStart(e.target.value); if (!end || end < e.target.value) setEnd(e.target.value) }} /></div>
          <div className="space-y-2"><Label htmlFor="absence-end">Last unavailable day</Label>
            <Input id="absence-end" type="date" required min={start} value={end} onChange={e => setEnd(e.target.value)} /></div>
        </div>
        <Button type="submit">{busy ? 'Saving…' : 'Add unavailability'}</Button>
      </fieldset>
    </form>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <section aria-label="Saved unavailability" className="space-y-3">
      <h2 className="font-semibold">Current and upcoming dates</h2>
      {!absences.length && <p className="text-sm text-muted-foreground">No current or upcoming unavailable dates on this page.</p>}
      {absences.map(row => {
        const person = row.host_id ? hostNames.get(row.host_id) : moderatorNames.get(row.moderator_id ?? '')
        return <div key={row.id} className="rounded-lg border p-4 flex flex-wrap items-center justify-between gap-3">
          <div><p className="font-medium">{person?.name ?? 'Unknown person'} <span className="text-sm text-muted-foreground">({row.host_id ? 'Host' : 'Moderator'}{person && !person.is_active ? ', inactive' : ''})</span></p>
            <p className="text-sm">{row.start_date}{row.end_date !== row.start_date ? ` through ${row.end_date}` : ''} · All day PT</p></div>
          {removeId === row.id ? <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Allow bookings on these dates?</span>
            <Button disabled={busy} variant="destructive" onClick={() => remove(row.id)}>Remove dates</Button>
            <Button disabled={busy} variant="outline" onClick={() => setRemoveId(null)}>Keep dates</Button>
          </div> : <Button disabled={busy} variant="outline" onClick={() => setRemoveId(row.id)}>Remove</Button>}
        </div>
      })}
    </section>
  </div>
}
