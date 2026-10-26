import { describe, expect, it } from 'vitest'
import {
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  icsFilename,
  toIcsLocal,
  toIcsUtc,
  type IcsShift,
} from './icsExport'

const shift = (over: Partial<IcsShift> = {}): IcsShift => ({
  id: 'stream-1',
  brandName: 'SAMPLE BRAND A',
  startISO: '2026-09-07T10:00:00.000Z',
  endISO: '2026-09-07T12:00:00.000Z',
  role: 'host',
  ...over,
})

const OPTS = { dtstampISO: '2026-08-25T00:00:00.000Z' }

describe('toIcsLocal — the PT-naive trap', () => {
  it('emits the stored wall-clock verbatim, with NO trailing Z', () => {
    // A 10:00 PT shift is stored as 10:00Z. It must come out as 10:00 local,
    // NOT be treated as a UTC instant (which would land at 03:00 PT).
    expect(toIcsLocal('2026-09-07T10:00:00.000Z')).toBe('20260907T100000')
  })

  it('keeps a late-evening shift on its own PT date', () => {
    expect(toIcsLocal('2026-09-07T23:30:00.000Z')).toBe('20260907T233000')
  })

  it('does not shift across the November PT DST boundary', () => {
    expect(toIcsLocal('2026-11-01T10:00:00.000Z')).toBe('20261101T100000')
  })

  it('does not shift across the March PT DST boundary', () => {
    expect(toIcsLocal('2027-03-14T10:00:00.000Z')).toBe('20270314T100000')
  })

  it('pads single-digit components', () => {
    expect(toIcsLocal('2026-01-02T03:04:05.000Z')).toBe('20260102T030405')
  })
})

describe('toIcsUtc', () => {
  it('keeps the Z for DTSTAMP, which is a real instant', () => {
    expect(toIcsUtc('2026-08-25T12:34:56.000Z')).toBe('20260825T123456Z')
  })
})

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon and comma', () => {
    expect(escapeIcsText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d')
  })

  it('collapses newlines into the literal \\n sequence', () => {
    expect(escapeIcsText('line1\nline2')).toBe('line1\\nline2')
    expect(escapeIcsText('line1\r\nline2')).toBe('line1\\nline2')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeIcsText('Bring samples')).toBe('Bring samples')
  })
})

describe('foldIcsLine', () => {
  it('leaves short lines untouched', () => {
    expect(foldIcsLine('SUMMARY:SAMPLE BRAND A')).toBe('SUMMARY:SAMPLE BRAND A')
  })

  it('folds long lines with CRLF + a single space', () => {
    const folded = foldIcsLine('DESCRIPTION:' + 'x'.repeat(200))
    expect(folded).toContain('\r\n ')
    for (const seg of folded.split('\r\n')) {
      expect(Buffer.from(seg, 'utf8').length).toBeLessThanOrEqual(76) // 75 + leading space
    }
  })

  it('never splits a multi-byte character across a fold', () => {
    const folded = foldIcsLine('SUMMARY:' + 'é'.repeat(80))
    // A broken split would produce U+FFFD when re-decoded.
    expect(folded.replace(/\r\n /g, '')).toBe('SUMMARY:' + 'é'.repeat(80))
    expect(folded).not.toContain('�')
  })
})

describe('buildIcs', () => {
  it('wraps events in a valid VCALENDAR with a Pacific VTIMEZONE', () => {
    const ics = buildIcs([shift()], OPTS)
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
    expect(ics).toContain('BEGIN:VTIMEZONE')
    expect(ics).toContain('TZID:America/Los_Angeles')
    expect(ics).toContain('VERSION:2.0')
  })

  it('tags times with TZID and never emits a UTC event time', () => {
    const ics = buildIcs([shift()], OPTS)
    expect(ics).toContain('DTSTART;TZID=America/Los_Angeles:20260907T100000')
    expect(ics).toContain('DTEND;TZID=America/Los_Angeles:20260907T120000')
    // A "Z" on DTSTART/DTEND would move every shift by 7-8 hours.
    expect(ics).not.toMatch(/DTSTART[^\r\n]*\d{8}T\d{6}Z/)
    expect(ics).not.toMatch(/DTEND[^\r\n]*\d{8}T\d{6}Z/)
  })

  it('labels the role so a dual-role user can tell shifts apart', () => {
    expect(buildIcs([shift({ role: 'host' })], OPTS)).toContain('SUMMARY:SAMPLE BRAND A (Host)')
    expect(buildIcs([shift({ role: 'moderator' })], OPTS)).toContain('SUMMARY:SAMPLE BRAND A (Moderator)')
  })

  it('gives every event a stable unique UID', () => {
    const ics = buildIcs([shift({ id: 'a' }), shift({ id: 'b', startISO: '2026-09-08T10:00:00.000Z', endISO: '2026-09-08T12:00:00.000Z' })], OPTS)
    expect(ics).toContain('UID:a@scheduler.example.invalid')
    expect(ics).toContain('UID:b@scheduler.example.invalid')
  })

  it('includes notes as DESCRIPTION, escaped', () => {
    const ics = buildIcs([shift({ notes: 'Bring samples; two boxes' })], OPTS)
    expect(ics).toContain('DESCRIPTION:Bring samples\\; two boxes')
  })

  it('omits DESCRIPTION when there are no notes', () => {
    expect(buildIcs([shift({ notes: null })], OPTS)).not.toContain('DESCRIPTION:')
  })

  it('skips zero-length and inverted rows rather than emitting invalid events', () => {
    const ics = buildIcs(
      [
        shift({ id: 'zero', endISO: '2026-09-07T10:00:00.000Z' }),
        shift({ id: 'inverted', startISO: '2026-09-07T14:00:00.000Z', endISO: '2026-09-07T12:00:00.000Z' }),
      ],
      OPTS,
    )
    expect(ics).not.toContain('BEGIN:VEVENT')
  })

  it('produces a valid empty calendar when there are no shifts', () => {
    const ics = buildIcs([], OPTS)
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).not.toContain('BEGIN:VEVENT')
  })

  it('uses CRLF line endings throughout (required by RFC 5545)', () => {
    const ics = buildIcs([shift()], OPTS)
    expect(ics.split('\r\n').length).toBeGreaterThan(10)
    // No bare LF anywhere.
    expect(/[^\r]\n/.test(ics)).toBe(false)
  })

  it('escapes a calendar name containing a comma', () => {
    expect(buildIcs([], { ...OPTS, calendarName: 'Shifts, mine' })).toContain('X-WR-CALNAME:Shifts\\, mine')
  })
})

describe('icsFilename', () => {
  it('stamps the file with the export date', () => {
    expect(icsFilename('2026-08-25T18:00:00.000Z')).toBe('studio-shifts-2026-08-25.ics')
  })
})
