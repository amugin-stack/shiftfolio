import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { CTA, EmailLayout, styles } from './EmailLayout.tsx'

export function subject(n: RenderableNotification): string {
  return `Approved: you can now book ${n.brand.name}`
}

export function BrandRequestApprovedEmail(n: RenderableNotification): React.ReactElement {
  const ctaHref = `${n.appUrl}/calendar/${n.brand.id}`
  const preview = `Your request for ${n.brand.name} was approved`

  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>Approved</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, your request for <strong>{n.brand.name}</strong> was approved.
        You can now book shifts for this brand.
      </Text>
      {n.body ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>Note from the team</Text>
          <Text style={{ ...styles.p, margin: '4px 0 0 0' }}>{n.body}</Text>
        </div>
      ) : null}
      <div style={styles.ctaWrap}>
        <CTA href={ctaHref}>Book a shift</CTA>
      </div>
    </EmailLayout>
  )
}
