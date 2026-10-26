/**
 * Shared types for the email notification pipeline.
 *
 * This file is the contract between agent1 (infrastructure / Edge Functions)
 * and agent2 (React Email templates). Both halves of the build code against
 * `RenderableNotification` — agent1's Edge Function shapes raw `notifications`
 * rows into this form; agent2's templates accept it as props.
 *
 * If a template needs a new field, update this file and tell the other agent.
 */

export type NotificationType =
  | 'shift_booked'
  | 'shift_edited'
  | 'shift_cancelled'
  | 'shift_reminder'
  | 'reminder_delivery_alert'
  | 'brand_request'
  | 'brand_request_approved'
  | 'brand_request_denied'
  | 'cancellation_request'
  | 'cancellation_request_approved'
  | 'cancellation_request_denied'

export type RecipientRole = 'host' | 'moderator' | 'producer' | 'admin'

export interface RenderableShift {
  /** ISO timestamp. App stores PT wall-clock as naive UTC; format with America/Los_Angeles. */
  start: string
  /** ISO timestamp; same convention as `start`. */
  end: string
  /** Which role the recipient is filling on this specific shift. */
  role: RecipientRole
  /** Brand name on this shift (matters in the bulk-summary case where shifts span brands). */
  brandName: string
}

export interface RenderableNotification {
  type: NotificationType

  /** Display name of the email recipient (the host/moderator/producer being emailed). */
  recipientName: string
  /** Which role table the recipient came from. */
  recipientRole: RecipientRole

  /** Primary brand context for the email. For bulk summaries this is the first/representative brand. */
  brand: { name: string; id: string }

  /**
   * Shifts relevant to this notification.
   * - `shift_booked` / `shift_edited` / `shift_cancelled` / `shift_reminder`: usually a single shift.
   * - `shift_booked` with `bulkSummary` set: list of all shifts in the bulk batch (used for the summary table).
   * - Request-flow notifications: typically empty.
   */
  shifts: RenderableShift[]

  /** Canonical app URL for CTA buttons (e.g. https://scheduler.example.invalid). */
  appUrl: string

  /** Host who initiated a request (for *_request and *_request_approved/denied notifications). */
  actorName?: string

  /**
   * Present when N>1 shifts were created/affected in one RPC call. Templates
   * should render the bulk variant (summary table over multiple `shifts` rows)
   * when this is set.
   */
  bulkSummary?: { count: number; brandNames: string[] }

  /** Free-form context: cancellation reason, denial reason, edit detail. */
  body?: string
  reminderMode?: 'scheduled' | 'late' | 'corrected'

  /** For `shift_edited`: the shift's time before the edit. Compare with `shifts[0]` for the new time. */
  oldShift?: { start: string; end: string }
}

/**
 * Renders a notification to email-ready subject + HTML.
 *
 * Implementation lives in `./templates/index.ts`. Agent1's Edge Function imports
 * it; agent2 owns the implementation. A stub is shipped initially so agent1
 * can build and deploy independently — agent2's PR replaces the stub.
 *
 * Async because `@react-email/render`'s `render()` returns a Promise in v1+.
 * Call sites: `const { subject, html } = await renderEmail(n)`.
 */
export type RenderEmail = (
  n: RenderableNotification,
) => Promise<{ subject: string; html: string }>
