'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils'

interface PayrollTabsProps {
  active: 'hosts' | 'moderators'
  monthKey: string
}

export function PayrollTabs({ active, monthKey }: PayrollTabsProps) {
  return (
    <div className="inline-flex items-center gap-1 p-1 bg-card border border-border rounded-md">
      <TabLink href={`/admin/payroll/hosts?month=${monthKey}`} active={active === 'hosts'}>
        Hosts
      </TabLink>
      <TabLink href={`/admin/payroll/moderators?month=${monthKey}`} active={active === 'moderators'}>
        Moderators
      </TabLink>
    </div>
  )
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'px-3 py-1.5 text-sm font-medium rounded transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
      )}
    >
      {children}
    </Link>
  )
}
