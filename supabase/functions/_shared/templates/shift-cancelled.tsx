import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { EmailLayout, styles } from './EmailLayout.tsx'
import { formatDate, formatRange } from './time.ts'

export function subject(n: RenderableNotification): string {
  const s = n.shifts[0]
  if (!s) return `Cancelled: ${n.brand.name}`
  return `Cancelled: ${n.brand.name} on ${formatDate(s.start)}`
}

export function ShiftCancelledEmail(n: RenderableNotification): React.ReactElement {
  const s = n.shifts[0]
  const preview = s
    ? `Your ${n.brand.name} shift on ${formatDate(s.start)} was cancelled`
    : `Your ${n.brand.name} shift was cancelled`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>Your shift was cancelled</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, your {n.brand.name} shift has been cancelled.
      </Text>
      {s ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>When</Text>
          <Text style={styles.detailValue}>
            {formatDate(s.start)} · {formatRange(s.start, s.end)}
          </Text>
        </div>
      ) : null}
      {n.body ? <Text style={styles.muted}>Reason: {n.body}</Text> : null}
    </EmailLayout>
  )
}
