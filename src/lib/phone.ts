// Pure phone-number normalizer for the auto-scheduler's contact editor.
//
// Every SMS surface (sms_contacts, scheduler_runtime.escalation_phone_e164,
// sms_outbox.to_e164) is CHECKed at the DB to '^\+1[2-9][0-9]{9}$' (migration
// 089) — a US/Canada NANP number: +1, area code not starting with 0/1, seven
// more digits. This mirrors that exact shape so a value that passes here also
// passes the DB, and a value the DB would reject is caught before the request
// is even sent.

/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX), or null if the input
 * doesn't parse to one. Accepts common human formats: parens, dashes, dots,
 * spaces, a leading "1" or "+1" country code, or none at all. Rejects
 * anything with the wrong digit count or an area code starting with 0 or 1
 * (matching the sms_contacts CHECK constraint in migration 089 exactly).
 */
export function toE164US(input: string): string | null {
  if (typeof input !== 'string') return null
  const digits = input.replace(/\D/g, '')
  // Accept 10 digits (no country code) or 11 digits starting with a leading 1.
  let national: string
  if (digits.length === 10) {
    national = digits
  } else if (digits.length === 11 && digits[0] === '1') {
    national = digits.slice(1)
  } else {
    return null
  }
  // NANP: area code and exchange code cannot start with 0 or 1.
  if (!/^[2-9][0-9]{9}$/.test(national)) return null
  return `+1${national}`
}
