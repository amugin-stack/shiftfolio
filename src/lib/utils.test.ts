import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_TIMEZONE,
  colorFromHex,
  formatCents,
  formatPT,
  isPastPtDay,
  minutesToLabel,
  minutesToTimeString,
  nowPtAsUtc,
  parseMonth,
  ptWallClockToUtc,
  rateKey,
  utcToPt,
} from './utils'

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------
//
// These tests pin down the "PT-naive UTC" convention documented at the top of
// utils.ts: stream timestamps are stored UTC-typed, but the UTC hour/minute IS
// the PT wall-clock. No offset is ever applied. APP_TIMEZONE = 'UTC'.
//
// Implementation detail: `utcToPt` / `ptWallClockToUtc` delegate to
// `toZonedTime` / `fromZonedTime` from date-fns-tz with the literal zone
// 'UTC'. Because the runtime's *local* timezone is America/Los_Angeles, the
// resulting Date objects encode the PT wall-clock fields in their **local**
// getters (`getHours`, `getMinutes`, `getDate`, ...), NOT their UTC getters.
// The canonical projection back to a label is `formatPT`. Tests below assert
// behavior through that canonical projection where possible, plus a few
// explicit `getHours()` checks so a refactor of the helpers can't silently
// break the convention.
//
// If anyone "fixes" the helpers to apply a real America/Los_Angeles offset,
// these tests will fail — which is exactly the point. Every UI surface that
// renders shift times is built on this convention.
// ---------------------------------------------------------------------------

describe('APP_TIMEZONE', () => {
  it('is the literal string "UTC" — the PT-naive convention depends on this', () => {
    expect(APP_TIMEZONE).toBe('UTC')
  })
})

describe('formatPT', () => {
  it('renders the raw UTC hour as PT wall-clock (no zone offset applied)', () => {
    // 15:00 UTC in real PT would be 7:00 AM (PDT) or 8:00 AM (PST). In the
    // PT-naive scheme, the UTC hour IS the PT wall-clock, so it must read 3:00 PM.
    const utcInstant = '2026-05-15T15:00:00.000Z'
    expect(formatPT(utcInstant, 'h:mm a')).toBe('3:00 PM')
  })

  it('formats day-of-week and date using UTC fields', () => {
    // 2026-05-15 is a Friday in UTC. A real PT conversion of 00:30 UTC would
    // roll back to Thursday — so "Fri" here proves we are reading UTC fields.
    const utcInstant = '2026-05-15T00:30:00.000Z'
    expect(formatPT(utcInstant, 'EEE, MMM d')).toBe('Fri, May 15')
  })

  it('formats yyyy-MM-dd directly from UTC fields', () => {
    expect(formatPT('2026-05-15T23:59:00.000Z', 'yyyy-MM-dd')).toBe('2026-05-15')
  })

  it('accepts a Date object as well as an ISO string', () => {
    const d = new Date('2026-05-15T09:15:00.000Z')
    expect(formatPT(d, 'h:mm a')).toBe('9:15 AM')
  })

  it('formats midnight UTC as 12:00 AM (not the previous PT evening)', () => {
    expect(formatPT('2026-05-15T00:00:00.000Z', 'h:mm a')).toBe('12:00 AM')
  })

  it('formats noon UTC as 12:00 PM', () => {
    expect(formatPT('2026-05-15T12:00:00.000Z', 'h:mm a')).toBe('12:00 PM')
  })
})

describe('utcToPt / ptWallClockToUtc', () => {
  // The "PT" Date that utcToPt returns encodes its wall-clock components in
  // **local** getters (getHours/getMinutes/...). Reading via getUTCHours would
  // give the system tz's UTC offset back, not the PT-naive fields.

  it('utcToPt encodes the input UTC fields into the local-getter fields', () => {
    const original = new Date('2026-05-15T15:30:00.000Z')
    const result = utcToPt(original)
    expect(result.getFullYear()).toBe(2026)
    expect(result.getMonth()).toBe(4) // May (0-indexed)
    expect(result.getDate()).toBe(15)
    expect(result.getHours()).toBe(15)
    expect(result.getMinutes()).toBe(30)
  })

  it('ptWallClockToUtc inverts utcToPt: the round-trip preserves the original instant', () => {
    const original = new Date('2026-05-15T15:30:00.000Z')
    const roundTripped = ptWallClockToUtc(utcToPt(original))
    expect(roundTripped.getTime()).toBe(original.getTime())
  })

  it('inverse round-trips: utcToPt(ptWallClockToUtc(date)).getTime() === date.getTime()', () => {
    const original = new Date('2026-06-04T18:45:00.000Z')
    const roundTripped = utcToPt(ptWallClockToUtc(original))
    expect(roundTripped.getTime()).toBe(original.getTime())
  })

  it('round-trip identity holds at boundary instants (midnight, noon, end-of-day)', () => {
    for (const iso of [
      '2026-05-15T00:00:00.000Z',
      '2026-05-15T12:00:00.000Z',
      '2026-05-15T23:59:59.000Z',
    ]) {
      const d = new Date(iso)
      expect(ptWallClockToUtc(utcToPt(d)).getTime()).toBe(d.getTime())
    }
  })

  it('formatPT and utcToPt agree on the wall-clock label after a round-trip', () => {
    // The canonical projection: formatPT(d, fmt) should equal
    // formatPT(ptWallClockToUtc(utcToPt(d)), fmt) for non-DST instants.
    const d = new Date('2026-05-15T15:30:00.000Z')
    expect(formatPT(ptWallClockToUtc(utcToPt(d)), 'yyyy-MM-dd HH:mm')).toBe(
      formatPT(d, 'yyyy-MM-dd HH:mm'),
    )
  })

  it('utcToPt accepts an ISO string and an equivalent Date object', () => {
    const fromString = utcToPt('2026-05-15T15:30:00.000Z')
    const fromDate = utcToPt(new Date('2026-05-15T15:30:00.000Z'))
    expect(fromString.getTime()).toBe(fromDate.getTime())
    expect(fromString.getHours()).toBe(15)
    expect(fromString.getMinutes()).toBe(30)
  })
})

describe('nowPtAsUtc', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a Date whose UTC fields are the current PT wall-clock', () => {
    // 2026-05-15 18:00 UTC === 11:00 PT (PDT, UTC-7) on May 15.
    // So nowPtAsUtc() should produce a Date whose UTC fields are 2026-05-15 11:00.
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    const result = nowPtAsUtc()
    expect(result.getUTCFullYear()).toBe(2026)
    expect(result.getUTCMonth()).toBe(4) // May
    expect(result.getUTCDate()).toBe(15)
    expect(result.getUTCHours()).toBe(11)
    expect(result.getUTCMinutes()).toBe(0)
  })

  it('handles a PT date that lags the UTC date (late evening PT, next day UTC)', () => {
    // 2026-05-16 04:30 UTC === 2026-05-15 21:30 PT (PDT, UTC-7).
    vi.setSystemTime(new Date('2026-05-16T04:30:00.000Z'))
    const result = nowPtAsUtc()
    expect(result.getUTCDate()).toBe(15)
    expect(result.getUTCHours()).toBe(21)
    expect(result.getUTCMinutes()).toBe(30)
  })

  it('handles standard time (PST, UTC-8) correctly — January', () => {
    // 2026-01-15 18:00 UTC === 10:00 PT (PST, UTC-8).
    vi.setSystemTime(new Date('2026-01-15T18:00:00.000Z'))
    const result = nowPtAsUtc()
    expect(result.getUTCMonth()).toBe(0) // Jan
    expect(result.getUTCDate()).toBe(15)
    expect(result.getUTCHours()).toBe(10)
  })

  it('formatPT(nowPtAsUtc(), ...) yields the current PT wall-clock label', () => {
    // Verify the helper composes correctly with the canonical formatter.
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    expect(formatPT(nowPtAsUtc(), 'h:mm a')).toBe('11:00 AM')
    expect(formatPT(nowPtAsUtc(), 'yyyy-MM-dd')).toBe('2026-05-15')
  })

  it('the cached Intl formatter stays correct across DST, in both directions', () => {
    // nowPtAsUtc reuses ONE module-level Intl.DateTimeFormat instead of
    // building a fresh one per call (the calendar called it ~340 times per
    // repaint). That is only safe because a DateTimeFormat resolves the zone
    // offset per FORMATTED date rather than at construction time.
    //
    // The two cases below already exist separately above; this asserts the
    // property that actually matters and that a naive "cache the result"
    // refactor would break — the SAME instance giving PDT and PST answers,
    // in either order, with no leakage between calls.
    vi.setSystemTime(new Date('2026-01-15T18:00:00.000Z')) // PST, UTC-8
    expect(nowPtAsUtc().getUTCHours()).toBe(10)

    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z')) // PDT, UTC-7
    expect(nowPtAsUtc().getUTCHours()).toBe(11)

    vi.setSystemTime(new Date('2026-01-15T18:00:00.000Z')) // back to PST
    expect(nowPtAsUtc().getUTCHours()).toBe(10)

    // And "now" must still advance — only the formatter is cached, never the
    // Date. If someone hoists `new Date()` out too, this is what catches it.
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    const first = nowPtAsUtc()
    vi.setSystemTime(new Date('2026-05-15T19:00:00.000Z'))
    const second = nowPtAsUtc()
    expect(second.getTime()).toBeGreaterThan(first.getTime())
    expect(second.getUTCHours()).toBe(12)
  })
})

describe('DST boundary behavior (PT-naive convention)', () => {
  // The PT-naive scheme is "supposed" to be DST-invisible — formatPT should
  // just read UTC fields. In practice the spring-forward boundary leaks
  // through date-fns-tz's local-time math (see SOURCE BUGS in the agent
  // report). Non-DST and fall-back behavior do hold.

  it('Mar 8 2026 — UTC 03:30 still formats as 3:30 AM (post-skipped-hour is unaffected)', () => {
    expect(formatPT('2026-03-08T03:30:00.000Z', 'h:mm a')).toBe('3:30 AM')
  })

  it('Mar 8 2026 — UTC 01:30 (pre-skipped-hour) reads as 1:30 AM', () => {
    expect(formatPT('2026-03-08T01:30:00.000Z', 'h:mm a')).toBe('1:30 AM')
    expect(formatPT('2026-03-08T01:30:00.000Z', 'yyyy-MM-dd HH:mm')).toBe('2026-03-08 01:30')
  })

  it('Nov 1 2026 (fall back) — UTC 01:30 formats as 1:30 AM only once', () => {
    // Real PT has "1:30 AM" appear twice on fall-back day; the PT-naive scheme
    // just reads the UTC hour, so each UTC instant maps to exactly one label.
    expect(formatPT('2026-11-01T01:30:00.000Z', 'h:mm a')).toBe('1:30 AM')
  })

  it('Nov 1 2026 — the date is preserved regardless of DST', () => {
    expect(formatPT('2026-11-01T08:00:00.000Z', 'yyyy-MM-dd')).toBe('2026-11-01')
  })

  it('round-trip identity holds across the fall-back boundary', () => {
    const d = new Date('2026-11-01T01:30:00.000Z')
    expect(ptWallClockToUtc(utcToPt(d)).getTime()).toBe(d.getTime())
  })

  it('round-trip identity holds on Mar 8 OUTSIDE the skipped hour (01:30 UTC)', () => {
    const d = new Date('2026-03-08T01:30:00.000Z')
    expect(ptWallClockToUtc(utcToPt(d)).getTime()).toBe(d.getTime())
  })

  // SOURCE BUG: The next two tests document a real bug in the PT-naive scheme
  // that the agent surfaced. Because `formatPT` delegates to
  // `formatInTimeZone(d, 'UTC', fmt)` from date-fns-tz, and date-fns-tz
  // internally computes its label via the *local* clock (America/Los_Angeles
  // on the dev/server box), UTC instants inside the LA spring-forward gap
  // (Mar 8 2026 02:00–02:59 UTC) get shifted forward 1 hour in the rendered
  // label, and round-trip identity also fails. We pin the broken behavior
  // here with `.fails` so the test suite is green AND alerts the team if the
  // bug is fixed (the .fails will start failing).
  it.fails(
    'SOURCE BUG: Mar 8 02:30 UTC SHOULD format as "02:30" but date-fns-tz returns "03:30"',
    () => {
      expect(formatPT('2026-03-08T02:30:00.000Z', 'yyyy-MM-dd HH:mm')).toBe('2026-03-08 02:30')
    },
  )

  it.fails(
    'SOURCE BUG: round-trip identity FAILS for UTC instants inside the LA spring-forward gap (Mar 8 02:30 UTC)',
    () => {
      const d = new Date('2026-03-08T02:30:00.000Z')
      expect(ptWallClockToUtc(utcToPt(d)).getTime()).toBe(d.getTime())
    },
  )
})

describe('parseMonth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('parses "2026-05" to { year: 2026, month: 4, key: "2026-05" } (month is 0-indexed)', () => {
    expect(parseMonth('2026-05')).toEqual({ year: 2026, month: 4, key: '2026-05' })
  })

  it('parses "2026-01" (January) correctly', () => {
    expect(parseMonth('2026-01')).toEqual({ year: 2026, month: 0, key: '2026-01' })
  })

  it('parses "2026-12" (December) correctly', () => {
    expect(parseMonth('2026-12')).toEqual({ year: 2026, month: 11, key: '2026-12' })
  })

  it('falls back to current PT month when input is undefined', () => {
    // 2026-05-15 18:00 UTC === May 2026 in PT.
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    expect(parseMonth(undefined)).toEqual({ year: 2026, month: 4, key: '2026-05' })
  })

  it('falls back to current PT month when input is empty string', () => {
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    expect(parseMonth('')).toEqual({ year: 2026, month: 4, key: '2026-05' })
  })

  it('falls back to current PT month when input is malformed', () => {
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    expect(parseMonth('invalid')).toEqual({ year: 2026, month: 4, key: '2026-05' })
    expect(parseMonth('2026')).toEqual({ year: 2026, month: 4, key: '2026-05' })
    expect(parseMonth('2026/05')).toEqual({ year: 2026, month: 4, key: '2026-05' })
  })

  it('falls back to current PT month when month is out of range', () => {
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    expect(parseMonth('2026-13')).toEqual({ year: 2026, month: 4, key: '2026-05' })
    expect(parseMonth('2026-00')).toEqual({ year: 2026, month: 4, key: '2026-05' })
  })

  it('honors the PT date when UTC has crossed midnight but PT has not', () => {
    // 2026-06-01 04:00 UTC === 2026-05-31 21:00 PT (PDT). Current PT month is May.
    vi.setSystemTime(new Date('2026-06-01T04:00:00.000Z'))
    expect(parseMonth(undefined)).toEqual({ year: 2026, month: 4, key: '2026-05' })
  })

  it('produces a canonical zero-padded key for the fallback', () => {
    // 2026-02-15 18:00 UTC === Feb in PT.
    vi.setSystemTime(new Date('2026-02-15T18:00:00.000Z'))
    expect(parseMonth('bad').key).toBe('2026-02')
  })
})

describe('isPastPtDay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Candidates are built exactly as the bulk-book handlers build them:
  // ptWallClockToUtc(new Date(ptYear, ptMonth, ptDay, hour, minute)). This
  // keeps the test honest to the real pipeline in StreamEventModal.
  const candidate = (y: number, m: number, d: number, h = 10, min = 0) =>
    ptWallClockToUtc(new Date(y, m, d, h, min))

  it('returns true for a day before today (PT)', () => {
    // 2026-05-15 18:00 UTC === May 15 PT. A May 12 candidate is in the past.
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    expect(isPastPtDay(candidate(2026, 4, 12))).toBe(true)
  })

  it('returns false for today even when the slot time has already elapsed', () => {
    // "Current day" counts as bookable: 9:00 AM slot on today still returns false
    // at 11:00 AM PT.
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z')) // 11:00 AM PT
    expect(isPastPtDay(candidate(2026, 4, 15, 9, 0))).toBe(false)
  })

  it('returns false for a future day', () => {
    vi.setSystemTime(new Date('2026-05-15T18:00:00.000Z'))
    expect(isPastPtDay(candidate(2026, 4, 19))).toBe(false)
  })

  it('uses the PT date, not UTC, near midnight (late PT evening, next UTC day)', () => {
    // 2026-05-16 04:30 UTC === 2026-05-15 21:30 PT. Today's PT day is the 15th,
    // so a May 15 candidate is still current, and May 14 is past.
    vi.setSystemTime(new Date('2026-05-16T04:30:00.000Z'))
    expect(isPastPtDay(candidate(2026, 4, 15))).toBe(false)
    expect(isPastPtDay(candidate(2026, 4, 14))).toBe(true)
  })

  it('accepts an explicit `now` for deterministic comparison', () => {
    const fixedNow = new Date(Date.UTC(2026, 4, 15, 11, 0))
    expect(isPastPtDay(candidate(2026, 4, 14), fixedNow)).toBe(true)
    expect(isPastPtDay(candidate(2026, 4, 15), fixedNow)).toBe(false)
    expect(isPastPtDay(candidate(2026, 4, 16), fixedNow)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pure utility helpers (no timezone math)
// ---------------------------------------------------------------------------

describe('formatCents', () => {
  // NOTE on the user-supplied task spec: it asked for `2000 -> "$20"` and
  // `0 -> "$0"`. The actual implementation uses minimumFractionDigits: 2 and
  // always renders two decimal places. We test the implementation, not the
  // spec — flag this discrepancy if the spec was correct.

  it('formats whole dollars with cents shown (en-US convention)', () => {
    expect(formatCents(2000)).toBe('$20.00')
  })

  it('formats half-dollar values correctly', () => {
    expect(formatCents(2050)).toBe('$20.50')
  })

  it('formats zero as $0.00', () => {
    expect(formatCents(0)).toBe('$0.00')
  })

  it('formats large values with thousands separators', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
  })

  it('formats single cents correctly', () => {
    expect(formatCents(1)).toBe('$0.01')
    expect(formatCents(99)).toBe('$0.99')
  })

  it('formats negative cents with a leading minus inside the locale string', () => {
    // The helper just prepends "$" to a toLocaleString result. Document the
    // current behavior — UI surfaces should not normally pass negatives.
    expect(formatCents(-500)).toBe('$-5.00')
  })
})

describe('minutesToLabel', () => {
  it('renders 9:00 AM from 540 minutes', () => {
    expect(minutesToLabel(540)).toBe('9:00 AM')
  })

  it('renders 11:00 PM from 1380 minutes', () => {
    expect(minutesToLabel(1380)).toBe('11:00 PM')
  })

  it('renders 12:00 AM from 0 minutes', () => {
    expect(minutesToLabel(0)).toBe('12:00 AM')
  })

  it('renders 12:00 PM from 720 minutes (noon)', () => {
    expect(minutesToLabel(720)).toBe('12:00 PM')
  })

  it('renders 12:30 AM from 30 minutes (post-midnight)', () => {
    expect(minutesToLabel(30)).toBe('12:30 AM')
  })

  it('renders 1:00 PM from 780 minutes', () => {
    expect(minutesToLabel(780)).toBe('1:00 PM')
  })

  it('renders 11:59 PM from 1439 minutes', () => {
    expect(minutesToLabel(1439)).toBe('11:59 PM')
  })

  it('clamps 1440 (end-of-day) to 12:00 AM', () => {
    expect(minutesToLabel(1440)).toBe('12:00 AM')
  })

  it('pads single-digit minutes with a leading zero', () => {
    expect(minutesToLabel(545)).toBe('9:05 AM')
  })
})

describe('minutesToTimeString', () => {
  it('renders 09:00:00 from 540 minutes', () => {
    expect(minutesToTimeString(540)).toBe('09:00:00')
  })

  it('renders 01:30:00 from 90 minutes', () => {
    expect(minutesToTimeString(90)).toBe('01:30:00')
  })

  it('renders 00:00:00 from 0 minutes', () => {
    expect(minutesToTimeString(0)).toBe('00:00:00')
  })

  it('renders 23:59:00 from 1439 minutes', () => {
    expect(minutesToTimeString(1439)).toBe('23:59:00')
  })

  it('clamps to 24:00:00 when given 1440', () => {
    // FullCalendar accepts "24:00:00" as end-of-day; the helper allows it.
    expect(minutesToTimeString(1440)).toBe('24:00:00')
  })

  it('clamps negative inputs to 00:00:00', () => {
    expect(minutesToTimeString(-30)).toBe('00:00:00')
  })

  it('clamps over-1440 inputs to 24:00:00', () => {
    expect(minutesToTimeString(5000)).toBe('24:00:00')
  })

  it('pads hours and minutes to two digits each', () => {
    expect(minutesToTimeString(65)).toBe('01:05:00')
  })
})

describe('rateKey', () => {
  it('joins (dayOfWeek, blockIndex) with a hyphen', () => {
    expect(rateKey(0, 0)).toBe('0-0')
    expect(rateKey(3, 7)).toBe('3-7')
    expect(rateKey(6, 23)).toBe('6-23')
  })

  it('does not normalize negative or out-of-range values (caller responsibility)', () => {
    expect(rateKey(-1, 100)).toBe('-1-100')
  })
})

describe('colorFromHex', () => {
  // A valid '#rrggbb' bg: always lowercased, prefixed with '#', exactly 7 chars.
  const isHexColor = (s: string) => /^#[0-9a-f]{6}$/.test(s)

  it('maps white to black text on a white bg', () => {
    const { bg, border, text } = colorFromHex('#ffffff')
    expect(bg).toBe('#ffffff')
    expect(text).toBe('#000000') // luminance 1.0 > 0.6
    // 0.85 * 255 = 216.75 -> round 217 = 0xd9
    expect(border).toBe('#d9d9d9')
  })

  it('maps black to white text; border stays black (0.85*0 = 0)', () => {
    const { bg, border, text } = colorFromHex('#000000')
    expect(bg).toBe('#000000')
    expect(text).toBe('#ffffff') // luminance 0 < 0.6
    expect(border).toBe('#000000')
  })

  it('maps a mid/dark blue to white text with an exactly-darkened border', () => {
    // #3b82f6 -> r=59, g=130, b=246.
    // border r: round(59*0.85)=round(50.15)=50=0x32
    // border g: round(130*0.85)=round(110.5)=111=0x6f
    // border b: round(246*0.85)=round(209.1)=209=0xd1
    const { bg, border, text } = colorFromHex('#3b82f6')
    expect(bg).toBe('#3b82f6')
    expect(text).toBe('#ffffff') // luminance ~0.48 < 0.6
    expect(border).toBe('#326fd1')
    expect(isHexColor(border)).toBe(true)
    // Strictly darker than bg on at least one channel.
    expect(parseInt(border.slice(1, 3), 16)).toBeLessThan(parseInt(bg.slice(1, 3), 16))
  })

  it('normalizes 3-char shorthand: "fff" === "#ffffff"', () => {
    expect(colorFromHex('fff')).toEqual(colorFromHex('#ffffff'))
  })

  it('normalizes a missing "#": "3b82f6" === "#3b82f6"', () => {
    expect(colorFromHex('3b82f6')).toEqual(colorFromHex('#3b82f6'))
  })

  it('normalizes uppercase to lowercase: "#FFFFFF" -> "#ffffff"', () => {
    const { bg } = colorFromHex('#FFFFFF')
    expect(bg).toBe('#ffffff')
  })

  it('falls back to neutral grey for invalid input', () => {
    for (const bad of ['nope', '', '#12']) {
      const { bg, border, text } = colorFromHex(bad)
      expect(bg).toBe('#6b7280') // fallback grey
      expect(isHexColor(border)).toBe(true)
      expect(['#000000', '#ffffff']).toContain(text)
    }
  })

  it('always returns a bg that starts with "#" and is 7 chars', () => {
    for (const input of ['#ffffff', '000000', 'abc', 'nope', '', '#3b82f6']) {
      const { bg } = colorFromHex(input)
      expect(bg.startsWith('#')).toBe(true)
      expect(bg).toHaveLength(7)
    }
  })
})
