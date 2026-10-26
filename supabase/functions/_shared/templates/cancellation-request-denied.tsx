import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { EmailLayout, styles } from './EmailLayout.tsx'
import { formatDate, formatRange } from './time.ts'

export function subject(n: RenderableNotification): string {
  const s = n.shifts[0]
  if (!s) return `Cancellation denied: ${n.brand.name}`
  return `Cancellation denied: ${n.brand.name} ${formatDate(s.start)}`
}

export function CancellationRequestDeniedEmail(n: RenderableNotification): React.ReactElement {
  const s = n.shifts[0]
  const preview = s
    ? `Your cancellation request for ${n.brand.name} on ${formatDate(s.start)} was denied`
    : `Your cancellation request was denied`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>Cancellation not approved</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, your request to cancel a <strong>{n.brand.name}</strong> shift was not approved.
        The shift is still on your schedule.
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
      <Text style={styles.muted}>If you have questions, reply to this email or reach out to your admin.</Text>
    </EmailLayout>
  )
}
