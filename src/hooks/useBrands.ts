import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { BRAND_PUBLIC_COLUMNS, type Brand } from '@/lib/supabase/types'

// Client-side hook: never fetch the sensitive client_rate_cents column.
// Admin surfaces that need pricing fetch brands server-side with an explicit
// column list.
export function useBrands(initialBrands?: Brand[]) {
  const [brands, setBrands] = useState<Brand[]>(initialBrands ?? [])
  const [loading, setLoading] = useState(!initialBrands)
  const fetched = useRef(false)

  useEffect(() => {
    if (initialBrands || fetched.current) return
    fetched.current = true
    const supabase = createClient()
    supabase.from('brands').select(BRAND_PUBLIC_COLUMNS).order('name').then(({ data }) => {
      if (data) setBrands(data as unknown as Brand[])
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { brands, loading }
}
