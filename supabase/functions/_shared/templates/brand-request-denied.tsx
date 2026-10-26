import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { EmailLayout, styles } from './EmailLayout.tsx'

export function subject(n: RenderableNotification): string {
  return `Update on your ${n.brand.name} request`
}

export function BrandRequestDeniedEmail(n: RenderableNotification): React.ReactElement {
  const preview = `Your request for ${n.brand.name} was not approved`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>Request not approved</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, your request for <strong>{n.brand.name}</strong> was not approved
        at this time.
      </Text>
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
