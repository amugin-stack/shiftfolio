import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { CTA, EmailLayout, styles } from './EmailLayout.tsx'
import { formatDate, formatRange } from './time.ts'

export function subject(n: RenderableNotification): string {
  const who = n.actorName ?? 'A host'
  const s = n.shifts[0]
  if (!s) return `${who} requested to cancel a ${n.brand.name} shift`
  return `${who} requested to cancel ${n.brand.name} ${formatDate(s.start)}`
}

export function CancellationRequestEmail(n: RenderableNotification): React.ReactElement {
  const who = n.actorName ?? 'A host'
  const s = n.shifts[0]
  const ctaHref = `${n.appUrl}/admin/dashboard`
  const preview = s
    ? `${who} wants to cancel ${n.brand.name} on ${formatDate(s.start)}`
    : `${who} wants to cancel a ${n.brand.name} shift`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>Cancellation requested</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, {who} has requested to cancel a <strong>{n.brand.name}</strong> shift.
      </Text>
      {s ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>Shift</Text>
          <Text style={styles.detailValue}>
            {formatDate(s.start)} · {formatRange(s.start, s.end)}
          </Text>
        </div>
      ) : null}
      {n.body ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>Reason</Text>
          <Text style={{ ...styles.p, margin: '4px 0 0 0' }}>{n.body}</Text>
        </div>
      ) : null}
      <Text style={styles.muted}>Review the request and approve or deny it from the admin dashboard.</Text>
      <div style={styles.ctaWrap}>
        <CTA href={ctaHref}>Review request</CTA>
      </div>
    </EmailLayout>
  )
}
