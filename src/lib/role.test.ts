import { describe, it, expect, vi, beforeEach } from 'vitest'

// next/headers cookies() is server-only. Mock it before importing the module
// under test so resolveRole's `await cookies()` returns a deterministic value.
const cookieStore = new Map<string, { value: string }>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
  }),
}))

// Import after the mock is registered.
const { resolveRole, resolveUserRoles, getProducerBrandIds, VIEW_AS_HOST_COOKIE } = await import(
  './role'
)

import type { Profile } from '@/lib/supabase/types'

// ============================================================
// Mock Supabase client helpers
// ============================================================
//
// resolveUserRoles does:
//   supabase.from(table).select(cols).eq('user_id', userId).maybeSingle()
//
// getProducerBrandIds does:
//   supabase.from('brands').select('id').eq('producer_id', producerId)
//
// Both patterns produce a thenable at the end of the chain. Build a tiny
// chainable that resolves to whatever the test set up.

interface MockResult {
  data: unknown
  error: { message: string } | null
}

function buildSupabaseMock(perTable: Record<string, MockResult>) {
  const calls: Array<{ table: string; cols: string; eqs: Array<[string, unknown]>; terminal: 'maybeSingle' | 'thenable' }> = []

  function chain(table: string, cols: string) {
    const state = { eqs: [] as Array<[string, unknown]> }
    const builder = {
      eq(col: string, val: unknown) {
        state.eqs.push([col, val])
        return builder
      },
      maybeSingle() {
        calls.push({ table, cols, eqs: state.eqs, terminal: 'maybeSingle' })
        const r = perTable[table] ?? { data: null, error: null }
        return Promise.resolve(r)
      },
      // For getProducerBrandIds — terminal is the chain itself (await on the builder).
      then(resolve: (v: MockResult) => unknown) {
        calls.push({ table, cols, eqs: state.eqs, terminal: 'thenable' })
        const r = perTable[table] ?? { data: [], error: null }
        return Promise.resolve(r).then(resolve)
      },
    }
    return builder
  }

  return {
    client: {
      from: (table: string) => ({
        select: (cols: string) => chain(table, cols),
      }),
    },
    calls,
  }
}

// ============================================================
// resolveRole — cookie-driven effective admin
// ============================================================

describe('resolveRole', () => {
  beforeEach(() => {
    cookieStore.clear()
  })

  it('null profile → all flags false', async () => {
    const r = await resolveRole(null)
    expect(r).toEqual({ actualIsAdmin: false, viewingAsHost: false, effectiveIsAdmin: false })
  })

  it('non-admin profile → not admin regardless of cookie', async () => {
    cookieStore.set(VIEW_AS_HOST_COOKIE, { value: '1' })
    const profile = { role: 'user' } as unknown as Profile
    const r = await resolveRole(profile)
    expect(r).toEqual({ actualIsAdmin: false, viewingAsHost: false, effectiveIsAdmin: false })
  })

  it('admin without view-as-host cookie → effective admin', async () => {
    const profile = { role: 'admin' } as unknown as Profile
    const r = await resolveRole(profile)
    expect(r).toEqual({ actualIsAdmin: true, viewingAsHost: false, effectiveIsAdmin: true })
  })

  it('admin with cookie=1 → viewing as host, effective NOT admin', async () => {
    cookieStore.set(VIEW_AS_HOST_COOKIE, { value: '1' })
    const profile = { role: 'admin' } as unknown as Profile
    const r = await resolveRole(profile)
    expect(r).toEqual({ actualIsAdmin: true, viewingAsHost: true, effectiveIsAdmin: false })
  })

  it('admin with cookie set to any other value → effective admin (cookie must equal "1")', async () => {
    cookieStore.set(VIEW_AS_HOST_COOKIE, { value: '0' })
    const profile = { role: 'admin' } as unknown as Profile
    const r = await resolveRole(profile)
    expect(r.viewingAsHost).toBe(false)
    expect(r.effectiveIsAdmin).toBe(true)
  })

  it('exports VIEW_AS_HOST_COOKIE constant', () => {
    expect(VIEW_AS_HOST_COOKIE).toBe('view_as_host')
  })
})

// ============================================================
// resolveUserRoles — multi-role flag resolution
// ============================================================

const USER_ID = '00000000-0000-0000-0000-000000000001'

describe('resolveUserRoles', () => {
  it('no role rows → everything false, ids null, rate 0', async () => {
    const { client, calls } = buildSupabaseMock({
      hosts: { data: null, error: null },
      producers: { data: null, error: null },
      moderators: { data: null, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = await resolveUserRoles(client as any, USER_ID, false)
    expect(roles).toEqual({
      isAdmin: false,
      isHost: false,
      isProducer: false,
      isModerator: false,
      isScheduler: false,
      hostId: null,
      producerId: null,
      moderatorId: null,
      isDeactivated: false,
    })
    // Confirms the three filter calls all targeted user_id
    expect(calls.map(c => c.table).sort()).toEqual(['hosts', 'moderators', 'producers'])
    for (const c of calls) {
      expect(c.eqs).toEqual([['user_id', USER_ID]])
    }
  })

  it('pure-host user → isHost only', async () => {
    const { client } = buildSupabaseMock({
      hosts: { data: { id: 'h1' }, error: null },
      producers: { data: null, error: null },
      moderators: { data: null, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = await resolveUserRoles(client as any, USER_ID, false)
    expect(roles.isHost).toBe(true)
    expect(roles.hostId).toBe('h1')
    expect(roles.isProducer).toBe(false)
    expect(roles.isModerator).toBe(false)
    expect(roles.isScheduler).toBe(false)
  })

  it('pure-producer user (not admin) → isScheduler FALSE (producers are view-only now)', async () => {
    const { client } = buildSupabaseMock({
      hosts: { data: null, error: null },
      producers: { data: { id: 'p1' }, error: null },
      moderators: { data: null, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = await resolveUserRoles(client as any, USER_ID, false)
    expect(roles.isProducer).toBe(true)
    expect(roles.producerId).toBe('p1')
    expect(roles.isScheduler).toBe(false) // ← producers no longer schedule (admin-only)
    expect(roles.isAdmin).toBe(false)
  })

  it('pure-moderator user → isModerator + moderatorId, not a scheduler', async () => {
    const { client } = buildSupabaseMock({
      hosts: { data: null, error: null },
      producers: { data: null, error: null },
      moderators: { data: { id: 'm1' }, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = await resolveUserRoles(client as any, USER_ID, false)
    expect(roles.isModerator).toBe(true)
    expect(roles.moderatorId).toBe('m1')
    expect(roles.isScheduler).toBe(false) // moderator alone is not a scheduler
  })

  it('multi-role user (host + moderator) → both flags set, scheduler still false', async () => {
    const { client } = buildSupabaseMock({
      hosts: { data: { id: 'h1' }, error: null },
      producers: { data: null, error: null },
      moderators: { data: { id: 'm1', rate_cents: 3000 }, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = await resolveUserRoles(client as any, USER_ID, false)
    expect(roles.isHost).toBe(true)
    expect(roles.isModerator).toBe(true)
    expect(roles.isScheduler).toBe(false)
  })

  it('admin caller (effectiveIsAdmin=true) → isAdmin + isScheduler true even with no role rows', async () => {
    const { client } = buildSupabaseMock({
      hosts: { data: null, error: null },
      producers: { data: null, error: null },
      moderators: { data: null, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = await resolveUserRoles(client as any, USER_ID, true)
    expect(roles.isAdmin).toBe(true)
    expect(roles.isScheduler).toBe(true)
    expect(roles.isHost).toBe(false)
    expect(roles.isProducer).toBe(false)
  })

  it('non-admin (effectiveIsAdmin=false) who is host+producer → isScheduler FALSE (only admins schedule)', async () => {
    const { client } = buildSupabaseMock({
      hosts: { data: { id: 'h1' }, error: null },
      producers: { data: { id: 'p1' }, error: null },
      moderators: { data: null, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles = await resolveUserRoles(client as any, USER_ID, false)
    expect(roles.isAdmin).toBe(false)
    expect(roles.isHost).toBe(true)
    expect(roles.isProducer).toBe(true)
    expect(roles.isScheduler).toBe(false)
  })
})

// ============================================================
// getProducerBrandIds — brand list lookup
// ============================================================

const PRODUCER = '00000000-0000-0000-0000-0000000000aa'

describe('getProducerBrandIds', () => {
  it('returns just the ids array when rows are present', async () => {
    const { client, calls } = buildSupabaseMock({
      brands: { data: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }], error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = await getProducerBrandIds(client as any, PRODUCER)
    expect(ids).toEqual(['b1', 'b2', 'b3'])
    expect(calls[0]).toEqual({
      table: 'brands',
      cols: 'id',
      eqs: [['producer_id', PRODUCER]],
      terminal: 'thenable',
    })
  })

  it('returns [] when the producer has no assigned brands', async () => {
    const { client } = buildSupabaseMock({
      brands: { data: [], error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = await getProducerBrandIds(client as any, PRODUCER)
    expect(ids).toEqual([])
  })

  it('returns [] when data is null (treats as empty)', async () => {
    const { client } = buildSupabaseMock({
      brands: { data: null, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = await getProducerBrandIds(client as any, PRODUCER)
    expect(ids).toEqual([])
  })
})

// ============================================================
// isDeactivated — removed workers lose access (the support team 2026-08-25, mig 054/058)
// ============================================================

describe('resolveUserRoles → isDeactivated', () => {
  const active = (extra: object = {}) => ({ id: 'h1', is_active: true, ...extra })
  const inactive = (extra: object = {}) => ({ id: 'h1', is_active: false, ...extra })

  async function resolve(
    rows: { hosts?: unknown; producers?: unknown; moderators?: unknown },
    isAdmin = false,
  ) {
    const { client } = buildSupabaseMock({
      hosts: { data: rows.hosts ?? null, error: null },
      producers: { data: rows.producers ?? null, error: null },
      moderators: { data: rows.moderators ?? null, error: null },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return resolveUserRoles(client as any, USER_ID, isAdmin)
  }

  it('deactivated host with no other role → blocked', async () => {
    expect((await resolve({ hosts: inactive() })).isDeactivated).toBe(true)
  })

  it('active host → not blocked', async () => {
    expect((await resolve({ hosts: active() })).isDeactivated).toBe(false)
  })

  it('deactivated moderator with no other role → blocked', async () => {
    const r = await resolve({ moderators: { id: 'm1', rate_cents: 3300, is_active: false } })
    expect(r.isDeactivated).toBe(true)
  })

  it('deactivated as host but STILL ACTIVE as moderator → not blocked', async () => {
    // Dual-role people must not be locked out by one stale record.
    const r = await resolve({
      hosts: inactive(),
      moderators: { id: 'm1', rate_cents: 3300, is_active: true },
    })
    expect(r.isDeactivated).toBe(false)
  })

  it('deactivated in BOTH roles → blocked', async () => {
    const r = await resolve({
      hosts: inactive(),
      moderators: { id: 'm1', rate_cents: 3300, is_active: false },
    })
    expect(r.isDeactivated).toBe(true)
  })

  it('a brand-new account with NO roles is never "deactivated"', async () => {
    // Must fall through to normal onboarding, not be told access was removed.
    expect((await resolve({})).isDeactivated).toBe(false)
  })

  it('an admin is never blocked, even with a deactivated host record', async () => {
    // Locking an admin out of their own tool would be unrecoverable.
    expect((await resolve({ hosts: inactive() }, true)).isDeactivated).toBe(false)
  })

  it('a producer is never blocked, even with a deactivated host record', async () => {
    const r = await resolve({ hosts: inactive(), producers: { id: 'p1' } })
    expect(r.isDeactivated).toBe(false)
  })
})
