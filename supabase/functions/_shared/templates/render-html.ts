/**
 * String-based HTML renderer for transactional emails.
 *
 * Replaces the React Email pipeline for the Edge Function. Same branded look
 * (logo, #FF4433 accent, detail cards, CTA buttons), but pure string
 * concatenation — zero React, zero JSX, zero Deno/npm interop concerns.
 *
 * Agent2's TSX templates in this directory remain in the repo as reference
 * (and for the local `scripts/render-emails.ts` preview tool which runs in
 * Node where React works fine). Only the Edge Function uses this renderer.
 */

import type { RenderableNotification, RenderEmail } from '../types.ts'

// ---------------------------------------------------------------------------
// Theme — mirrors agent2's EmailLayout.brand object
// ---------------------------------------------------------------------------

const BRAND = {
  bg: '#FAFAFA',
  card: '#FFFFFF',
  text: '#171717',
  muted: '#737373',
  border: '#E5E5E5',
  primary: '#FF4433',
  primaryText: '#FFFFFF',
} as const

const LOGO_URL = 'https://scheduler.example.invalid/Studio-Gradient-Icon.png'
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

// ---------------------------------------------------------------------------
// Date / time helpers (PT, matching agent2's templates/time.ts)
// ---------------------------------------------------------------------------

const APP_TZ = 'UTC' // app stores PT-wall-clock as naive UTC; format in UTC reads as PT

function formatPT(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: APP_TZ }).format(new Date(iso))
}
function formatDate(iso: string): string {
  return formatPT(iso, { weekday: 'short', month: 'short', day: 'numeric' })
}
function formatTime(iso: string): string {
  return formatPT(iso, { hour: 'numeric', minute: '2-digit', hour12: true })
}
function formatTimePT(iso: string): string { return `${formatTime(iso)} PT` }
function formatRange(start: string, end: string): string {
  return `${formatTime(start)} – ${formatTime(end)} PT`
}
function formatDateTimePT(iso: string): string {
  return `${formatDate(iso)} at ${formatTime(iso)} PT`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatBrandList(names: string[]): string {
  if (names.length === 0) return 'your brands'
  if (names.length === 1) return escapeHtml(names[0])
  if (names.length === 2) return `${escapeHtml(names[0])} and ${escapeHtml(names[1])}`
  return `${names.slice(0, -1).map(escapeHtml).join(', ')}, and ${escapeHtml(names[names.length - 1])}`
}

// ---------------------------------------------------------------------------
// HTML primitives
// ---------------------------------------------------------------------------

function layout(opts: { preview: string; appUrl: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@media (prefers-color-scheme: dark) { body { background: ${BRAND.bg} !important; } }
</style>
</head>
<body style="margin:0;padding:24px 0;background:${BRAND.bg};color:${BRAND.text};font-family:${FONT};">
<!-- preheader -->
<div style="display:none;font-size:1px;color:#fefefe;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
${escapeHtml(opts.preview)}
</div>
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:6px;max-width:560px;width:100%;border-collapse:separate;">
  <tr><td style="padding:24px 32px 8px 32px;">
    <img src="${LOGO_URL}" alt="Studio" width="32" height="32" style="display:block;height:32px;width:32px;">
  </td></tr>
  <tr><td style="padding:8px 32px 24px 32px;">
${opts.body}
  </td></tr>
  <tr><td style="padding:0;">
    <div style="border-top:1px solid ${BRAND.border};margin:0 32px;"></div>
  </td></tr>
  <tr><td style="padding:16px 32px 24px 32px;">
    <p style="color:${BRAND.muted};font-size:12px;line-height:18px;margin:0;">
      You're receiving this because you have a Studio scheduler account.
      <a href="${escapeHtml(opts.appUrl)}" style="color:${BRAND.muted};text-decoration:underline;">Open Studio</a>
    </p>
  </td></tr>
</table>
</body>
</html>`
}

function h1(text: string): string {
  return `<h1 style="color:${BRAND.text};font-size:22px;font-weight:700;line-height:28px;margin:0 0 12px 0;">${escapeHtml(text)}</h1>`
}

function p(text: string, opts: { html?: boolean } = {}): string {
  const content = opts.html ? text : escapeHtml(text)
  return `<p style="color:${BRAND.text};font-size:15px;line-height:22px;margin:0 0 12px 0;">${content}</p>`
}

function muted(text: string): string {
  return `<p style="color:${BRAND.muted};font-size:13px;line-height:20px;margin:0 0 12px 0;">${escapeHtml(text)}</p>`
}

function cta(href: string, label: string): string {
  return `<div style="margin:4px 0 16px 0;">
  <a href="${escapeHtml(href)}" style="display:inline-block;background:${BRAND.primary};color:${BRAND.primaryText};text-decoration:none;font-size:14px;font-weight:600;line-height:20px;padding:10px 18px;border-radius:6px;text-align:center;">${escapeHtml(label)}</a>
</div>`
}

function detailRow(label: string, value: string, opts: { strike?: boolean; first?: boolean } = {}): string {
  const labelStyle = `color:${BRAND.muted};font-size:11px;font-weight:600;letter-spacing:0.4px;margin:${opts.first ? 0 : 10}px 0 0 0;text-transform:uppercase;`
  const valueStyle = `color:${opts.strike ? BRAND.muted : BRAND.text};font-size:15px;font-weight:600;line-height:22px;margin:2px 0 0 0;${opts.strike ? 'text-decoration:line-through;' : ''}`
  return `<p style="${labelStyle}">${escapeHtml(label)}</p>
<p style="${valueStyle}">${escapeHtml(value)}</p>`
}

function detailCard(inner: string): string {
  return `<div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:6px;padding:12px 16px;margin:12px 0 16px 0;">
${inner}
</div>`
}

// ---------------------------------------------------------------------------
// Per-type renderers
// ---------------------------------------------------------------------------

function renderShiftBooked(n: RenderableNotification): { subject: string; html: string } {
  if (n.bulkSummary) return renderShiftBookedBulk(n)
  const s = n.shifts[0]
  const subject = s
    ? `You're booked: ${n.brand.name} on ${formatDate(s.start)} at ${formatTimePT(s.start)}`
    : `You're booked on Studio`
  const preview = s
    ? `${n.brand.name} on ${formatDate(s.start)} at ${formatTimePT(s.start)}`
    : `New shift booked on Studio`
  const ctaHref = `${n.appUrl}/calendar/${n.brand.id}`
  const card = s
    ? detailCard([
        detailRow('Brand', n.brand.name, { first: true }),
        detailRow('When', formatDateTimePT(s.start)),
        detailRow('Time', formatRange(s.start, s.end)),
        detailRow('Role', capitalize(s.role)),
      ].join('\n'))
    : ''
  const body = [
    h1(`You're booked`),
    p(`Hi ${n.recipientName}, you've been booked for a shift on Studio.`),
    card,
    cta(ctaHref, 'View shift'),
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderShiftBookedBulk(n: RenderableNotification): { subject: string; html: string } {
  const { count, brandNames } = n.bulkSummary!
  const subject = `You're booked: ${count} shifts on Studio`
  const preview = `${count} shifts booked across ${brandNames.length} brand${brandNames.length === 1 ? '' : 's'}`
  const ctaHref = `${n.appUrl}/my-shifts`
  const rows = n.shifts.map((s, i) => {
    const sep = i === 0 ? '' : 'border-top:1px solid #E5E5E5;padding-top:10px;margin-top:10px;'
    return `<div style="${sep}">
${detailRow(s.brandName, formatDate(s.start), { first: true })}
<p style="color:${BRAND.text};font-size:15px;line-height:22px;margin:2px 0 0 0;">${escapeHtml(formatRange(s.start, s.end))} · ${escapeHtml(capitalize(s.role))}</p>
</div>`
  }).join('\n')
  const body = [
    h1(`You're booked for ${count} shifts`),
    p(`Hi ${n.recipientName}, ${count} new shifts have been added to your schedule across ${formatBrandList(brandNames)}.`, { html: true }),
    detailCard(rows),
    cta(ctaHref, 'Open my shifts'),
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderShiftEdited(n: RenderableNotification): { subject: string; html: string } {
  const next = n.shifts[0]
  const old = n.oldShift
  const subject = next
    ? `Shift updated: ${n.brand.name} — now ${formatTimePT(next.start)}`
    : `Shift updated: ${n.brand.name}`
  const preview = next
    ? `Your ${n.brand.name} shift is now ${formatDateTimePT(next.start)}`
    : `Your ${n.brand.name} shift was updated`
  const ctaHref = `${n.appUrl}/calendar/${n.brand.id}`
  const oldRow = old ? detailRow('Previously', `${formatDate(old.start)} · ${formatRange(old.start, old.end)}`, { strike: true, first: true }) : ''
  const newRow = next ? detailRow('Now', `${formatDate(next.start)} · ${formatRange(next.start, next.end)}`, { first: !old }) : ''
  const card = (oldRow || newRow) ? detailCard([oldRow, newRow].filter(Boolean).join('\n')) : ''
  const note = n.body ? muted(`Note: ${n.body}`) : ''
  const body = [h1('Your shift was updated'), p(`Hi ${n.recipientName}, your ${n.brand.name} shift has been edited.`), card, note, cta(ctaHref, 'View shift')].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderShiftCancelled(n: RenderableNotification): { subject: string; html: string } {
  const s = n.shifts[0]
  const subject = s ? `Cancelled: ${n.brand.name} on ${formatDate(s.start)}` : `Cancelled: ${n.brand.name}`
  const preview = s ? `Your ${n.brand.name} shift on ${formatDate(s.start)} was cancelled` : `Your ${n.brand.name} shift was cancelled`
  const card = s ? detailCard(detailRow('When', `${formatDate(s.start)} · ${formatRange(s.start, s.end)}`, { first: true })) : ''
  const reason = n.body ? muted(`Reason: ${n.body}`) : ''
  const body = [h1('Your shift was cancelled'), p(`Hi ${n.recipientName}, your ${n.brand.name} shift has been cancelled.`), card, reason].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

// Reminder tiers (migration 076). The tier travels in notification.body, which
// this template does not otherwise use — that keeps notifications.type at its
// existing ten values, so the CHECK constraint, the type union, the dispatcher
// below and the in-app bell all stay untouched.
//
// Rows written before 076 carry no tier, and every one of them is a 2-hour
// reminder — that was the only emitter. So the fallback IS the 2h wording, not
// something vaguer. That makes the deploy order free: this can ship before or
// after 077 without any in-flight reminder losing its wording.
function reminderLead(tier: string | null | undefined): { headline: string; when: string } {
  switch (tier) {
    case '48h': return { headline: 'Your shift is in 2 days', when: 'In 2 days' }
    case '24h': return { headline: 'Your shift is tomorrow',  when: 'Tomorrow' }
    default:    return { headline: 'Starting in 2 hours',     when: 'Starting in 2 hours' }
  }
}

function renderShiftReminder(n: RenderableNotification): { subject: string; html: string } {
  const s = n.shifts[0]
  const lead = n.reminderMode
    ? { headline: n.reminderMode === 'corrected' ? 'Your shift details changed' : n.reminderMode === 'late' ? 'A reminder about your upcoming shift' : 'Your upcoming shift',
        when: n.reminderMode === 'corrected' ? 'Updated shift' : 'Shift reminder' }
    : reminderLead(n.body)
  const subject = s ? `${lead.when}: ${n.brand.name} at ${formatTimePT(s.start)}` : `Your ${n.brand.name} shift starts soon`
  const preview = s ? `${formatDate(s.start)} · ${n.brand.name} at ${formatTimePT(s.start)}` : `Your ${n.brand.name} shift starts soon`
  const ctaHref = `${n.appUrl}/my-shifts`
  const card = s ? detailCard([
    detailRow('Brand', n.brand.name, { first: true }),
    detailRow('When', `${formatDate(s.start)} · ${formatRange(s.start, s.end)}`),
    detailRow('Role', capitalize(s.role)),
  ].join('\n')) : ''
  const body = [
    h1(lead.headline),
    p(`Hi ${n.recipientName}, just a heads-up — here are the details for your ${n.brand.name} shift.`),
    n.reminderMode === 'scheduled' ? p('If delivery of this reminder was delayed, please use the scheduled date and time below.') : '',
    n.reminderMode === 'late' ? p('This reminder was delayed. The current date and time for your shift are shown below.') : '',
    n.reminderMode === 'corrected' ? p('Please use these updated details in place of the earlier reminder.') : '',
    card,
    cta(ctaHref, 'Open my shifts'),
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderBrandRequest(n: RenderableNotification): { subject: string; html: string } {
  const who = n.actorName ?? 'A host'
  const subject = `${who} requested access to ${n.brand.name}`
  const preview = `${who} wants to book ${n.brand.name}`
  const ctaHref = `${n.appUrl}/admin/dashboard`
  const message = n.body
    ? detailCard(detailRow(`Message from ${who}`, n.body, { first: true }))
    : ''
  const body = [
    h1('New brand access request'),
    p(`Hi ${n.recipientName}, ${who} has requested access to book shifts for ${n.brand.name}.`),
    message,
    muted('Review the request and approve or deny it from the admin dashboard.'),
    cta(ctaHref, 'Review request'),
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderBrandRequestApproved(n: RenderableNotification): { subject: string; html: string } {
  const subject = `Approved: you can now book ${n.brand.name}`
  const preview = `Your request for ${n.brand.name} was approved`
  const ctaHref = `${n.appUrl}/calendar/${n.brand.id}`
  const note = n.body ? detailCard(detailRow('Note from the team', n.body, { first: true })) : ''
  const body = [
    h1('Approved'),
    p(`Hi ${n.recipientName}, your request for ${n.brand.name} was approved. You can now book shifts for this brand.`),
    note,
    cta(ctaHref, 'Book a shift'),
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderBrandRequestDenied(n: RenderableNotification): { subject: string; html: string } {
  const subject = `Update on your ${n.brand.name} request`
  const preview = `Your request for ${n.brand.name} was not approved`
  const reason = n.body ? detailCard(detailRow('Reason', n.body, { first: true })) : ''
  const body = [
    h1('Request not approved'),
    p(`Hi ${n.recipientName}, your request for ${n.brand.name} was not approved at this time.`),
    reason,
    muted('If you have questions, reply to this email or reach out to your admin.'),
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderCancellationRequest(n: RenderableNotification): { subject: string; html: string } {
  const who = n.actorName ?? 'A host'
  const s = n.shifts[0]
  const subject = s
    ? `${who} requested to cancel ${n.brand.name} ${formatDate(s.start)}`
    : `${who} requested to cancel a ${n.brand.name} shift`
  const preview = s ? `${who} wants to cancel ${n.brand.name} on ${formatDate(s.start)}` : `${who} wants to cancel a ${n.brand.name} shift`
  const ctaHref = `${n.appUrl}/admin/dashboard`
  const shiftCard = s ? detailCard(detailRow('Shift', `${formatDate(s.start)} · ${formatRange(s.start, s.end)}`, { first: true })) : ''
  const reasonCard = n.body ? detailCard(detailRow('Reason', n.body, { first: true })) : ''
  const body = [
    h1('Cancellation requested'),
    p(`Hi ${n.recipientName}, ${who} has requested to cancel a ${n.brand.name} shift.`),
    shiftCard,
    reasonCard,
    muted('Review the request and approve or deny it from the admin dashboard.'),
    cta(ctaHref, 'Review request'),
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderCancellationRequestApproved(n: RenderableNotification): { subject: string; html: string } {
  const s = n.shifts[0]
  const subject = s ? `Cancellation approved: ${n.brand.name} ${formatDate(s.start)}` : `Cancellation approved: ${n.brand.name}`
  const preview = s ? `Your ${n.brand.name} shift on ${formatDate(s.start)} was cancelled` : `Your cancellation request was approved`
  const shiftCard = s ? detailCard(detailRow('Cancelled shift', `${formatDate(s.start)} · ${formatRange(s.start, s.end)}`, { first: true })) : ''
  const note = n.body ? detailCard(detailRow('Note from the team', n.body, { first: true })) : ''
  const body = [
    h1('Cancellation approved'),
    p(`Hi ${n.recipientName}, your request to cancel a ${n.brand.name} shift was approved.`),
    shiftCard,
    note,
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

function renderCancellationRequestDenied(n: RenderableNotification): { subject: string; html: string } {
  const s = n.shifts[0]
  const subject = s ? `Cancellation denied: ${n.brand.name} ${formatDate(s.start)}` : `Cancellation denied: ${n.brand.name}`
  const preview = s ? `Your cancellation request for ${n.brand.name} on ${formatDate(s.start)} was denied` : `Your cancellation request was denied`
  const shiftCard = s ? detailCard(detailRow('Shift', `${formatDate(s.start)} · ${formatRange(s.start, s.end)}`, { first: true })) : ''
  const reason = n.body ? detailCard(detailRow('Reason', n.body, { first: true })) : ''
  const body = [
    h1('Cancellation not approved'),
    p(`Hi ${n.recipientName}, your request to cancel a ${n.brand.name} shift was not approved. The shift is still on your schedule.`),
    shiftCard,
    reason,
    muted('If you have questions, reply to this email or reach out to your admin.'),
  ].join('\n')
  return { subject, html: layout({ preview, appUrl: n.appUrl, body }) }
}

// ---------------------------------------------------------------------------
// Dispatcher — same signature as agent2's renderEmail, async-compatible
// ---------------------------------------------------------------------------

export const renderEmailHtml: RenderEmail = async (n) => {
  switch (n.type) {
    case 'shift_booked': return renderShiftBooked(n)
    case 'shift_edited': return renderShiftEdited(n)
    case 'shift_cancelled': return renderShiftCancelled(n)
    case 'shift_reminder': return renderShiftReminder(n)
    case 'reminder_delivery_alert': return {
      subject: 'Studio reminder delivery needs attention',
      html: layout({ preview: 'Please review reminder delivery', appUrl: n.appUrl, body: [
        h1('Reminder delivery update'), p(`Hi ${n.recipientName}, ${n.body ?? 'Please review reminder delivery.'}`),
        cta(`${n.appUrl}/admin/dashboard`, 'Open Studio'),
      ].join('\n') }),
    }
    case 'brand_request': return renderBrandRequest(n)
    case 'brand_request_approved': return renderBrandRequestApproved(n)
    case 'brand_request_denied': return renderBrandRequestDenied(n)
    case 'cancellation_request': return renderCancellationRequest(n)
    case 'cancellation_request_approved': return renderCancellationRequestApproved(n)
    case 'cancellation_request_denied': return renderCancellationRequestDenied(n)
    default: {
      const _exhaustive: never = n.type
      throw new Error(`Unknown notification type: ${_exhaustive as string}`)
    }
  }
}
