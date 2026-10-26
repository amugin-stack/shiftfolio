import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { CTA, EmailLayout, styles } from './EmailLayout.tsx'
import { formatDate, formatDateTimePT, formatRange, formatTimePT } from './time.ts'

export function subject(n: RenderableNotification): string {
  const s = n.shifts[0]
  if (!s) return `Shift updated: ${n.brand.name}`
  return `Shift updated: ${n.brand.name} — now ${formatTimePT(s.start)}`
}

export function ShiftEditedEmail(n: RenderableNotification): React.ReactElement {
  const next = n.shifts[0]
  const old = n.oldShift
  const ctaHref = `${n.appUrl}/calendar/${n.brand.id}`
  const preview = next
    ? `Your ${n.brand.name} shift is now ${formatDateTimePT(next.start)}`
    : `Your ${n.brand.name} shift was updated`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>Your shift was updated</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, your {n.brand.name} shift has been edited.
      </Text>
      <div style={styles.detailCard}>
        {old ? (
          <>
            <Text style={styles.detailLabel}>Previously</Text>
            <Text style={{ ...styles.detailValue, color: '#737373', textDecoration: 'line-through' }}>
              {formatDate(old.start)} · {formatRange(old.start, old.end)}
            </Text>
          </>
        ) : null}
        {next ? (
          <>
            <Text style={{ ...styles.detailLabel, marginTop: old ? 10 : 0 }}>Now</Text>
            <Text style={styles.detailValue}>
              {formatDate(next.start)} · {formatRange(next.start, next.end)}
            </Text>
          </>
        ) : null}
      </div>
      {n.body ? <Text style={styles.muted}>Note: {n.body}</Text> : null}
      <div style={styles.ctaWrap}>
        <CTA href={ctaHref}>View shift</CTA>
      </div>
    </EmailLayout>
  )
}
