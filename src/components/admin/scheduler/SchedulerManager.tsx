'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { BrandPublic, SchedulerRuntime, SmsOutboxRow } from '@/lib/supabase/types'
import { SchedulerSettingsCard } from './SchedulerSettingsCard'
import { BotBookingsSection, type BotBookingRow } from './BotBookingsSection'
import { RequestsSection, type RequestRow } from './RequestsSection'
import { TextsSection } from './TextsSection'
import { PoolsContactsSection, type ContactWorker } from './PoolsContactsSection'

interface Props {
  runtime: SchedulerRuntime
  brands: BrandPublic[]
  botBookings: BotBookingRow[]
  requests: RequestRow[]
  texts: SmsOutboxRow[]
  moderators: { id: string; name: string; is_active: boolean }[]
  moderatorPool: Map<string, Set<string>>
  contacts: ContactWorker[]
}

const TABS = ['Settings', 'Bookings', 'Requests', 'Texts', 'Pools & contacts'] as const
type Tab = (typeof TABS)[number]

export function SchedulerManager({ runtime, brands, botBookings, requests, texts, moderators, moderatorPool, contacts }: Props) {
  const [tab, setTab] = useState<Tab>('Settings')
  const [currentRuntime, setCurrentRuntime] = useState(runtime)

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-bold">Auto-scheduler</h1>
        <p className="text-sm text-muted-foreground mt-1">
          The bot texts hosts and moderators to fill empty shifts. UI checks here are for
          convenience only — every write is still enforced admin-only at the database.
        </p>
      </div>

      <nav className="flex flex-wrap gap-1 border-b" aria-label="Auto-scheduler sections">
        {TABS.map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Settings' && (
        <SchedulerSettingsCard runtime={currentRuntime} brands={brands} onSaved={setCurrentRuntime} />
      )}
      {tab === 'Bookings' && <BotBookingsSection initialRows={botBookings} />}
      {tab === 'Requests' && <RequestsSection rows={requests} />}
      {tab === 'Texts' && <TextsSection rows={texts} />}
      {tab === 'Pools & contacts' && (
        <PoolsContactsSection
          brands={brands}
          moderators={moderators}
          initialModeratorPool={moderatorPool}
          initialContacts={contacts}
        />
      )}
    </div>
  )
}
