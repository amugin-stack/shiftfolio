import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SignOutButton } from '@/components/auth/SignOutButton'

interface PastPay {
  id: string
  start_time: string
  end_time: string
  brand_name: string | null
  role: string
  total_cents: number
  setup_cents: number
}

export default async function PastPayPage({ searchParams }: {
  searchParams: Promise<{ before?: string; id?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const cursor = await searchParams
  const validCursor = cursor.before && Number.isFinite(Date.parse(cursor.before))
    && cursor.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)
  // Auth and completed-only restrictions are also enforced inside this RPC.
  const { data, error } = await supabase.rpc('get_my_completed_pay_page', {
    p_before_start: validCursor ? cursor.before : null,
    p_before_id: validCursor ? cursor.id : null,
    p_limit: 50,
  })
  const rows = (data ?? []) as PastPay[]
  const last = rows.at(-1)
  const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
  const time = (iso: string) => new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(new Date(iso))
  return (
    <main className="max-w-3xl mx-auto p-6 space-y-5">
      <h1 className="text-2xl font-semibold">Your past pay</h1>
      <p className="text-sm text-muted-foreground">Read-only pay for your completed work. All times are Pacific.</p>
      {error ? <p role="alert">We couldn’t load your pay. Please refresh to try again.</p> : (
        <>
          {rows.length === 0 ? <p>No completed work on this page.</p> : (
            <ul className="space-y-3">
              {rows.map(row => <li key={`${row.role}-${row.id}`} className="border rounded-lg p-4">
                <p className="font-medium">{row.brand_name ?? 'Other paid work'} · {row.role}</p>
                <p className="text-sm">{time(row.start_time)} – {time(row.end_time)}</p>
                <p>{money(row.total_cents)}{row.setup_cents > 0 ? ` (includes ${money(row.setup_cents)} preparation pay)` : ''}</p>
              </li>)}
            </ul>
          )}
          {rows.length === 50 && last && <Link className="block underline" href={`/past-pay?before=${encodeURIComponent(last.start_time)}&id=${encodeURIComponent(last.id)}`}>Older work</Link>}
          {validCursor && <Link className="block underline" href="/past-pay">Most recent work</Link>}
        </>
      )}
      <SignOutButton />
    </main>
  )
}
