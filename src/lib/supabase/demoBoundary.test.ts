import { describe, expect, it } from 'vitest'
import { createClient as createBrowserClient } from './client'
import { createClient as createServerClient } from './server'

describe('portfolio demo Supabase boundary', () => {
  it('always rejects browser client construction', () => {
    expect(() => createBrowserClient()).toThrow('Supabase is disabled in the portfolio demo')
  })

  it('always rejects server client construction', async () => {
    await expect(createServerClient()).rejects.toThrow('Supabase is disabled in the portfolio demo')
  })
})
