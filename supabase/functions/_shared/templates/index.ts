/**
 * Email template dispatcher.
 *
 * Renders a `RenderableNotification` to an email-ready `{ subject, html }`
 * pair. Agent1's Edge Function (`send-notification-email`) imports `renderEmail`
 * and hands the result to Resend.
 *
 * Implementation note: the React Email TSX templates in this directory
 * (`shift-booked.tsx`, etc.) don't survive Deno's npm interop reliably —
 * `@react-email/render` throws "Objects are not valid as a React child" at
 * runtime under Deno even with pinned React versions. The Edge Function
 * therefore routes through the pure-HTML string renderer in `render-html.ts`,
 * which produces the same brand styling without any React. The TSX templates
 * remain for the Node-based local preview tool (`scripts/render-emails.ts`).
 */

export { renderEmailHtml as renderEmail } from './render-html.ts'
