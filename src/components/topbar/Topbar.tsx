import { createClient } from '@/lib/supabase/server'
import { NotificationBell } from './NotificationBell'
import { MobileSidebar, type MobileSidebarProps } from '@/components/sidebar/MobileSidebar'
import type { Notification } from '@/lib/supabase/types'

interface TopbarProps {
  userId: string
  /** Sidebar nav data forwarded into the mobile drawer. On desktop the
   *  drawer's trigger is `md:hidden` so this content goes unrendered. */
  sidebarProps: MobileSidebarProps
}

export async function Topbar({ userId, sidebarProps }: TopbarProps) {
  // Bell is visible to everyone — RLS scopes notifications to recipient_id.
  // Admins see incoming brand_request + booking events; hosts see only the
  // results of their own brand requests (approved/denied).
  const supabase = await createClient()
  const { data } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', userId)
    .is('dismissed_at', null)
    .order('created_at', { ascending: false })
    .limit(50)

  const initial = (data as Notification[] | null) ?? []

  return (
    <div className="h-12 flex-shrink-0 border-b border-border bg-card flex items-center justify-between px-2 md:px-4 md:justify-end">
      <MobileSidebar {...sidebarProps} />
      <NotificationBell userId={userId} initial={initial} />
    </div>
  )
}
