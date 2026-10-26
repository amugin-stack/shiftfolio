'use client'

import { useState, useEffect } from 'react'
import { UserCircle2, Phone, Ruler, Scale, Palette, Eye, Shirt, Footprints, Mail, Link as LinkIcon } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/lib/supabase/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface HostProfileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** profiles.id of the user this host is linked to. Pass null when there's no linked account. */
  userId: string | null
  /** Display name to show in the title even before the profile loads. */
  displayName: string
}

export function HostProfileDialog({ open, onOpenChange, userId, displayName }: HostProfileDialogProps) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [headshotUrl, setHeadshotUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !userId) {
      setProfile(null)
      setHeadshotUrl(null)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    const supabase = createClient()

    supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error: e }) => {
        if (cancelled) return
        if (e) { setError(e.message); setLoading(false); return }
        const p = data as Profile | null
        setProfile(p)
        if (p?.headshot_path) setHeadshotUrl(`/api/headshot/${userId}`)
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [open, userId])

  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : displayName.slice(0, 2).toUpperCase()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[90vw] sm:!max-w-5xl w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl">Host profile</DialogTitle>
        </DialogHeader>

        {!userId ? (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground italic">
              {displayName} isn’t linked to a user account, so there’s no profile yet.
            </p>
          </div>
        ) : loading ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
            {error}
          </p>
        ) : !profile ? (
          <p className="text-sm text-muted-foreground italic">No profile data found.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-[auto,1fr] gap-8 py-4">
            {/* Left: Big avatar + name + email */}
            <div className="flex flex-col items-center md:items-start gap-3">
              <div className="w-56 h-56 md:w-64 md:h-64 rounded-full bg-secondary border-2 border-primary/20 flex items-center justify-center overflow-hidden">
                {headshotUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={headshotUrl}
                    alt={profile.full_name ?? displayName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-6xl font-bold text-primary">{initials}</span>
                )}
              </div>
              <div className="text-center md:text-left max-w-[16rem]">
                <p className="text-xl font-bold text-foreground truncate">
                  {profile.full_name || displayName}
                </p>
                <p className="text-sm text-muted-foreground inline-flex items-center gap-1.5 mt-1 truncate">
                  <Mail className="w-3.5 h-3.5 shrink-0" /> {profile.email}
                </p>
                {profile.role === 'admin' && (
                  <span className="inline-block text-[10px] uppercase tracking-wider text-primary font-semibold bg-primary/15 px-2 py-0.5 rounded-full mt-2">
                    Admin
                  </span>
                )}
              </div>
            </div>

            {/* Right: Detail grid */}
            <div className="space-y-4">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold pb-2 border-b border-border">
                Profile details
              </h3>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-5">
                <DetailRow icon={Phone}      label="Phone"       value={profile.phone} />
                <DetailRow icon={Ruler}      label="Height"      value={profile.height} />
                <DetailRow icon={Scale}      label="Weight"      value={profile.weight} />
                <DetailRow icon={Palette}    label="Hair color"  value={profile.hair_color} />
                <DetailRow icon={Eye}        label="Eye color"   value={profile.eye_color} />
                <DetailRow icon={Shirt}      label="Top size"    value={profile.top_size} />
                <DetailRow icon={Shirt}      label="Bottom size" value={profile.bottom_size} />
                <DetailRow icon={Footprints} label="Shoe size"   value={profile.shoe_size} />
              </div>

              {!profile.headshot_path && (
                <p className="text-xs text-muted-foreground italic inline-flex items-center gap-1.5 pt-3 border-t border-border">
                  <UserCircle2 className="w-3.5 h-3.5" />
                  Profile incomplete — headshot not uploaded.
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailRow({
  icon: Icon, label, value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | null | undefined
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
        <p className="text-base text-foreground mt-0.5 truncate">
          {value && value.trim() ? value : <span className="text-muted-foreground italic">—</span>}
        </p>
      </div>
    </div>
  )
}

// Suppress unused import warning
void LinkIcon
