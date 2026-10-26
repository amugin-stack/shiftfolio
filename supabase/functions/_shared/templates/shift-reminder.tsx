import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { CTA, EmailLayout, styles } from './EmailLayout.tsx'
import { formatDate, formatRange, formatTimePT } from './time.ts'

// Keep in lockstep with reminderLead() in render-html.ts — that file is what
// actually ships; this one only feeds the local preview harness
// (scripts/render-emails.ts). If they drift, the preview lies.
function reminderLead(tier: string | null | undefined): { headline: string; when: string } {
  switch (tier) {
    case '48h': return { headline: 'Your shift is in 2 days', when: 'In 2 days' }
    case '24h': return { headline: 'Your shift is tomorrow',  when: 'Tomorrow' }
    default:    return { headline: 'Starting in 2 hours',     when: 'Starting in 2 hours' }
  }
}

export function subject(n: RenderableNotification): string {
  const s = n.shifts[0]
  if (!s) return `Your ${n.brand.name} shift starts soon`
  return `${reminderLead(n.body).when}: ${n.brand.name} at ${formatTimePT(s.start)}`
}

export function ShiftReminderEmail(n: RenderableNotification): React.ReactElement {
  const s = n.shifts[0]
  const ctaHref = `${n.appUrl}/my-shifts`
  const lead = reminderLead(n.body)
  const preview = s
    ? `${formatDate(s.start)} · ${n.brand.name} at ${formatTimePT(s.start)}`
    : `Your ${n.brand.name} shift starts soon`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>{lead.headline}</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, just a heads-up — here are the details for your {n.brand.name} shift.
      </Text>
      {s ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>Brand</Text>
          <Text style={styles.detailValue}>{n.brand.name}</Text>
          <Text style={{ ...styles.detailLabel, marginTop: 10 }}>When</Text>
          <Text style={styles.detailValue}>
            {formatDate(s.start)} · {formatRange(s.start, s.end)}
          </Text>
          <Text style={{ ...styles.detailLabel, marginTop: 10 }}>Role</Text>
          <Text style={styles.detailValue}>{capitalize(s.role)}</Text>
        </div>
      ) : null}
      <div style={styles.ctaWrap}>
        <CTA href={ctaHref}>Open my shifts</CTA>
      </div>
    </EmailLayout>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
