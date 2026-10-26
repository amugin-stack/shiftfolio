import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { CTA, EmailLayout, styles } from './EmailLayout.tsx'

export function subject(n: RenderableNotification): string {
  const who = n.actorName ?? 'A host'
  return `${who} requested access to ${n.brand.name}`
}

export function BrandRequestEmail(n: RenderableNotification): React.ReactElement {
  const who = n.actorName ?? 'A host'
  const ctaHref = `${n.appUrl}/admin/dashboard`
  const preview = `${who} wants to book ${n.brand.name}`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>New brand access request</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, {who} has requested access to book shifts for{' '}
        <strong>{n.brand.name}</strong>.
      </Text>
      {n.body ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>Message from {who}</Text>
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
