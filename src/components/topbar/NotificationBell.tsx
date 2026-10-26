'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  X,
  CalendarPlus,
  CalendarX2,
  UserPlus,
  CheckCircle2,
  XCircle,
  Check,
} from 'lucide-react'
import { formatDistanceToNowStrict } from 'date-fns'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import { formatPT, cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import type { Notification } from '@/lib/supabase/types'

interface NotificationBellProps {
  userId: string
  initial: Notification[]
}

export function NotificationBell({ userId, initial }: NotificationBellProps) {
  const [items, setItems] = useState<Notification[]>(initial)
  const [open, setOpen] = useState(false)
  const { toast } = useToast()

  // Realtime subscription: prepend INSERTs, drop DELETEs from other tabs.
  useEffect(() => {
    const supabase = createClient()
    // Cast around the strict typed-client overload — Database is `any` here so
    // TS picks the wrong overload for postgres_changes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (supabase as any)
      .channel(`notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `recipient_id=eq.${userId}`,
        },
        (payload: { new: Notification }) => {
          if (payload.new.dismissed_at) return
          setItems(prev => {
            if (prev.some(i => i.id === payload.new.id)) return prev
            return [payload.new, ...prev]
          })
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'notifications',
          filter: `recipient_id=eq.${userId}`,
        },
        (payload: { old: { id: string } }) => {
          setItems(prev => prev.filter(i => i.id !== payload.old.id))
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        (payload: { new: Notification }) => {
          setItems(prev => payload.new.dismissed_at
            ? prev.filter(n => n.id !== payload.new.id)
            : prev.map(n => n.id === payload.new.id ? payload.new : n))
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId])

  const unreadCount = useMemo(() => items.filter(i => !i.is_read).length, [items])

  // Mark all unread as read when the panel opens
  async function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && unreadCount > 0) {
      const unreadIds = items.filter(i => !i.is_read).map(i => i.id)
      // Optimistic
      setItems(prev => prev.map(i => (i.is_read ? i : { ...i, is_read: true })))
      const supabase = createClient()
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .in('id', unreadIds)
    }
  }

  async function dismiss(id: string) {
    const supabase = createClient()
    const { error } = await supabase.from('notifications').update({ dismissed_at: new Date().toISOString() }).eq('id', id)
    if (error) {
      toast({ title: 'Could not dismiss notification', description: 'Please try again.', variant: 'destructive' })
      return
    }
    setItems(prev => prev.filter(i => i.id !== id))
  }

  async function clearAll() {
    const supabase = createClient()
    const ids = items.map(n => n.id)
    if (ids.length === 0) return
    const { error } = await supabase.from('notifications').update({ dismissed_at: new Date().toISOString() }).in('id', ids)
    if (error) {
      toast({ title: 'Could not clear notifications', description: 'Please try again.', variant: 'destructive' })
      return
    }
    setItems(prev => prev.filter(n => !ids.includes(n.id)))
  }

  async function decide(n: Notification, approve: boolean) {
    if (!n.request_id) return
    // Optimistically remove this row from the local list. The RPC will also
    // delete every matching pending notification by request_id, so the realtime
    // DELETE event mirrors this for other tabs.
    setItems(prev => prev.filter(i => i.id !== n.id))
    const supabase = createClient()
    // Pick the right decision RPC based on the notification type.
    const rpcName = n.type === 'cancellation_request'
      ? 'decide_cancellation_request'
      : 'decide_brand_request'
    const { error } = await supabase.rpc(rpcName, {
      p_request_id: n.request_id,
      p_approve: approve,
    })
    if (error) {
      toast({
        title: approve ? 'Could not approve' : 'Could not deny',
        description: error.message,
        variant: 'destructive',
      })
      // Best-effort recovery: refetch so the row reappears if it actually
      // wasn't decided. The page will see fresh state via Topbar's server fetch.
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('recipient_id', userId)
        .is('dismissed_at', null)
        .order('created_at', { ascending: false })
        .limit(50)
      setItems((data as Notification[] | null) ?? [])
    } else {
      toast({ title: approve ? 'Request approved' : 'Request denied' })
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
          className="relative inline-flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background"
        >
          <Bell className="w-5 h-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-none flex items-center justify-center">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="w-[400px] p-0 max-h-[520px] overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <p className="text-sm font-semibold text-foreground">Notifications</p>
          {items.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs font-medium text-muted-foreground hover:text-primary transition-colors"
            >
              Clear all
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <Bell className="w-8 h-8 mx-auto text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">No notifications yet.</p>
          </div>
        ) : (
          <ul className="flex-1 overflow-auto divide-y divide-border">
            {items.map(n => (
              <NotificationRow
                key={n.id}
                n={n}
                onDismiss={() => dismiss(n.id)}
                onDecide={approve => decide(n, approve)}
              />
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NotificationRow({
  n,
  onDismiss,
  onDecide,
}: {
  n: Notification
  onDismiss: () => void
  onDecide: (approve: boolean) => void
}) {
  const relative = formatDistanceToNowStrict(new Date(n.created_at), { addSuffix: true })

  // Resolve type-specific shape: icon, tint, message body, and any actions.
  const meta = renderMeta(n)

  return (
    <li
      className={cn(
        'relative px-3 py-3 group hover:bg-secondary/50 transition-colors',
        !n.is_read && 'bg-primary/5',
      )}
    >
      <div className="flex gap-3 pr-6">
        <div
          className={cn(
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            meta.iconBg,
          )}
        >
          <meta.Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground leading-snug">{meta.body}</p>
          {n.body && (n.type === 'cancellation_request') && (
            <p className="mt-1 text-xs text-muted-foreground italic leading-snug">
              &ldquo;{n.body}&rdquo;
            </p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">{relative}</p>

          {(n.type === 'brand_request' || n.type === 'cancellation_request') && (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => onDecide(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:brightness-95 transition-all"
              >
                <Check className="w-3 h-3" />
                Approve
              </button>
              <button
                type="button"
                onClick={() => onDecide(false)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-secondary text-foreground text-xs font-medium hover:bg-secondary/70 transition-colors"
              >
                <X className="w-3 h-3" />
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="absolute top-2 right-2 inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-secondary hover:text-foreground transition-all focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </li>
  )
}

function renderMeta(n: Notification): {
  Icon: typeof Bell
  iconBg: string
  body: React.ReactNode
} {
  switch (n.type) {
    case 'shift_booked':
    case 'shift_cancelled': {
      const isBooked = n.type === 'shift_booked'
      const dateLabel = n.shift_start ? formatPT(n.shift_start, 'EEE, MMM d') : ''
      const startLabel = n.shift_start ? formatPT(n.shift_start, 'h:mm a') : ''
      const endLabel = n.shift_end ? formatPT(n.shift_end, 'h:mm a') : ''
      return {
        Icon: isBooked ? CalendarPlus : CalendarX2,
        iconBg: isBooked ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
        body: (
          <>
            <span className="font-semibold">{n.host_name}</span>{' '}
            <span className="text-muted-foreground">{isBooked ? 'booked' : 'cancelled'}</span>{' '}
            <span className="font-semibold">{n.brand_name}</span>{' '}
            <span className="text-muted-foreground">for</span>{' '}
            <span className="text-muted-foreground">
              {dateLabel} · {startLabel} – {endLabel}
            </span>
          </>
        ),
      }
    }
    case 'shift_edited': {
      const dateLabel = n.shift_start ? formatPT(n.shift_start, 'EEE, MMM d') : ''
      const startLabel = n.shift_start ? formatPT(n.shift_start, 'h:mm a') : ''
      const endLabel = n.shift_end ? formatPT(n.shift_end, 'h:mm a') : ''
      return {
        Icon: CalendarPlus,
        iconBg: 'bg-primary/15 text-primary',
        body: (
          <>
            <span className="font-semibold">{n.brand_name}</span>{' '}
            <span className="text-muted-foreground">shift updated:</span>{' '}
            <span className="text-muted-foreground">
              {dateLabel} · {startLabel} – {endLabel}
            </span>
          </>
        ),
      }
    }
    case 'shift_reminder': {
      const dateLabel = n.shift_start ? formatPT(n.shift_start, 'EEE, MMM d') : ''
      const startLabel = n.shift_start ? formatPT(n.shift_start, 'h:mm a') : ''
      return {
        Icon: Bell,
        iconBg: 'bg-primary/15 text-primary',
        body: (
          <>
            <span className="text-muted-foreground">Shift reminder —</span>{' '}
            <span className="font-semibold">{n.brand_name}</span>{' '}
            <span className="text-muted-foreground">on {dateLabel} at {startLabel}</span>
          </>
        ),
      }
    }
    case 'reminder_delivery_alert':
      return {
        Icon: Bell,
        iconBg: 'bg-primary/15 text-primary',
        body: (
          <>
            <span className="font-semibold">Shift reminder delivery: </span>
            <span className="text-muted-foreground">
              {n.body || 'A reminder needs attention. Check the shift schedule.'}
            </span>
          </>
        ),
      }
    case 'brand_request':
      return {
        Icon: UserPlus,
        iconBg: 'bg-primary/15 text-primary',
        body: (
          <>
            <span className="font-semibold">{n.host_name}</span>{' '}
            <span className="text-muted-foreground">wants to host</span>{' '}
            <span className="font-semibold">{n.brand_name}</span>
          </>
        ),
      }
    case 'brand_request_approved':
      return {
        Icon: CheckCircle2,
        iconBg: 'bg-primary/15 text-primary',
        body: (
          <>
            <span className="text-muted-foreground">You&rsquo;re approved to host</span>{' '}
            <span className="font-semibold">{n.brand_name}</span>
          </>
        ),
      }
    case 'brand_request_denied':
      return {
        Icon: XCircle,
        iconBg: 'bg-muted text-muted-foreground',
        body: (
          <>
            <span className="text-muted-foreground">Your request to host</span>{' '}
            <span className="font-semibold">{n.brand_name}</span>{' '}
            <span className="text-muted-foreground">was denied</span>
          </>
        ),
      }
    case 'cancellation_request': {
      const dateLabel = n.shift_start ? formatPT(n.shift_start, 'EEE, MMM d') : ''
      const startLabel = n.shift_start ? formatPT(n.shift_start, 'h:mm a') : ''
      const endLabel = n.shift_end ? formatPT(n.shift_end, 'h:mm a') : ''
      return {
        Icon: CalendarX2,
        iconBg: 'bg-muted text-muted-foreground',
        body: (
          <>
            <span className="font-semibold">{n.host_name}</span>{' '}
            <span className="text-muted-foreground">wants to cancel</span>{' '}
            <span className="font-semibold">{n.brand_name}</span>{' '}
            <span className="text-muted-foreground">for</span>{' '}
            <span className="text-muted-foreground">
              {dateLabel} · {startLabel} – {endLabel}
            </span>
          </>
        ),
      }
    }
    case 'cancellation_request_approved': {
      const dateLabel = n.shift_start ? formatPT(n.shift_start, 'EEE, MMM d') : ''
      return {
        Icon: CheckCircle2,
        iconBg: 'bg-primary/15 text-primary',
        body: (
          <>
            <span className="text-muted-foreground">Your cancellation for</span>{' '}
            <span className="font-semibold">{n.brand_name}</span>{' '}
            <span className="text-muted-foreground">on {dateLabel} was approved</span>
          </>
        ),
      }
    }
    case 'cancellation_request_denied': {
      const dateLabel = n.shift_start ? formatPT(n.shift_start, 'EEE, MMM d') : ''
      return {
        Icon: XCircle,
        iconBg: 'bg-muted text-muted-foreground',
        body: (
          <>
            <span className="text-muted-foreground">Your cancellation for</span>{' '}
            <span className="font-semibold">{n.brand_name}</span>{' '}
            <span className="text-muted-foreground">on {dateLabel} was denied</span>
          </>
        ),
      }
    }
    default: {
      // Compile-time exhaustiveness check — adding a new notification type
      // without updating this switch will fail typecheck here.
      const _exhaustive: never = n.type
      throw new Error(`Unhandled notification type: ${_exhaustive as string}`)
    }
  }
}
