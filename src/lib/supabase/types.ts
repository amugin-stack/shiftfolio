export type UserRole = 'admin' | 'user'

/** Every notification type understood by both the in-app notification UI
 *  and the send-notification-email Edge Function. Keep in sync with the
 *  notifications_type_check constraint (migration 038) and with
 *  `NotificationType` in `supabase/functions/_shared/types.ts`. */
export type NotificationKind =
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

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          full_name: string | null
          role: UserRole
          phone: string | null
          height: string | null
          weight: string | null
          hair_color: string | null
          eye_color: string | null
          top_size: string | null
          bottom_size: string | null
          shoe_size: string | null
          headshot_path: string | null
          created_at: string
        }
        Insert: {
          id: string
          email: string
          full_name?: string | null
          role?: UserRole
          phone?: string | null
          height?: string | null
          weight?: string | null
          hair_color?: string | null
          eye_color?: string | null
          top_size?: string | null
          bottom_size?: string | null
          shoe_size?: string | null
          headshot_path?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          email?: string
          full_name?: string | null
          role?: UserRole
          phone?: string | null
          height?: string | null
          weight?: string | null
          hair_color?: string | null
          eye_color?: string | null
          top_size?: string | null
          bottom_size?: string | null
          shoe_size?: string | null
          headshot_path?: string | null
        }
      }
      hosts: {
        Row: {
          id: string
          name: string
          email: string | null
          phone: string | null
          user_id: string | null
          /** Flat $/hr pay (migration 046). Admin-only — non-admin code paths
           *  must select HOST_PUBLIC_COLUMNS / use HostPublic. */
          rate_cents: number
          /** Soft-delete flag (migration 054). false = deactivated: hidden from
           *  active rosters + assignment dropdowns, but row + pay history kept. */
          is_active: boolean
          /** This host moderates their own shifts, so they may report session
           *  GMV like a moderator (migration 075). Ordinary hosts cannot. */
          self_moderating: boolean
          /** Admin-set monthly GMV-per-hour goal, integer cents. NULL = no goal
           *  set, deliberately distinct from a zero goal. Readable by the host
           *  (it is their own target); admin-only to WRITE, enforced by a
           *  trigger (migration 075). */
          monthly_gmv_goal_cents: number | null
          email_disabled_at: string | null
          email_disabled_reason: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          email?: string | null
          phone?: string | null
          user_id?: string | null
          rate_cents?: number
          is_active?: boolean
          self_moderating?: boolean
          monthly_gmv_goal_cents?: number | null
          email_disabled_at?: string | null
          email_disabled_reason?: string | null
          created_at?: string
        }
        Update: {
          name?: string
          email?: string | null
          phone?: string | null
          user_id?: string | null
          rate_cents?: number
          is_active?: boolean
          self_moderating?: boolean
          monthly_gmv_goal_cents?: number | null
          email_disabled_at?: string | null
          email_disabled_reason?: string | null
        }
      }
      brands: {
        Row: {
          id: string
          name: string
          email: string | null
          user_id: string | null
          block_size_minutes: number
          day_start_minutes: number
          day_end_minutes: number
          logo_path: string | null
          client_rate_cents: number | null
          contracted_hours_per_month: number | null
          /** The producer assigned to run this brand. Null means admin-only.
           *  See migration agent2migrations/002 + is_brand_scheduler() helper. */
          producer_id: string | null
          /** Master-schedule display color, #RRGGBB. Null → index-palette fallback. */
          color: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          email?: string | null
          user_id?: string | null
          block_size_minutes?: number
          day_start_minutes?: number
          day_end_minutes?: number
          logo_path?: string | null
          client_rate_cents?: number | null
          contracted_hours_per_month?: number | null
          producer_id?: string | null
          color?: string | null
          created_at?: string
        }
        Update: {
          name?: string
          email?: string | null
          user_id?: string | null
          block_size_minutes?: number
          day_start_minutes?: number
          day_end_minutes?: number
          logo_path?: string | null
          client_rate_cents?: number | null
          contracted_hours_per_month?: number | null
          producer_id?: string | null
          color?: string | null
        }
      }
      producers: {
        Row: {
          id: string
          name: string
          email: string | null
          user_id: string | null
          email_disabled_at: string | null
          email_disabled_reason: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          email?: string | null
          user_id?: string | null
          email_disabled_at?: string | null
          email_disabled_reason?: string | null
          created_at?: string
        }
        Update: {
          name?: string
          email?: string | null
          user_id?: string | null
          email_disabled_at?: string | null
          email_disabled_reason?: string | null
        }
      }
      moderators: {
        Row: {
          id: string
          name: string
          email: string | null
          phone: string | null
          user_id: string | null
          rate_cents: number
          /** Soft-delete flag (migration 054). false = deactivated: hidden from
           *  active rosters + assignment dropdowns, but row + pay history kept. */
          is_active: boolean
          email_disabled_at: string | null
          email_disabled_reason: string | null
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          email?: string | null
          phone?: string | null
          user_id?: string | null
          rate_cents?: number
          is_active?: boolean
          email_disabled_at?: string | null
          email_disabled_reason?: string | null
          created_at?: string
        }
        Update: {
          name?: string
          email?: string | null
          phone?: string | null
          user_id?: string | null
          rate_cents?: number
          is_active?: boolean
          email_disabled_at?: string | null
          email_disabled_reason?: string | null
        }
      }
      brand_hosts: {
        Row: {
          brand_id: string
          host_id: string
          created_at: string
        }
        Insert: {
          brand_id: string
          host_id: string
          created_at?: string
        }
        Update: Record<string, never>
      }
      notifications: {
        Row: {
          id: string
          recipient_id: string
          type: NotificationKind
          actor_host_id: string | null
          host_name: string
          brand_id: string | null
          brand_name: string
          shift_start: string | null
          shift_end: string | null
          request_id: string | null
          body: string | null
          is_read: boolean
          dismissed_at: string | null
          // Email delivery tracking (migration 037). Set by send-notification-email
          // Edge Function; never set by app code. `email_sent_at` is the idempotency
          // guard; `email_skipped_reason` distinguishes "deliberately not sent"
          // (no_address_or_disabled) from "still pending".
          email_sent_at: string | null
          email_message_id: string | null
          email_error: string | null
          email_skipped_reason: string | null
          created_at: string
        }
        Insert: {
          id?: string
          recipient_id: string
          type: NotificationKind
          actor_host_id?: string | null
          host_name: string
          brand_id?: string | null
          brand_name: string
          shift_start?: string | null
          shift_end?: string | null
          request_id?: string | null
          body?: string | null
          is_read?: boolean
          email_sent_at?: string | null
          email_message_id?: string | null
          email_error?: string | null
          email_skipped_reason?: string | null
          created_at?: string
        }
        Update: {
          is_read?: boolean
          email_sent_at?: string | null
          email_message_id?: string | null
          email_error?: string | null
          email_skipped_reason?: string | null
        }
      }
      shift_cancellation_requests: {
        Row: {
          id: string
          stream_id: string
          host_user_id: string
          reason: string | null
          status: 'pending' | 'approved' | 'denied'
          created_at: string
          decided_by: string | null
          decided_at: string | null
        }
        Insert: {
          id?: string
          stream_id: string
          host_user_id: string
          reason?: string | null
          status?: 'pending' | 'approved' | 'denied'
          created_at?: string
          decided_by?: string | null
          decided_at?: string | null
        }
        Update: {
          status?: 'pending' | 'approved' | 'denied'
          decided_by?: string | null
          decided_at?: string | null
        }
      }
      brand_host_requests: {
        Row: {
          id: string
          host_user_id: string
          brand_id: string
          status: 'pending' | 'approved' | 'denied'
          created_at: string
          decided_by: string | null
          decided_at: string | null
        }
        Insert: {
          id?: string
          host_user_id: string
          brand_id: string
          status?: 'pending' | 'approved' | 'denied'
          created_at?: string
          decided_by?: string | null
          decided_at?: string | null
        }
        Update: {
          status?: 'pending' | 'approved' | 'denied'
          decided_by?: string | null
          decided_at?: string | null
        }
      }
      streams: {
        Row: {
          id: string
          title: string | null
          brand_id: string
          host_id: string | null
          producer_id: string | null
          moderator_id: string | null
          start_time: string
          end_time: string
          notes: string | null
          created_by: string
          created_at: string
          /** Set by the shift-reminders-2h pg_cron job after emitting reminder
           *  notifications. Treat as read-only at the app layer. */
          reminder_sent_at: string | null
          /** Frozen host $/hr for shifts completed before the flat-rate
           *  migration (046). NULL = use hosts.rate_cents. Pay-sensitive:
           *  only my-shifts (own rows) and admin paths may select it. */
          host_rate_cents: number | null
          /** Host-reported GMV for the session this stream anchors, in cents.
           *  Stored only on the session's earliest stream; null elsewhere. */
          gmv_cents: number | null
        }
        Insert: {
          id?: string
          title?: string | null
          brand_id: string
          host_id?: string | null
          producer_id?: string | null
          moderator_id?: string | null
          start_time: string
          end_time: string
          notes?: string | null
          created_by: string
          created_at?: string
          reminder_sent_at?: string | null
          host_rate_cents?: number | null
          gmv_cents?: number | null
        }
        Update: {
          title?: string | null
          brand_id?: string
          host_id?: string | null
          producer_id?: string | null
          moderator_id?: string | null
          start_time?: string
          end_time?: string
          notes?: string | null
          reminder_sent_at?: string | null
          host_rate_cents?: number | null
          gmv_cents?: number | null
        }
      }
      /** Append-only log of Resend delivery webhook events (delivered, bounced,
       *  complained, etc.). Service-role only — see migration 037 (RLS enabled
       *  with no policies). */
      email_events: {
        Row: {
          id: string
          message_id: string
          recipient: string
          event_type:
            | 'sent'
            | 'delivered'
            | 'delivery_delayed'
            | 'bounced'
            | 'complained'
            | 'opened'
            | 'clicked'
            | 'failed'
          payload: Record<string, unknown>
          created_at: string
        }
        Insert: {
          id?: string
          message_id: string
          recipient: string
          event_type:
            | 'sent'
            | 'delivered'
            | 'delivery_delayed'
            | 'bounced'
            | 'complained'
            | 'opened'
            | 'clicked'
            | 'failed'
          payload: Record<string, unknown>
          created_at?: string
        }
        Update: Record<string, never>
      }
      /** One row per reminder actually emitted, per arrival per person per
       *  tier — migration 076. `stream_id` is the arrival's FIRST block, not
       *  every block in it: a shift is stored as several rows and reminders
       *  are sent once per physical arrival. Written only by
       *  `_emit_shift_reminders`; RLS is on with no policies, so nothing in
       *  the app can read or write it. */
      shift_reminders: {
        Row: {
          id: string
          stream_id: string
          recipient_role: 'host' | 'moderator'
          recipient_ref: string
          tier: '48h' | '24h' | '2h'
          sent_at: string
        }
        Insert: Record<string, never>
        Update: Record<string, never>
      }
      /** Migration 089. Moderator pool per brand — mirrors brand_hosts, admin-only. */
      brand_moderators: {
        Row: {
          brand_id: string
          moderator_id: string
          created_at: string
        }
        Insert: {
          brand_id: string
          moderator_id: string
          created_at?: string
        }
        Update: Record<string, never>
      }
      /** Migration 089. One row per textable phone; a dual-role worker maps
       *  the same phone to both their host_id and moderator_id. Admin-only. */
      sms_contacts: {
        Row: {
          phone_e164: string
          host_id: string | null
          moderator_id: string | null
          opt_in_at: string | null
          opt_in_source: string | null
          opted_out_at: string | null
          created_at: string
        }
        Insert: {
          phone_e164: string
          host_id?: string | null
          moderator_id?: string | null
          opt_in_at?: string | null
          opt_in_source?: string | null
          opted_out_at?: string | null
          created_at?: string
        }
        Update: {
          host_id?: string | null
          moderator_id?: string | null
          opt_in_at?: string | null
          opt_in_source?: string | null
          opted_out_at?: string | null
        }
      }
      /** Migration 089. Singleton runtime config for the auto-scheduler.
       *  Admin read/update only. */
      scheduler_runtime: {
        Row: {
          singleton: boolean
          enabled: boolean
          dry_run: boolean
          lookahead_days: number
          expiry_same_day_minutes: number
          expiry_soon_minutes: number
          expiry_later_minutes: number
          escalate_before_minutes: number
          quiet_start_hour: number
          quiet_end_hour: number
          daily_send_cap: number
          escalation_phone_e164: string | null
          /** NULL = all brands; otherwise the pilot allowlist. */
          brand_allowlist: string[] | null
          updated_at: string
        }
        Insert: {
          singleton?: boolean
          enabled?: boolean
          dry_run?: boolean
          lookahead_days?: number
          expiry_same_day_minutes?: number
          expiry_soon_minutes?: number
          expiry_later_minutes?: number
          escalate_before_minutes?: number
          quiet_start_hour?: number
          quiet_end_hour?: number
          daily_send_cap?: number
          escalation_phone_e164?: string | null
          brand_allowlist?: string[] | null
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          dry_run?: boolean
          lookahead_days?: number
          expiry_same_day_minutes?: number
          expiry_soon_minutes?: number
          expiry_later_minutes?: number
          escalate_before_minutes?: number
          quiet_start_hour?: number
          quiet_end_hour?: number
          daily_send_cap?: number
          escalation_phone_e164?: string | null
          brand_allowlist?: string[] | null
          updated_at?: string
        }
      }
      /** Migration 089. One open run (touching stream rows on one brand
       *  missing the same role). Admin read-only — written by the engine. */
      coverage_requests: {
        Row: {
          id: string
          run_key: string
          role: 'host' | 'moderator'
          brand_id: string
          stream_ids: string[]
          run_start: string
          run_end: string
          status: 'open' | 'escalated' | 'parked' | 'filled' | 'resolved'
          escalated_at: string | null
          closed_at: string | null
          created_at: string
        }
        Insert: Record<string, never>
        Update: Record<string, never>
      }
      /** Migration 089. One SMS offer to one candidate for one request.
       *  Admin read-only. */
      coverage_offers: {
        Row: {
          id: string
          request_id: string
          worker_id: string
          phone_e164: string
          reply_code: string
          state: 'pending' | 'yes' | 'no' | 'timeout' | 'stale' | 'dry_run'
          sent_at: string
          expires_at: string
          responded_at: string | null
        }
        Insert: Record<string, never>
        Update: Record<string, never>
      }
      /** Migration 089. Outbound SMS queue (offers + escalations). Admin read-only. */
      sms_outbox: {
        Row: {
          id: string
          to_e164: string
          body: string
          kind: 'offer' | 'escalation'
          offer_id: string | null
          request_id: string | null
          state: 'queued' | 'accepted' | 'failed' | 'canceled' | 'dry_run'
          attempts: number
          next_attempt_at: string
          provider_sid: string | null
          last_error: string | null
          created_at: string
          accepted_at: string | null
        }
        Insert: Record<string, never>
        Update: Record<string, never>
      }
      /** Migration 089. One row per shift the bot actually booked. Admin
       *  read-only via the table; undo goes through sched_undo_bot_booking(). */
      bot_bookings: {
        Row: {
          id: string
          request_id: string
          offer_id: string
          role: 'host' | 'moderator'
          worker_id: string
          stream_ids: string[]
          booked_at: string
          undone_at: string | null
          undone_by: string | null
        }
        Insert: Record<string, never>
        Update: Record<string, never>
      }
    }
    Functions: {
      is_admin: {
        Args: Record<string, never>
        Returns: boolean
      }
      is_scheduler: {
        Args: Record<string, never>
        Returns: boolean
      }
      /** Migration 089. Admin-only undo for a bot booking: clears the role the
       *  bot set (only on rows still holding that worker, not yet started).
       *  p_refill=false parks the run instead of letting the bot re-offer it. */
      sched_undo_bot_booking: {
        Args: { p_booking: string; p_refill?: boolean }
        Returns: number
      }
    }
  }
}

export type Profile        = Database['public']['Tables']['profiles']['Row']
export type Host           = Database['public']['Tables']['hosts']['Row']
/** Non-admin code paths must use this type — `rate_cents` is admin-only.
 *  Mirrors ModeratorPublic (host pay must not leak to producers or to the
 *  calendar's serialized host list). Trigger in migration 046 enforces the
 *  write side at the DB. */
export type HostPublic     = Omit<Host, 'rate_cents'>
/** Explicit column list for `.select(...)` on `hosts` from non-admin callers. */
/** NOTE: `email` and `phone` are NOT here. Migration 066 revoked those columns
 *  from the `authenticated` role, because the hosts SELECT policy lets ANY
 *  signed-in user read every row — so anyone holding a token could pull the
 *  whole contractor contact list straight off the API. Admins read them through
 *  the admin_host_contacts() accessor instead. Adding either column back here
 *  makes PostgREST fail the ENTIRE query, not return null. */
/*  self_moderating and monthly_gmv_goal_cents ARE here (migration 075). Both
 *  are granted to `authenticated` in that migration, which is what makes them
 *  safe to list — a column grant is deny-by-default, so listing a column the
 *  grant does not cover is what breaks the whole query. Neither is pay: one is
 *  how someone works, the other is the host's own target, which they are meant
 *  to see. */
export const HOST_PUBLIC_COLUMNS =
  'id, name, user_id, is_active, self_moderating, monthly_gmv_goal_cents, created_at' as const

/** Columns for the "link an account" pickers on the admin roster pages.
 *
 *  Those pages were doing `profiles.select('*')` and handing the whole array to
 *  a client component, which put every user's phone number AND their height,
 *  weight, hair colour, eye colour and clothing/shoe sizes into the RSC payload
 *  and every browser cache — to populate a dropdown that renders an email.
 *
 *  Not a privilege boundary (the pages are admin-only), but it is the same
 *  needless over-fetch of real PII that the brand calendar was already fixed
 *  for, and exactly what CLAUDE.md rule 25 exists to prevent. Grep the managers
 *  for what they actually read: id, email, full_name, role — nothing else. */
export const PROFILE_PICKER_COLUMNS =
  'id, email, full_name, role' as const
export type Brand          = Database['public']['Tables']['brands']['Row']
/** Non-admin code paths must use this type — `client_rate_cents` and
 *  `contracted_hours_per_month` are admin-only.
 *  See migrations 034/042 + the BRAND_PUBLIC_COLUMNS constant below. Triggers
 *  in migrations 036/042 enforce the write side at the DB. */
export type BrandPublic    = Omit<Brand, 'client_rate_cents' | 'contracted_hours_per_month'>
/** Explicit column list for `.select(...)` on `brands` from non-admin callers.
 *  Mirrors `BrandPublic`. Keep in sync if the Brand row gains new sensitive
 *  fields; default to "non-admin sees less" when in doubt. */
export const BRAND_PUBLIC_COLUMNS =
  'id, name, email, user_id, block_size_minutes, day_start_minutes, day_end_minutes, logo_path, created_at' as const
/** Brand columns excluding ONLY the pay-sensitive pricing (client_rate_cents,
 *  contracted_hours_per_month) — those are column-locked at the DB in migration
 *  055, so a `select('*')` would be denied. Unlike BRAND_PUBLIC_COLUMNS this
 *  keeps producer_id + color (needed by the calendar / brand editor / schedule).
 *  Admins read the pricing separately via the admin_brand_pricing() RPC. */
export const BRAND_NONPRICING_COLUMNS =
  'id, name, email, user_id, block_size_minutes, day_start_minutes, day_end_minutes, logo_path, producer_id, color, created_at' as const
export type Producer       = Database['public']['Tables']['producers']['Row']
export type Moderator      = Database['public']['Tables']['moderators']['Row']
/** Non-admin code paths must use this type — `rate_cents` is admin-only.
 *  Producers can see/manage the moderator roster but not their pay. */
export type ModeratorPublic = Omit<Moderator, 'rate_cents'>
/** Explicit column list for `.select(...)` on `moderators` from non-admin callers. */
/** `email` / `phone` omitted — see HOST_PUBLIC_COLUMNS and migration 066.
 *  Admins read them via admin_moderator_contacts(). */
export const MODERATOR_PUBLIC_COLUMNS =
  'id, name, user_id, is_active, created_at' as const
export type Stream         = Database['public']['Tables']['streams']['Row']
export type BrandHost          = Database['public']['Tables']['brand_hosts']['Row']
export type Notification       = Database['public']['Tables']['notifications']['Row']
export type BrandHostRequest   = Database['public']['Tables']['brand_host_requests']['Row']
export type ShiftCancellationRequest = Database['public']['Tables']['shift_cancellation_requests']['Row']
export type EmailEvent         = Database['public']['Tables']['email_events']['Row']

// Excludes reminder_sent_at since the calendar/dashboard don't need it, and
// host_rate_cents (pay-sensitive frozen rate) which the calendar must never
// serialize to non-admin clients.
export interface StreamWithRelations extends Omit<Stream, 'reminder_sent_at' | 'host_rate_cents'> {
  host:      { id: string; name: string } | null
  brand:     { id: string; name: string }
  producer:  { id: string; name: string } | null
  moderator: { id: string; name: string } | null
}

// --- Auto-scheduler (migration 089). Every surface here is admin-only. ---
export type BrandModerator    = Database['public']['Tables']['brand_moderators']['Row']
export type SmsContact        = Database['public']['Tables']['sms_contacts']['Row']
export type SchedulerRuntime  = Database['public']['Tables']['scheduler_runtime']['Row']
export type CoverageRequest   = Database['public']['Tables']['coverage_requests']['Row']
export type CoverageOffer     = Database['public']['Tables']['coverage_offers']['Row']
export type SmsOutboxRow      = Database['public']['Tables']['sms_outbox']['Row']
export type BotBooking        = Database['public']['Tables']['bot_bookings']['Row']
