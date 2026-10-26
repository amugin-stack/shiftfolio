import { formatInTimeZone } from 'date-fns-tz'

const APP_TZ = 'UTC'

export function formatDate(iso: string): string {
  return formatInTimeZone(new Date(iso), APP_TZ, 'EEE, MMM d')
}

export function formatDateLong(iso: string): string {
  return formatInTimeZone(new Date(iso), APP_TZ, 'EEEE, MMMM d, yyyy')
}

export function formatTime(iso: string): string {
  return formatInTimeZone(new Date(iso), APP_TZ, 'h:mm a')
}

export function formatTimePT(iso: string): string {
  return `${formatTime(iso)} PT`
}

export function formatRange(startISO: string, endISO: string): string {
  return `${formatTime(startISO)} – ${formatTime(endISO)} PT`
}

export function formatDateTimePT(iso: string): string {
  return `${formatDate(iso)} at ${formatTime(iso)} PT`
}
