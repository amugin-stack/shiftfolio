import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getSessionProfile, getSessionRoles, getSessionUser } from '@/lib/auth/session'
import { ExtraPayManager, type ExtraPaySlot } from '@/components/admin/ExtraPayManager'
import { resolveRole } from '@/lib/role'
import { EXTRA_PAY_ENABLED } from '@/lib/extraPay'

// Admin page for setup / training / office-hour paid slots (migration 057).
//
// ADMIN-ONLY, not scheduler-only: these rows carry pay rates, and producers
// must never see pay (CLAUDE.md rule 25). The hosts/moderators pages allow
// schedulers with rates stripped; here the rate IS the record, so there is
// nothing meaningful left after stripping it — so producers are turned away
// entirely. The DB agrees: the write RPCs check is_admin() and the table has
// no write policies at all, so this guard is UX on top of a real boundary.

export default async function ExtraPayPage() {
  const supabase = await createClient()

  const user = await getSessionUser()
  if (!user) redirect('/login')

  const profile = await getSessionProfile(user.id)
  const { effectiveIsAdmin } = await resolveRole(profile)
  const userRoles = await getSessionRoles(user.id, effectiveIsAdmin)
  if (!effectiveIsAdmin) redirect('/calendar')
  if (userRoles.isDeactivated) redirect('/calendar')

  // Feature flag: while off, the page explains itself rather than 404ing, so
  // an admin who finds the nav link isn't left guessing.
  if (!EXTRA_PAY_ENABLED) {
    return (
      <div className="p-6 max-w-lg">
        <h1 className="text-xl font-bold text-foreground">Setup, training &amp; office hours</h1>
        <p className="text-sm text-muted-foreground mt-2">
          This feature is switched off. Turn on EXTRA_PAY_ENABLED once migration 057 has
          been applied to the database.
        </p>
      </div>
    )
  }

  const [{ data: slotsData }, { data: hostsData }, { data: moderatorsData }] = await Promise.all([
    supabase
      .from('extra_pay_slots')
      .select('id, host_id, moderator_id, kind, start_time, end_time, rate_cents, status, notes')
      .order('start_time', { ascending: false }),
    // Only ACTIVE workers are assignable — same rule as the calendar's dropdown
    // (soft-delete, migration 054). Deactivating someone must stop them being
    // scheduled for new paid work without touching what they already did.
    supabase.from('hosts').select('id, name').eq('is_active', true).order('name'),
    // Moderators became assignable in migration 073. Same shape, same rule.
    supabase.from('moderators').select('id, name').eq('is_active', true).order('name'),
  ])

  return (
    <div className="p-6">
      <ExtraPayManager
        initialSlots={(slotsData as ExtraPaySlot[] | null) ?? []}
        hosts={(hostsData as { id: string; name: string }[] | null) ?? []}
        moderators={(moderatorsData as { id: string; name: string }[] | null) ?? []}
      />
    </div>
  )
}
