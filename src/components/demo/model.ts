import { buildBusyMaps } from '@/lib/bookingConflicts'
import { computeHostShiftPayoutCents } from '@/lib/payout'
import { csvEscape } from '@/lib/payrollExport'

export type Shift = { id: string; date: string; start: string; end: string; title: string; channel: string; hostId: string; moderatorId: string }
export type Draft = Omit<Shift, 'id'>
export type Person = { id: string; name: string; initials: string; role: 'Host' | 'Moderator'; rate: number; color: string }

export const PEOPLE: Person[] = [
  { id: 'mara', name: 'Mara Chen', initials: 'MC', role: 'Host', rate: 5200, color: 'lavender' },
  { id: 'jules', name: 'Jules Rivera', initials: 'JR', role: 'Host', rate: 4800, color: 'peach' },
  { id: 'devon', name: 'Devon Brooks', initials: 'DB', role: 'Host', rate: 5000, color: 'mint' },
  { id: 'nina', name: 'Nina Patel', initials: 'NP', role: 'Moderator', rate: 3400, color: 'sky' },
  { id: 'leo', name: 'Leo Park', initials: 'LP', role: 'Moderator', rate: 3200, color: 'rose' },
  { id: 'sam', name: 'Sam Okafor', initials: 'SO', role: 'Moderator', rate: 3600, color: 'amber' },
]
export const CHANNELS = [
  { name: 'Studio North', tint: 'lilac' },
  { name: 'The Edit', tint: 'blue' },
  { name: 'Field Notes', tint: 'orange' },
  { name: 'Open House', tint: 'green' },
]
const TITLES = ['Morning edition', 'Creator spotlight', 'Behind the scenes', 'Community hour', 'The weekly edit', 'Studio sessions', 'Weekend stories']
export const DEMO_WEEK = new Date('2026-10-05T12:00:00Z') // Fixed sample week for reproducible screenshots and exports.
const pad = (n: number) => String(n).padStart(2, '0')
export const keyOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
export const dateFromKey = (key: string) => new Date(`${key}T12:00:00Z`)
export const addDays = (date: Date, n: number) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + n, 12))
export const mondayOf = (date: Date) => addDays(date, -((date.getUTCDay() + 6) % 7))
export const person = (id: string) => PEOPLE.find(p => p.id === id)!
export const fmtMoney = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)
export const fmtTime = (time: string) => new Date(`2000-01-01T${time}:00`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
export const startMs = (s: Shift | Draft) => new Date(`${s.date}T${s.start}:00Z`).getTime()
export const endMs = (s: Shift | Draft) => new Date(`${s.date}T${s.end}:00Z`).getTime()
export const hoursOf = (s: Shift) => (endMs(s) - startMs(s)) / 3_600_000
export const payoutOf = (s: Shift, role: 'Host' | 'Moderator') => computeHostShiftPayoutCents(new Date(startMs(s)), new Date(endMs(s)), null, person(role === 'Host' ? s.hostId : s.moderatorId).rate).totalCents

export function seedShifts(monday: Date = DEMO_WEEK): Shift[] {
  const fixtures: Array<[number, string, string, number, number, number, number]> = [
    [0,'09:00','12:00',0,0,0,0], [0,'13:00','16:00',1,1,1,1],
    [1,'10:00','13:00',2,2,2,2], [1,'14:00','17:00',3,3,0,1],
    [2,'09:00','12:00',1,4,1,0], [2,'13:00','16:00',0,0,2,2],
    [3,'10:00','13:00',3,3,0,1], [3,'14:00','17:00',2,5,1,0],
    [4,'09:00','12:00',0,6,2,2], [4,'13:00','16:00',1,1,0,1],
    [5,'10:00','13:00',2,2,1,0], [5,'14:00','17:00',3,3,2,2],
    [6,'11:00','14:00',1,4,0,1],
  ]
  return fixtures.map(([day,start,end,channel,title,host,mod], i) => ({ id: `seed-${i}`, date: keyOf(addDays(monday, day)), start, end, channel: CHANNELS[channel].name, title: TITLES[title], hostId: PEOPLE[host].id, moderatorId: PEOPLE[mod + 3].id }))
}
export function emptyDraft(date: string): Draft { return { date, start: '09:00', end: '12:00', title: '', channel: CHANNELS[0].name, hostId: PEOPLE[0].id, moderatorId: PEOPLE[3].id } }

export function conflictFor(shifts: Shift[], draft: Draft, editing: string | null = null): string | null {
  const busy = buildBusyMaps(shifts.map(s => ({ id:s.id, hostId:s.hostId, moderatorId:s.moderatorId, startMs:startMs(s), endMs:endMs(s), brandName:s.channel })), startMs(draft), endMs(draft), editing ? [editing] : [])
  if (busy.busyHosts.has(draft.hostId)) return `${person(draft.hostId).name} is already assigned to an overlapping shift.`
  if (busy.busyMods.has(draft.moderatorId)) return `${person(draft.moderatorId).name} is already assigned to an overlapping shift.`
  return null
}

export function parseSavedShifts(raw: string | null): Shift[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length > 500) return null
    const ids = new Set<string>()
    for (const row of parsed) {
      if (!row || typeof row !== 'object') return null
      const s = row as Partial<Shift>
      if (typeof s.id !== 'string' || !s.id || ids.has(s.id) || typeof s.title !== 'string' || !s.title.trim() || s.title.length > 200) return null
      if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || Number.isNaN(Date.parse(`${s.date}T00:00:00Z`)) || keyOf(dateFromKey(s.date)) !== s.date) return null
      if (typeof s.start !== 'string' || typeof s.end !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.end)) return null
      if (endMs(s as Shift) <= startMs(s as Shift) || !CHANNELS.some(c => c.name === s.channel)) return null
      if (!PEOPLE.some(p => p.id === s.hostId && p.role === 'Host') || !PEOPLE.some(p => p.id === s.moderatorId && p.role === 'Moderator')) return null
      ids.add(s.id)
    }
    return parsed as Shift[]
  } catch { return null }
}

export function demoPayrollCsv(shifts: Shift[]): string {
  const rows = PEOPLE.map(p => {
    const mine = shifts.filter(s => s.hostId === p.id || s.moderatorId === p.id)
    return { person: p, count: mine.length, hours: mine.reduce((sum,s) => sum + hoursOf(s),0), pay: mine.reduce((sum,s) => sum + payoutOf(s,p.role),0) }
  }).filter(row => row.count > 0)
  return [
    'Name,Role,Shifts,Hours,Hourly Rate,Projected Pay',
    ...rows.map(({person:p,count,hours,pay}) => [csvEscape(p.name),p.role,count,hours.toFixed(2),(p.rate/100).toFixed(2),(pay/100).toFixed(2)].join(',')),
  ].join(String.fromCharCode(13, 10))
}
