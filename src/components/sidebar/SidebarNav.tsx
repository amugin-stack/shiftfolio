'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { Users, Building2, Mic, Shield, LogOut, Plus, Eye, ShieldCheck, ClipboardList, ClipboardCheck, Settings, LayoutDashboard, Megaphone, Wallet, CalendarRange, TrendingUp, GraduationCap, MessageSquareText } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Brand, Profile } from '@/lib/supabase/types'
import { cn } from '@/lib/utils'
import { BrandLogo } from '@/components/brand/BrandLogo'
import { BrandCalendarPicker } from './BrandCalendarPicker'
import { RequestBrandsButton } from './RequestBrandsButton'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toggleViewAsHost } from '@/lib/view-as-actions'

// `adminOnly` excludes producers. Payroll is admin's accounting concern
// (host/moderator $$), /admin/users edits roles, and /admin/brands is the
// producer-assignment surface — all locked to real admins. Dashboard is
// visible to producers but the page itself scopes to their assigned brands
// and hides revenue $$ (see /admin/dashboard/page.tsx).
// `matchPrefix` keeps the link highlighted across nested routes (e.g. Payroll
// stays active on both /admin/payroll/hosts and /admin/payroll/moderators).
// When unset, active state requires an exact pathname match.
const adminLinks: {
  href: string
  label: string
  icon: typeof Users
  adminOnly?: boolean
  matchPrefix?: string
}[] = [
  { href: '/admin/dashboard',      label: 'Dashboard',  icon: LayoutDashboard },
  { href: '/admin/performance',    label: 'Performance', icon: TrendingUp,     adminOnly: true, matchPrefix: '/admin/performance' },
  { href: '/admin/payroll/hosts',  label: 'Payroll',    icon: Wallet,          adminOnly: true, matchPrefix: '/admin/payroll/' },
  { href: '/admin/hosts',          label: 'Hosts',      icon: Users,           adminOnly: true },
  { href: '/admin/brands',         label: 'Brands',     icon: Building2,       adminOnly: true },
  { href: '/admin/producers',      label: 'Producers',  icon: Mic,             adminOnly: true },
  { href: '/admin/moderators',     label: 'Moderators', icon: Megaphone,       adminOnly: true },
  { href: '/admin/unavailability', label: 'Unavailability', icon: CalendarRange, adminOnly: true },
  { href: '/admin/scheduler',      label: 'Auto-scheduler', icon: MessageSquareText, adminOnly: true },
  { href: '/admin/extra-pay',      label: 'Extra Pay',  icon: GraduationCap,   adminOnly: true },
  { href: '/admin/users',          label: 'Admins',     icon: Shield,          adminOnly: true },
]

export interface SidebarNavProps {
  profile: Profile | null
  brands: Brand[]
  actualIsAdmin: boolean
  viewingAsHost: boolean
  hasHostProfile: boolean
  isProducer: boolean
  isModerator: boolean
  headshotUrl?: string | null
  userId: string
  /** Called when the user taps a nav link or the sign-out button. Mobile
   *  uses this to close the off-canvas sheet so the page navigation lands
   *  cleanly. Desktop omits this prop and the callback is a no-op. */
  onNavigate?: () => void
}

export function SidebarNav({
  profile,
  brands,
  actualIsAdmin,
  viewingAsHost,
  hasHostProfile,
  isProducer,
  isModerator,
  headshotUrl,
  userId,
  onNavigate,
}: SidebarNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  // Effective admin = real admin AND not currently impersonating a host
  const isAdmin = actualIsAdmin && !viewingAsHost
  const [avatarOpen, setAvatarOpen] = useState(false)

  async function handleSignOut() {
    onNavigate?.()
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : profile?.email?.slice(0, 2).toUpperCase() ?? '??'

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-4 py-5 flex items-center gap-3">
        <Image
          src="/Studio-Gradient-Icon.png"
          alt="Studio"
          width={32}
          height={32}
          priority
          className="w-8 h-8 rounded-lg flex-shrink-0 object-contain"
        />
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground leading-none">Studio</p>
          <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">Internal Scheduler</p>
        </div>
      </div>

      <Separator />

      {/* Main nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {/* Calendars section */}
        <div className="pb-1 px-3">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Calendars</p>
        </div>

        {brands.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground italic">
            No calendars yet.
          </p>
        ) : isAdmin ? (
          // Admins can accrue many brands — collapse the list into a searchable
          // dropdown. Non-admins keep the plain list (they're scoped to a few).
          <BrandCalendarPicker brands={brands} onNavigate={onNavigate} />
        ) : (
          brands.map(brand => {
            const href = `/calendar/${brand.id}`
            const active = pathname === href || pathname?.startsWith(`${href}/`)
            return (
              <Link
                key={brand.id}
                href={href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                <BrandLogo name={brand.name} logoPath={brand.logo_path} size="xs" fallbackIcon />
                <span className="truncate">{brand.name}</span>
              </Link>
            )
          })
        )}

        {/* Master Schedule — admin-only cross-brand overview of all lives. */}
        {isAdmin && (
          <Link
            href="/master-schedule"
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
              pathname === '/master-schedule'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <CalendarRange className="w-4 h-4 flex-shrink-0" />
            Master Schedule
          </Link>
        )}

        {isAdmin && (
          <Link
            href="/admin/brands"
            onClick={onNavigate}
            className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-primary transition-colors"
          >
            <Plus className="w-4 h-4 flex-shrink-0" />
            Add Brand
          </Link>
        )}

        {/* Request Brands is a HOST action (ask an admin to be added to a
            brand). Only hosts see it — producers are view-only and moderators
            are assigned by admins, so it was misleading UI for them. */}
        {!isAdmin && hasHostProfile && (
          <RequestBrandsButton userId={userId} />
        )}

        {/* My Shifts — hosts see their bookings, moderators see their flat-rate assignments */}
        {(hasHostProfile || isModerator) && (
          <Link
            href="/my-shifts"
            onClick={onNavigate}
            className={cn(
              'mt-4 flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
              pathname === '/my-shifts'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
          >
            <ClipboardList className="w-4 h-4 flex-shrink-0" />
            My Shifts
          </Link>
        )}

        {/* My Assignments — producers only (moderators get My Shifts instead).
             No pay info on this page — producers don't work hourly. */}
        {isProducer && (
          <Link
            href="/assignments"
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
              !hasHostProfile && !isModerator && 'mt-4',
              pathname === '/assignments'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
          >
            <ClipboardCheck className="w-4 h-4 flex-shrink-0" />
            My Assignments
          </Link>
        )}

        {/* Admin section — also visible to producers, minus Dashboard + Admins */}
        {(isAdmin || isProducer) && (
          <>
            <div className="pt-4 pb-1 px-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                {isAdmin ? 'Admin' : 'Manage'}
              </p>
            </div>
            {adminLinks
              .filter(({ adminOnly }) => isAdmin || !adminOnly)
              .map(({ href, label, icon: Icon, matchPrefix }) => {
                const active = matchPrefix
                  ? pathname?.startsWith(matchPrefix) ?? false
                  : pathname === href
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={onNavigate}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                    )}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    {label}
                  </Link>
                )
              })}
          </>
        )}
      </nav>

      <Separator />

      {/* View-as-host toggle (real admins only) */}
      {actualIsAdmin && (
        <div className="px-3 pt-3">
          {viewingAsHost && (
            <p className="mb-2 px-2 py-1 text-[10px] font-semibold text-primary bg-primary/15 rounded-md text-center uppercase tracking-wider">
              Viewing as host
            </p>
          )}
          <form action={toggleViewAsHost}>
            <Button
              type="submit"
              variant={viewingAsHost ? 'default' : 'outline'}
              size="sm"
              className="w-full justify-center gap-2 h-8"
              onClick={() => onNavigate?.()}
            >
              {viewingAsHost ? (
                <>
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Back to Admin
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5" />
                  View as Host
                </>
              )}
            </Button>
          </form>
        </div>
      )}

      {/* User footer */}
      <div className="px-3 py-3">
        <div className="flex items-center gap-2.5 mb-2">
          <button
            type="button"
            onClick={() => setAvatarOpen(true)}
            className="rounded-full ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 hover:opacity-80 transition-opacity"
            aria-label="View your profile photo"
          >
            <div className="w-8 h-8 rounded-full overflow-hidden bg-primary/20 flex items-center justify-center flex-shrink-0">
              {headshotUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={headshotUrl}
                  alt={profile?.full_name ?? 'Avatar'}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-primary text-xs font-semibold">{initials}</span>
              )}
            </div>
          </button>
          <div className="min-w-0 flex-1">
            {profile?.full_name && (
              <p className="text-xs font-medium text-foreground truncate">{profile.full_name}</p>
            )}
            <p className="text-[10px] text-muted-foreground truncate">{profile?.email}</p>
          </div>
          <Link
            href="/settings/profile"
            onClick={onNavigate}
            aria-label="Profile settings"
            className={cn(
              'flex items-center justify-center w-7 h-7 rounded-md transition-colors flex-shrink-0',
              pathname === '/settings/profile'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
          >
            <Settings className="w-4 h-4" />
          </Link>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground h-8 px-2"
          onClick={handleSignOut}
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign out
        </Button>
      </div>

      {/* Avatar zoom dialog */}
      <Dialog open={avatarOpen} onOpenChange={setAvatarOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{profile?.full_name || 'Your profile'}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-4">
            <div className="w-56 h-56 rounded-full overflow-hidden bg-secondary border-2 border-primary/20 flex items-center justify-center">
              {headshotUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={headshotUrl}
                  alt={profile?.full_name ?? 'Profile photo'}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-5xl font-bold text-primary">{initials}</span>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            {profile?.email}
          </p>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="w-full gap-2 mt-2"
            onClick={() => {
              setAvatarOpen(false)
              onNavigate?.()
            }}
          >
            <Link href="/settings/profile">
              <Settings className="w-3.5 h-3.5" />
              Edit profile
            </Link>
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
