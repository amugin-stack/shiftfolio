'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowLeft, ArrowRight, CalendarDays, Check, ChevronDown, CircleHelp, Clock3, Command, DollarSign, LayoutGrid, Plus, RotateCcw, Search, ShieldCheck, Sparkles, Trash2, Users, X } from 'lucide-react'
import { addDays, CHANNELS, conflictFor, dateFromKey, DEMO_WEEK, demoPayrollCsv, emptyDraft, endMs, fmtMoney, fmtTime, hoursOf, keyOf, mondayOf, parseSavedShifts, payoutOf, PEOPLE, person, seedShifts, startMs, type Draft, type Person, type Shift } from './model'

type View = 'schedule' | 'payroll' | 'team'

const STORAGE_KEY = 'shiftfolio-demo-shifts-v2'
function Avatar({ who, small = false }: { who: Person; small?: boolean }) { return <span className={`sf-avatar ${who.color} ${small ? 'small' : ''}`} title={who.name}>{who.initials}</span> }

export function ShiftfolioDemo() {
  const [view, setView] = useState<View>('schedule')
  const [week, setWeek] = useState(() => DEMO_WEEK)
  const [shifts, setShifts] = useState<Shift[]>(() => seedShifts())
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState('')
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const modalReturnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    try { const saved = parseSavedShifts(localStorage.getItem(STORAGE_KEY)); if (saved) setShifts(saved) } catch { /* storage may be disabled */ }
    setLoaded(true)
  }, [])
  useEffect(() => { if (loaded) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(shifts)) } catch { /* storage may be disabled */ } } }, [shifts, loaded])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3500); return () => window.clearTimeout(timer) }, [toast])

  const dates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week])
  const weekEnd = keyOf(dates[6])
  const visible = useMemo(() => shifts.filter(s => s.date >= keyOf(week) && s.date <= weekEnd).sort((a,b) => (a.date+a.start).localeCompare(b.date+b.start)), [shifts, week, weekEnd])
  const filtered = visible.filter(s => `${s.title} ${s.channel} ${person(s.hostId).name} ${person(s.moderatorId).name}`.toLowerCase().includes(search.toLowerCase()))
  const totalHours = visible.reduce((sum,s) => sum + hoursOf(s),0)
  const totalPay = visible.reduce((sum,s) => sum + payoutOf(s,'Host') + payoutOf(s,'Moderator'),0)
  const staffed = new Set(visible.flatMap(s => [s.hostId,s.moderatorId])).size
  const weekLabel = `${dates[0].toLocaleDateString('en-US',{month:'long',day:'numeric',timeZone:'UTC'})} – ${dates[6].toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'})}`

  function openNew(date = keyOf(DEMO_WEEK)) { modalReturnFocus.current = document.activeElement as HTMLElement; setEditing(null); setDraft(emptyDraft(date)); setFormError('') }
  function openEdit(s: Shift) { modalReturnFocus.current = document.activeElement as HTMLElement; setEditing(s.id); setDraft({ date:s.date,start:s.start,end:s.end,title:s.title,channel:s.channel,hostId:s.hostId,moderatorId:s.moderatorId }); setFormError('') }
  function closeModal() { setDraft(null); requestAnimationFrame(() => modalReturnFocus.current?.focus()) }
  function save() {
    if (!draft) return
    if (!draft.title.trim()) return setFormError('Add a shift title.')
    if (!draft.date || !draft.start || !draft.end || !Number.isFinite(startMs(draft)) || !Number.isFinite(endMs(draft))) return setFormError('Choose a valid date and time.')
    if (endMs(draft) <= startMs(draft)) return setFormError('End time must be after start time.')
    const conflict = conflictFor(shifts, draft, editing)
    if (conflict) return setFormError(conflict)
    const wasEdit = Boolean(editing)
    if (editing) setShifts(prev => prev.map(s => s.id === editing ? { ...draft, title:draft.title.trim(), id:editing } : s))
    else setShifts(prev => [...prev, { ...draft, title:draft.title.trim(), id:crypto.randomUUID() }])
    setWeek(mondayOf(dateFromKey(draft.date)))
    closeModal(); setToast(wasEdit ? 'Shift updated' : 'Shift created')
  }
  function remove() { if (!editing) return; setShifts(prev => prev.filter(s => s.id !== editing)); closeModal(); setToast('Shift deleted') }
  function reset() { setShifts(seedShifts()); setWeek(DEMO_WEEK); setSearch(''); setToast('Demo restored to sample data') }
  function exportCsv() {
    const content = demoPayrollCsv(visible)
    const url = URL.createObjectURL(new Blob([content], {type:'text/csv;charset=utf-8'}))
    const link = document.createElement('a'); link.href = url; link.download = `shiftfolio-demo-payroll-${keyOf(week)}.csv`; link.click(); URL.revokeObjectURL(url)
    setToast('Sample payroll CSV downloaded')
  }

  const nav = (target: View) => { setView(target); setMobileNav(false) }
  function modalKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return }
    if (event.key !== 'Tab' || !modalRef.current) return
    const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])'))
    const first = focusable[0], last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return <div className="sf-app">
    <aside className={`sf-sidebar ${mobileNav ? 'is-open' : ''}`}>
      <div className="sf-brand"><div className="sf-brand-mark"><LayoutGrid size={19} strokeWidth={2.5}/></div><span>shiftfolio<span className="sf-brand-dot">.</span></span></div>
      <div className="sf-workspace"><span className="sf-workspace-icon">S</span><span><strong>Studio workspace</strong><small>Portfolio environment</small></span><ChevronDown size={15}/></div>
      <div className="sf-nav-label">WORKSPACE</div>
      <nav className="sf-nav" aria-label="Main navigation">
        <button className={view === 'schedule' ? 'active' : ''} onClick={() => nav('schedule')}><CalendarDays size={19}/> Schedule <span className="sf-nav-count">{visible.length}</span></button>
        <button className={view === 'payroll' ? 'active' : ''} onClick={() => nav('payroll')}><DollarSign size={19}/> Payroll</button>
        <button className={view === 'team' ? 'active' : ''} onClick={() => nav('team')}><Users size={19}/> Team</button>
      </nav>
      <div className="sf-sidebar-bottom"><div className="sf-side-tip"><Sparkles size={16}/><strong>Explore the demo</strong><p>Create a shift, adjust the team, or export a sample payroll report. Your changes stay in this browser.</p></div><button className="sf-reset" onClick={reset}><RotateCcw size={16}/> Reset demo</button><div className="sf-sidebar-user"><span className="sf-avatar navy">DE</span><span><strong>Demo explorer</strong><small>Local experience</small></span><span className="sf-online"/></div></div>
    </aside>
    <div className="sf-main">
      <header className="sf-topbar"><button className="sf-mobile-menu" aria-label="Toggle navigation" onClick={() => setMobileNav(v => !v)}><Command size={20}/></button><div className="sf-breadcrumb">Workspace <span>/</span> <strong>{view === 'schedule' ? 'Schedule' : view === 'payroll' ? 'Payroll' : 'Team'}</strong></div><div className="sf-top-actions"><span className="sf-demo-pill"><span/> SYNTHETIC DEMO DATA</span><button className="sf-help" title="All data is fictional and stored locally"><CircleHelp size={19}/></button><span className="sf-avatar navy small">DE</span></div></header>
      <main className="sf-content">
        <div className="sf-hero"><div><div className="sf-eyebrow"><span className="sf-eyebrow-line"/> THE CREATIVE OPERATIONS DESK</div><h1>{view === 'schedule' ? 'A clearer way to run the week.' : view === 'payroll' ? 'Every hour, accounted for.' : 'The people behind the work.'}</h1><p>{view === 'schedule' ? 'Plan your studio calendar, keep the right people in the right place, and make every shift count.' : view === 'payroll' ? 'A simple projection of scheduled hours and pay for this week’s example shifts.' : 'Meet the fictional crew bringing this sample schedule to life.'}</p></div><div className="sf-hero-art" aria-hidden="true"><span className="sf-orbit one"/><span className="sf-orbit two"/><span className="sf-art-card"><span className="sf-art-line"/><span className="sf-art-line short"/><span className="sf-art-dot"/></span><span className="sf-art-star">✳</span></div></div>
        <div className="sf-section-head"><div><span className="sf-section-kicker">OVERVIEW</span><h2>{view === 'team' ? 'Your sample team' : 'Week at a glance'}</h2></div><div className="sf-section-actions">{view === 'schedule' && <button className="sf-primary" onClick={() => openNew(keyOf(dates[0]))}><Plus size={18}/> New shift</button>}{view === 'payroll' && <button className="sf-primary" onClick={exportCsv}><ArrowDownToLine size={18}/> Export CSV</button>}</div></div>
        {view !== 'team' && <div className="sf-stats"><Stat icon={<CalendarDays size={20}/>} label="Scheduled shifts" value={String(visible.length).padStart(2,'0')} meta="Across 4 channels" tone="purple"/><Stat icon={<Clock3 size={20}/>} label="Total hours" value={`${totalHours.toFixed(0)}h`} meta="Live time scheduled" tone="orange"/><Stat icon={<Users size={20}/>} label="Team on schedule" value={String(staffed).padStart(2,'0')} meta="Hosts & moderators" tone="blue"/><Stat icon={<DollarSign size={20}/>} label="Projected payroll" value={fmtMoney(totalPay)} meta="For scheduled hours" tone="green"/></div>}
        {view === 'schedule' && <><div className="sf-calendar-bar"><div><span className="sf-section-kicker">CALENDAR VIEW</span><h2>{weekLabel}</h2></div><div className="sf-calendar-tools"><div className="sf-search"><Search size={16}/><input aria-label="Search shifts" placeholder="Search shifts..." value={search} onChange={e => setSearch(e.target.value)}/>{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={14}/></button>}</div><div className="sf-week-nav"><button aria-label="Previous week" onClick={() => setWeek(addDays(week,-7))}><ArrowLeft size={17}/></button><button onClick={() => setWeek(DEMO_WEEK)}>Demo week</button><button aria-label="Next week" onClick={() => setWeek(addDays(week,7))}><ArrowRight size={17}/></button></div></div></div><div className="sf-calendar"><div className="sf-days">{dates.map((date,i) => <div key={i} className={`sf-day-head ${keyOf(date) === keyOf(DEMO_WEEK) ? 'today' : ''}`}><span>{date.toLocaleDateString('en-US',{weekday:'short',timeZone:'UTC'}).toUpperCase()}</span><strong>{date.getUTCDate()}</strong></div>)}</div><div className="sf-day-columns">{dates.map((date,i) => { const dayShifts = filtered.filter(s => s.date === keyOf(date)); return <div className="sf-day-column" key={i}>{dayShifts.map(s => <button className={`sf-shift ${CHANNELS.find(c => c.name === s.channel)?.tint ?? 'lilac'}`} key={s.id} onClick={() => openEdit(s)}><span className="sf-shift-time">{fmtTime(s.start)} <span>→</span> {fmtTime(s.end)}</span><strong>{s.title}</strong><span className="sf-shift-channel">{s.channel}</span><span className="sf-shift-people"><Avatar who={person(s.hostId)} small/><Avatar who={person(s.moderatorId)} small/></span></button>)}<button className="sf-add-day" onClick={() => openNew(keyOf(date))}><Plus size={15}/> Add shift</button></div> })}</div></div><div className="sf-calendar-foot"><span><span className="sf-legend-dot purple"/> Host & moderator assigned</span><span><ShieldCheck size={16}/> Overlapping assignments are blocked automatically</span></div></>}
        {view === 'payroll' && <div className="sf-panel"><div className="sf-panel-head"><div><span className="sf-section-kicker">PAYROLL PREVIEW</span><h2>Scheduled earnings</h2><p>{weekLabel} · Example rates and assignments</p></div><span className="sf-outline-badge">SAMPLE REPORT</span></div><div className="sf-table-wrap"><table className="sf-table"><thead><tr><th>TEAM MEMBER</th><th>ROLE</th><th>SHIFTS</th><th>HOURS</th><th>HOURLY RATE</th><th>PROJECTED PAY</th></tr></thead><tbody>{PEOPLE.map(p => { const mine = visible.filter(s => s.hostId === p.id || s.moderatorId === p.id); const pay = mine.reduce((n,s) => n+payoutOf(s,p.role),0); return <tr key={p.id}><td><span className="sf-person-cell"><Avatar who={p}/><strong>{p.name}</strong></span></td><td><span className="sf-role">{p.role}</span></td><td>{mine.length}</td><td>{mine.reduce((n,s) => n+hoursOf(s),0).toFixed(1)}h</td><td>{fmtMoney(p.rate)}/hr</td><td><strong>{fmtMoney(pay)}</strong></td></tr> })}</tbody><tfoot><tr><td colSpan={3}>TOTAL PROJECTED PAYROLL</td><td>{totalHours*2}h</td><td/><td>{fmtMoney(totalPay)}</td></tr></tfoot></table></div><div className="sf-panel-note"><CircleHelp size={17}/> This is a planning estimate for fictional shifts and rates. Exported CSV contains only this demo data.</div></div>}
        {view === 'team' && <><div className="sf-team-summary"><div className="sf-team-summary-icon"><Users size={22}/></div><div><strong>6 people. One connected schedule.</strong><span>Three hosts and three moderators in this fictional workspace.</span></div></div><div className="sf-team-grid">{PEOPLE.map(p => { const mine = visible.filter(s => s.hostId === p.id || s.moderatorId === p.id); return <div className="sf-team-card" key={p.id}><div className="sf-team-top"><Avatar who={p}/><span className="sf-role">{p.role}</span></div><h3>{p.name}</h3><p>{p.role === 'Host' ? 'On-camera host' : 'Production moderator'}</p><div className="sf-team-card-foot"><span>{mine.length} shifts this week</span><strong>{fmtMoney(p.rate)}/hr</strong></div></div> })}</div></>}
        <footer className="sf-footer"><span>SHIFT FOLIO / INTERACTIVE PORTFOLIO DEMO</span><span>All names, channels, shifts and rates are fictional.</span></footer>
      </main>
    </div>
    {draft && <div className="sf-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) closeModal() }}><div className="sf-modal" role="dialog" aria-modal="true" aria-labelledby="sf-modal-title" aria-describedby="sf-modal-desc" ref={modalRef} onKeyDown={modalKeys}><div className="sf-modal-head"><div><span className="sf-section-kicker">SCHEDULE BUILDER</span><h2 id="sf-modal-title">{editing ? 'Edit shift' : 'Create a shift'}</h2><p id="sf-modal-desc">Assign a host and moderator to a sample studio session.</p></div><button className="sf-icon-button" aria-label="Close" onClick={() => closeModal()}><X size={20}/></button></div><div className="sf-form"><label>Shift title<input autoFocus value={draft.title} onChange={e => setDraft({...draft,title:e.target.value})} placeholder="e.g. Creator spotlight"/></label><label>Channel<select value={draft.channel} onChange={e => setDraft({...draft,channel:e.target.value})}>{CHANNELS.map(c => <option key={c.name}>{c.name}</option>)}</select></label><div className="sf-form-row"><label>Date<input type="date" value={draft.date} onChange={e => setDraft({...draft,date:e.target.value})}/></label><label>Starts<input type="time" value={draft.start} onChange={e => setDraft({...draft,start:e.target.value})}/></label><label>Ends<input type="time" value={draft.end} onChange={e => setDraft({...draft,end:e.target.value})}/></label></div><div className="sf-form-row two"><label>Host<select value={draft.hostId} onChange={e => setDraft({...draft,hostId:e.target.value})}>{PEOPLE.filter(p => p.role === 'Host').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Moderator<select value={draft.moderatorId} onChange={e => setDraft({...draft,moderatorId:e.target.value})}>{PEOPLE.filter(p => p.role === 'Moderator').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>{formError && <div className="sf-form-error" role="alert">{formError}</div>}</div><div className="sf-modal-actions">{editing && <button className="sf-danger" onClick={remove}><Trash2 size={16}/> Delete shift</button>}<span/><button className="sf-secondary" onClick={() => closeModal()}>Cancel</button><button className="sf-primary" onClick={save}><Check size={17}/>{editing ? 'Save changes' : 'Create shift'}</button></div></div></div>}
    {toast && <div className="sf-toast" role="status"><Check size={17}/>{toast}</div>}
  </div>
}

function Stat({icon,label,value,meta,tone}:{icon:React.ReactNode;label:string;value:string;meta:string;tone:string}) { return <div className="sf-stat"><div className={`sf-stat-icon ${tone}`}>{icon}</div><span>{label}</span><strong>{value}</strong><small>{meta}</small></div> }
