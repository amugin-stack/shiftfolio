/**
 * Visual test harness for the email templates.
 *
 * Renders each `RenderableNotification` variant to HTML and writes the files
 * to `/tmp/studio-email-preview/`. Open the index for a directory listing, or
 * load individual files in a browser for visual QA.
 *
 * Run: `npx tsx scripts/render-emails.ts`
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { renderEmail } from '../supabase/functions/_shared/templates/index.ts'
import type { RenderableNotification } from '../supabase/functions/_shared/types.ts'

const OUT_DIR = '/tmp/studio-email-preview'
const APP_URL = 'https://scheduler.example.invalid'

// ISO PT-naive UTC strings (UTC fields ARE the PT wall-clock — see APP_TIMEZONE convention).
const today = '2026-05-14'
const tomorrow = '2026-05-15'
const dayAfter = '2026-05-16'

const fixtures: Array<{ name: string; n: RenderableNotification }> = [
  // shift_booked — single
  {
    name: 'shift_booked__single',
    n: {
      type: 'shift_booked',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [
        { start: `${tomorrow}T15:00:00.000Z`, end: `${tomorrow}T17:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      appUrl: APP_URL,
    },
  },
  // shift_booked — bulk across brands
  {
    name: 'shift_booked__bulk_multi_brand',
    n: {
      type: 'shift_booked',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [
        { start: `${tomorrow}T10:00:00.000Z`, end: `${tomorrow}T12:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
        { start: `${tomorrow}T14:00:00.000Z`, end: `${tomorrow}T16:00:00.000Z`, role: 'host', brandName: 'Lumen Skincare' },
        { start: `${dayAfter}T09:00:00.000Z`, end: `${dayAfter}T11:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      appUrl: APP_URL,
      bulkSummary: { count: 3, brandNames: ['Acme Apparel', 'Lumen Skincare'] },
    },
  },
  // shift_booked — bulk single brand
  {
    name: 'shift_booked__bulk_single_brand',
    n: {
      type: 'shift_booked',
      recipientName: 'Morgan Chen',
      recipientRole: 'moderator',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [
        { start: `${tomorrow}T09:00:00.000Z`, end: `${tomorrow}T11:00:00.000Z`, role: 'moderator', brandName: 'Acme Apparel' },
        { start: `${tomorrow}T13:00:00.000Z`, end: `${tomorrow}T15:00:00.000Z`, role: 'moderator', brandName: 'Acme Apparel' },
        { start: `${dayAfter}T10:00:00.000Z`, end: `${dayAfter}T12:00:00.000Z`, role: 'moderator', brandName: 'Acme Apparel' },
        { start: `${dayAfter}T14:00:00.000Z`, end: `${dayAfter}T16:00:00.000Z`, role: 'moderator', brandName: 'Acme Apparel' },
        { start: `${dayAfter}T18:00:00.000Z`, end: `${dayAfter}T20:00:00.000Z`, role: 'moderator', brandName: 'Acme Apparel' },
      ],
      appUrl: APP_URL,
      bulkSummary: { count: 5, brandNames: ['Acme Apparel'] },
    },
  },

  // shift_edited
  {
    name: 'shift_edited__time_changed_with_note',
    n: {
      type: 'shift_edited',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [
        { start: `${tomorrow}T17:00:00.000Z`, end: `${tomorrow}T19:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      oldShift: { start: `${tomorrow}T15:00:00.000Z`, end: `${tomorrow}T17:00:00.000Z` },
      body: 'Pushed back to accommodate a brand call.',
      appUrl: APP_URL,
    },
  },
  {
    name: 'shift_edited__time_changed_no_note',
    n: {
      type: 'shift_edited',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [
        { start: `${dayAfter}T14:00:00.000Z`, end: `${dayAfter}T16:00:00.000Z`, role: 'host', brandName: 'Lumen Skincare' },
      ],
      oldShift: { start: `${dayAfter}T13:00:00.000Z`, end: `${dayAfter}T15:00:00.000Z` },
      appUrl: APP_URL,
    },
  },

  // shift_cancelled
  {
    name: 'shift_cancelled__with_reason',
    n: {
      type: 'shift_cancelled',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [
        { start: `${tomorrow}T15:00:00.000Z`, end: `${tomorrow}T17:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      body: 'Brand cancelled the slot.',
      appUrl: APP_URL,
    },
  },
  {
    name: 'shift_cancelled__no_reason',
    n: {
      type: 'shift_cancelled',
      recipientName: 'Morgan Chen',
      recipientRole: 'moderator',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [
        { start: `${tomorrow}T18:00:00.000Z`, end: `${tomorrow}T20:00:00.000Z`, role: 'moderator', brandName: 'Lumen Skincare' },
      ],
      appUrl: APP_URL,
    },
  },

  // shift_reminder — one fixture per tier (migration 076). The tier travels in
  // `body`; the no-body fixture is what every row written before 076 looks
  // like, and since the only emitter back then was the 2-hour cron, it must
  // render the 2-hour wording.
  //
  // Note the spans: reminders describe a whole ARRIVAL (first block start to
  // last block end), not one calendar block, so these are deliberately
  // multi-hour.
  {
    name: 'shift_reminder__2h_host',
    n: {
      type: 'shift_reminder',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      body: '2h',
      shifts: [
        { start: `${today}T15:00:00.000Z`, end: `${today}T19:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      appUrl: APP_URL,
    },
  },
  {
    name: 'shift_reminder__24h_moderator',
    n: {
      type: 'shift_reminder',
      recipientName: 'Morgan Chen',
      recipientRole: 'moderator',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      body: '24h',
      shifts: [
        { start: `${tomorrow}T18:00:00.000Z`, end: `${tomorrow}T22:00:00.000Z`, role: 'moderator', brandName: 'Lumen Skincare' },
      ],
      appUrl: APP_URL,
    },
  },
  {
    name: 'shift_reminder__48h_host',
    n: {
      type: 'shift_reminder',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      body: '48h',
      shifts: [
        { start: `${today}T15:00:00.000Z`, end: `${today}T18:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      appUrl: APP_URL,
    },
  },
  {
    name: 'shift_reminder__legacy_no_tier_is_2h',
    n: {
      type: 'shift_reminder',
      recipientName: 'Morgan Chen',
      recipientRole: 'moderator',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [
        { start: `${today}T18:00:00.000Z`, end: `${today}T20:00:00.000Z`, role: 'moderator', brandName: 'Lumen Skincare' },
      ],
      appUrl: APP_URL,
    },
  },

  // brand_request
  {
    name: 'brand_request__with_message',
    n: {
      type: 'brand_request',
      recipientName: 'Pat Admin',
      recipientRole: 'producer',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [],
      actorName: 'Jamie Rivera',
      body: "I've worked with similar SKUs before and have open availability this month.",
      appUrl: APP_URL,
    },
  },
  {
    name: 'brand_request__no_message',
    n: {
      type: 'brand_request',
      recipientName: 'Pat Admin',
      recipientRole: 'producer',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [],
      actorName: 'Morgan Chen',
      appUrl: APP_URL,
    },
  },

  // brand_request_approved
  {
    name: 'brand_request_approved__with_note',
    n: {
      type: 'brand_request_approved',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [],
      body: 'Welcome aboard — please review the brand guidelines before your first stream.',
      appUrl: APP_URL,
    },
  },
  {
    name: 'brand_request_approved__no_note',
    n: {
      type: 'brand_request_approved',
      recipientName: 'Morgan Chen',
      recipientRole: 'moderator',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [],
      appUrl: APP_URL,
    },
  },

  // brand_request_denied
  {
    name: 'brand_request_denied__with_reason',
    n: {
      type: 'brand_request_denied',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [],
      body: 'No open capacity for new hosts on this brand right now — we will reach out when that changes.',
      appUrl: APP_URL,
    },
  },
  {
    name: 'brand_request_denied__no_reason',
    n: {
      type: 'brand_request_denied',
      recipientName: 'Morgan Chen',
      recipientRole: 'moderator',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [],
      appUrl: APP_URL,
    },
  },

  // cancellation_request
  {
    name: 'cancellation_request__with_reason',
    n: {
      type: 'cancellation_request',
      recipientName: 'Pat Admin',
      recipientRole: 'producer',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [
        { start: `${tomorrow}T15:00:00.000Z`, end: `${tomorrow}T17:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      actorName: 'Jamie Rivera',
      body: 'Family emergency — sorry for the late notice.',
      appUrl: APP_URL,
    },
  },
  {
    name: 'cancellation_request__no_reason',
    n: {
      type: 'cancellation_request',
      recipientName: 'Pat Admin',
      recipientRole: 'producer',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [
        { start: `${dayAfter}T18:00:00.000Z`, end: `${dayAfter}T20:00:00.000Z`, role: 'moderator', brandName: 'Lumen Skincare' },
      ],
      actorName: 'Morgan Chen',
      appUrl: APP_URL,
    },
  },

  // cancellation_request_approved
  {
    name: 'cancellation_request_approved__with_note',
    n: {
      type: 'cancellation_request_approved',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [
        { start: `${tomorrow}T15:00:00.000Z`, end: `${tomorrow}T17:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      body: 'No worries — take care of yourself.',
      appUrl: APP_URL,
    },
  },
  {
    name: 'cancellation_request_approved__no_note',
    n: {
      type: 'cancellation_request_approved',
      recipientName: 'Morgan Chen',
      recipientRole: 'moderator',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [
        { start: `${dayAfter}T18:00:00.000Z`, end: `${dayAfter}T20:00:00.000Z`, role: 'moderator', brandName: 'Lumen Skincare' },
      ],
      appUrl: APP_URL,
    },
  },

  // cancellation_request_denied
  {
    name: 'cancellation_request_denied__with_reason',
    n: {
      type: 'cancellation_request_denied',
      recipientName: 'Jamie Rivera',
      recipientRole: 'host',
      brand: { name: 'Acme Apparel', id: 'brand-acme' },
      shifts: [
        { start: `${tomorrow}T15:00:00.000Z`, end: `${tomorrow}T17:00:00.000Z`, role: 'host', brandName: 'Acme Apparel' },
      ],
      body: 'Too close to the slot — please find a replacement host before we can cancel.',
      appUrl: APP_URL,
    },
  },
  {
    name: 'cancellation_request_denied__no_reason',
    n: {
      type: 'cancellation_request_denied',
      recipientName: 'Morgan Chen',
      recipientRole: 'moderator',
      brand: { name: 'Lumen Skincare', id: 'brand-lumen' },
      shifts: [
        { start: `${dayAfter}T18:00:00.000Z`, end: `${dayAfter}T20:00:00.000Z`, role: 'moderator', brandName: 'Lumen Skincare' },
      ],
      appUrl: APP_URL,
    },
  },
]

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const indexRows: string[] = []

  for (const f of fixtures) {
    const { subject, html } = await renderEmail(f.n)
    const file = `${f.name}.html`
    writeFileSync(join(OUT_DIR, file), html, 'utf8')
    indexRows.push(
      `<li><a href="./${file}"><code>${f.name}</code></a> — <span style="color:#555">${escapeHtml(subject)}</span></li>`,
    )
    console.log(`✓ ${f.name}`)
    console.log(`    subject: ${subject}`)
  }

  const indexHtml = [
    '<!doctype html><html><head><meta charset="utf-8"><title>Studio email preview</title>',
    '<style>body{font-family:system-ui,sans-serif;padding:24px;color:#171717;max-width:720px;margin:0 auto}',
    'h1{font-size:20px}ul{padding-left:0;list-style:none}li{padding:6px 0;border-bottom:1px solid #eee}',
    'code{background:#FAFAFA;border:1px solid #E5E5E5;padding:2px 6px;border-radius:4px;font-size:13px}',
    'a{color:#FF4433;text-decoration:none}a:hover{text-decoration:underline}</style></head><body>',
    `<h1>Studio email preview · ${fixtures.length} fixtures</h1>`,
    '<ul>',
    ...indexRows,
    '</ul></body></html>',
  ].join('\n')
  writeFileSync(join(OUT_DIR, 'index.html'), indexHtml, 'utf8')

  console.log(`\nWrote ${fixtures.length} previews to ${OUT_DIR}`)
  console.log(`Open: file://${join(OUT_DIR, 'index.html')}`)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
