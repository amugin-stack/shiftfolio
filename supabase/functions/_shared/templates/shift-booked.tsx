import * as React from 'react'
import { Text } from '@react-email/components'
import type { RenderableNotification } from '../types.ts'
import { CTA, EmailLayout, styles } from './EmailLayout.tsx'
import { formatDate, formatDateTimePT, formatRange, formatTimePT } from './time.ts'

export function subject(n: RenderableNotification): string {
  if (n.bulkSummary) {
    return `You're booked: ${n.bulkSummary.count} shifts on Studio`
  }
  const s = n.shifts[0]
  if (!s) return `You're booked on Studio`
  return `You're booked: ${n.brand.name} on ${formatDate(s.start)} at ${formatTimePT(s.start)}`
}

export function ShiftBookedEmail(n: RenderableNotification): React.ReactElement {
  if (n.bulkSummary) return <BulkBooked n={n} />
  return <SingleBooked n={n} />
}

function SingleBooked({ n }: { n: RenderableNotification }) {
  const s = n.shifts[0]
  const ctaHref = `${n.appUrl}/calendar/${n.brand.id}`
  const preview = s
    ? `${n.brand.name} on ${formatDate(s.start)} at ${formatTimePT(s.start)}`
    : `New shift booked on Studio`
  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>You're booked</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, you've been booked for a shift on Studio.
      </Text>
      {s ? (
        <div style={styles.detailCard}>
          <Text style={styles.detailLabel}>Brand</Text>
          <Text style={styles.detailValue}>{n.brand.name}</Text>
          <Text style={{ ...styles.detailLabel, marginTop: 10 }}>When</Text>
          <Text style={styles.detailValue}>{formatDateTimePT(s.start)}</Text>
          <Text style={{ ...styles.detailLabel, marginTop: 10 }}>Time</Text>
          <Text style={styles.detailValue}>{formatRange(s.start, s.end)}</Text>
          <Text style={{ ...styles.detailLabel, marginTop: 10 }}>Role</Text>
          <Text style={styles.detailValue}>{capitalize(s.role)}</Text>
        </div>
      ) : null}
      <div style={styles.ctaWrap}>
        <CTA href={ctaHref}>View shift</CTA>
      </div>
    </EmailLayout>
  )
}

function BulkBooked({ n }: { n: RenderableNotification }) {
  const { count, brandNames } = n.bulkSummary!
  const ctaHref = `${n.appUrl}/my-shifts`
  const preview = `${count} shifts booked across ${brandNames.length} brand${brandNames.length === 1 ? '' : 's'}`
  return (
    <EmailLayout preview={preview} appUrl={n.appUrl}>
      <Text style={styles.h1}>You're booked for {count} shifts</Text>
      <Text style={styles.p}>
        Hi {n.recipientName}, {count} new shifts have been added to your schedule across{' '}
        {formatBrandList(brandNames)}.
      </Text>
      <div style={styles.detailCard}>
        {n.shifts.map((s, i) => (
          <div
            key={`${s.start}-${i}`}
            style={i === 0 ? undefined : { borderTop: '1px solid #E5E5E5', paddingTop: 10, marginTop: 10 }}
          >
            <Text style={styles.detailLabel}>{s.brandName}</Text>
            <Text style={styles.detailValue}>{formatDate(s.start)}</Text>
            <Text style={{ ...styles.p, marginTop: 2, marginBottom: 0 }}>
              {formatRange(s.start, s.end)} · {capitalize(s.role)}
            </Text>
          </div>
        ))}
      </div>
      <div style={styles.ctaWrap}>
        <CTA href={ctaHref}>Open my shifts</CTA>
      </div>
    </EmailLayout>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatBrandList(names: string[]): string {
  if (names.length === 0) return 'your brands'
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}
