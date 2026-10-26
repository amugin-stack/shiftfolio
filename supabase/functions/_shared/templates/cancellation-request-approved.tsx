import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { EmailLayout, styles } from './EmailLayout.tsx'
import { formatDate, formatRange } from './time.ts'

export function subject(n: RenderableNotification): string {
  const s = n.shifts[0]
  if (!s) return `Cancellation approved: ${n.brand.name}`
  return `Cancellation approved: ${n.brand.name} ${formatDate(s.start)}`
}

export function CancellationRequestApprovedEmail(n: RenderableNotification): React.ReactElement {
  const s = n.shifts[0]
  const preview = s
    ? `Your ${n.brand.name} shift on ${formatDate(s.start)} was cancelled`
    : `Your cancellation request was approved`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>Cancellation approved</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, your request to cancel a <strong>{n.brand.name}</strong> shift was approved.
      </Text>
      {s ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>Cancelled shift</Text>
          <Text style={styles.detailValue}>
            {formatDate(s.start)} · {formatRange(s.start, s.end)}
          </Text>
        </div>
      ) : null}
      {n.body ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>Note from the team</Text>
          <Text style={{ ...styles.p, margin: '4px 0 0 0' }}>{n.body}</Text>
        </div>
      ) : null}
    </EmailLayout>
  )
}
