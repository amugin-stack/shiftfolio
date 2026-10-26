// Pure iCalendar (.ics) generation for "add my shifts to my calendar".
// No I/O — callers pass normalized shifts and get a string back.
//
// THE TIMEZONE TRAP, which is the whole reason this is a tested module:
// under the PT-naive scheme a stream's UTC fields ARE its PT wall-clock
// (src/lib/utils.ts). So a 10:00 shift is stored as 10:00Z. Emitting that
// straight into ICS as a UTC timestamp ("20260907T100000Z") would tell the
// phone "10:00 UTC" = 03:00 PT, and every shift would show up 7-8 hours early.
//
// Correct form is the local wall-clock time tagged with a timezone:
//   DTSTART;TZID=America/Los_Angeles:20260907T100000
// which is read verbatim as 10:00 Pacific — exactly what the app displays. The
// VTIMEZONE block below defines the US Pacific DST rules so clients resolve
// that tag themselves; we never compute an offset, so there is nothing to drift
// across the March/November transitions.
//
// This produces a ONE-TIME snapshot file, not a live subscription feed. A feed
// would require a secret URL acting as a bearer credential for someone's whole
// schedule; that was considered and deliberately declined.

/** A shift as it appears to its owner. */
export interface IcsShift {
  id: string
  brandName: string
  startISO: string
  endISO: string
  /** 'host' | 'moderator' — shown so a dual-role user can tell them apart. */
  role?: string
  notes?: string | null
}

export interface IcsOptions {
  /** Shown as the calendar name in the client. */
  calendarName?: string
  /** Stable domain for UIDs. */
  uidDomain?: string
  /** DTSTAMP value; pass a fixed instant for deterministic output/tests. */
  dtstampISO?: string
}

const TZID = 'America/Los_Angeles'
const CRLF = '\r\n'

// Standard US Pacific rules. Static: clients apply them, we never compute an
// offset ourselves, which is what keeps this DST-proof.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${TZID}`,
  'X-LIC-LOCATION:America/Los_Angeles',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'TZNAME:PDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'TZNAME:PST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
]

/**
 * Format a PT-naive instant as a local ICS datetime (no trailing Z).
 * Reads the UTC fields verbatim — under this scheme they ARE the PT
 * wall-clock, so no conversion may happen here.
 */
export function toIcsLocal(iso: string): string {
  const d = new Date(iso)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  )
}

/** UTC stamp (with Z) — correct for DTSTAMP, which is a real instant. */
export function toIcsUtc(iso: string): string {
  return `${toIcsLocal(new Date(iso).toISOString())}Z`
}

/** RFC 5545 escaping for TEXT values: backslash, semicolon, comma, newlines. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n')
}

/**
 * Fold to <=75 octets per RFC 5545, continuing with CRLF + single space.
 * Measured in UTF-8 bytes, not characters — a multi-byte char split across a
 * fold boundary corrupts the file.
 */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line

  const out: string[] = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // Never split a multi-byte sequence: continuation bytes are 0b10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    out.push(bytes.subarray(start, end).toString('utf8'))
    start = end
    limit = 74 // continuation lines carry a leading space
  }
  return out.join(`${CRLF} `)
}

/** Build the full .ics document for a set of shifts. */
export function buildIcs(shifts: IcsShift[], options: IcsOptions = {}): string {
  const calendarName = options.calendarName ?? 'My Studio Shifts'
  const domain = options.uidDomain ?? 'scheduler.example.invalid'
  const dtstamp = toIcsUtc(options.dtstampISO ?? new Date().toISOString())

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Studio//Live Hub//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    `X-WR-TIMEZONE:${TZID}`,
    ...VTIMEZONE,
  ]

  for (const s of shifts) {
    const startMs = new Date(s.startISO).getTime()
    const endMs = new Date(s.endISO).getTime()
    // Skip malformed/zero-length rows rather than emitting an invalid VEVENT
    // that could make a client reject the whole file.
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue

    const roleLabel = s.role === 'moderator' ? 'Moderator' : s.role === 'host' ? 'Host' : null
    const summary = roleLabel ? `${s.brandName} (${roleLabel})` : s.brandName

    lines.push(
      'BEGIN:VEVENT',
      `UID:${s.id}@${domain}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;TZID=${TZID}:${toIcsLocal(s.startISO)}`,
      `DTEND;TZID=${TZID}:${toIcsLocal(s.endISO)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
    )
    if (s.notes) lines.push(`DESCRIPTION:${escapeIcsText(s.notes)}`)
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  return lines.map(foldIcsLine).join(CRLF) + CRLF
}

/** Filename for the download, e.g. "studio-shifts-2026-08-25.ics". */
export function icsFilename(todayISO: string): string {
  return `studio-shifts-${new Date(todayISO).toISOString().slice(0, 10)}.ics`
}
