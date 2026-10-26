import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Producer } from '@/lib/supabase/types'

export function useProducers(initialProducers?: Producer[]) {
  const [producers, setProducers] = useState<Producer[]>(initialProducers ?? [])
  const [loading, setLoading] = useState(!initialProducers)
  const fetched = useRef(false)

  useEffect(() => {
    if (initialProducers || fetched.current) return
    fetched.current = true
    const supabase = createClient()
    supabase.from('producers').select('*').order('name').then(({ data }) => {
      if (data) setProducers(data)
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { producers, loading }
}
