'use client'

import { useState } from 'react'
import { Shield, ShieldOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Profile, UserRole } from '@/lib/supabase/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'

interface UsersManagerProps {
  initialProfiles: Profile[]
  currentUserId: string
}

interface PendingChange {
  profile: Profile
  newRole: UserRole
}

export function UsersManager({ initialProfiles, currentUserId }: UsersManagerProps) {
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles)
  const [pending, setPending] = useState<PendingChange | null>(null)
  const [working, setWorking] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()

  async function applyRoleChange() {
    if (!pending) return
    setWorking(true)
    const { profile, newRole } = pending

    const { data, error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', profile.id)
      .select()
      .single()

    setWorking(false)

    if (error || !data) {
      toast({
        title: 'Error',
        description: error?.message ?? 'Could not update role.',
        variant: 'destructive',
      })
    } else {
      setProfiles(prev => prev.map(p => p.id === profile.id ? data : p))
      toast({
        title: newRole === 'admin' ? 'Promoted to admin' : 'Demoted to user',
        description: profile.email,
      })
    }
    setPending(null)
  }

  const adminCount = profiles.filter(p => p.role === 'admin').length

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">Users & Admins</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage which user accounts have admin access. {adminCount} admin{adminCount === 1 ? '' : 's'} total.
          </p>
        </div>
      </div>

      {profiles.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-sm">No registered users yet.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Name</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Email</th>
                <th className="text-left px-4 py-3 text-muted-foreground font-medium">Role</th>
                <th className="text-right px-4 py-3 text-muted-foreground font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p, i) => {
                const isSelf = p.id === currentUserId
                const isAdmin = p.role === 'admin'
                const isLastAdmin = isAdmin && adminCount === 1
                const canDemote = isAdmin && !isSelf && !isLastAdmin

                return (
                  <tr
                    key={p.id}
                    className={`border-b border-border last:border-0 ${i % 2 === 0 ? '' : 'bg-secondary/20'}`}
                  >
                    <td className="px-4 py-3 font-medium text-foreground">
                      {p.full_name || <span className="text-muted-foreground italic">No name</span>}
                      {isSelf && (
                        <span className="ml-2 text-[11px] text-muted-foreground">(you)</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{p.email}</td>
                    <td className="px-4 py-3">
                      {isAdmin ? (
                        <Badge className="gap-1 bg-primary/15 text-primary hover:bg-primary/15 border-primary/30">
                          <Shield className="w-2.5 h-2.5" />
                          Admin
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">User</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isAdmin ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs gap-1.5"
                          disabled={!canDemote}
                          onClick={() => setPending({ profile: p, newRole: 'user' })}
                          title={
                            isSelf
                              ? "You can't demote yourself"
                              : isLastAdmin
                                ? "Can't demote the last admin"
                                : 'Demote to user'
                          }
                        >
                          <ShieldOff className="w-3.5 h-3.5" />
                          Demote
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs gap-1.5 text-primary hover:text-primary"
                          onClick={() => setPending({ profile: p, newRole: 'admin' })}
                        >
                          <Shield className="w-3.5 h-3.5" />
                          Make Admin
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog open={!!pending} onOpenChange={open => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.newRole === 'admin' ? 'Promote to admin?' : 'Demote to user?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.newRole === 'admin' ? (
                <>
                  <span className="font-medium text-foreground">{pending?.profile.email}</span> will
                  gain full admin access — they&apos;ll be able to manage hosts, brands, producers,
                  and other users.
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">{pending?.profile.email}</span> will
                  lose admin access and only see streams they&apos;re assigned to.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={working}
              onClick={e => { e.preventDefault(); applyRoleChange() }}
            >
              {working ? 'Saving…' : pending?.newRole === 'admin' ? 'Promote' : 'Demote'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
