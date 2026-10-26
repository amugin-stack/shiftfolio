import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Profile } from '@/lib/supabase/types'

/**
 * Server-side proxy for headshot images. Avoids the Cloudflare/Supabase
 * Storage CDN edge case where a Chrome Range probe gets a 1-byte response
 * cached as the full image.
 *
 * Auth: caller must be signed in. Admins can fetch any user's headshot;
 * regular users can only fetch their own.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new NextResponse('unauthorized', { status: 401 })

  // Authorization: self or admin
  if (user.id !== userId) {
    const { data: meProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()
    if ((meProfile as Pick<Profile, 'role'> | null)?.role !== 'admin') {
      return new NextResponse('forbidden', { status: 403 })
    }
  }

  // Look up the target user's headshot path
  const { data: targetProfile } = await supabase
    .from('profiles')
    .select('headshot_path')
    .eq('id', userId)
    .single()
  const path = (targetProfile as { headshot_path: string | null } | null)?.headshot_path
  if (!path) return new NextResponse('not found', { status: 404 })

  // Download from Supabase Storage server-side (bypasses Cloudflare edge)
  const { data: blob, error } = await supabase.storage.from('headshots').download(path)
  if (error || !blob) {
    // Log the reason but NOT the storage path — it embeds the user id, and
    // this is a route that serves private files (CLAUDE.md rule 28: no PII in
    // server logs). The message alone distinguishes the cases that matter
    // ("Object not found" vs a permissions failure).
    // eslint-disable-next-line no-console
    console.error('[headshot api] download failed:', error?.message ?? 'no blob returned')
    return new NextResponse('not found', { status: 404 })
  }

  // Previously logged the path, size, MIME type and a hex dump of the first 8
  // bytes on EVERY successful request. That was debug instrumentation from
  // chasing a Cloudflare cache-poisoning bug; the bug is fixed, and it was
  // writing a line (containing a user id) per avatar load ever since.
  const buffer = await blob.arrayBuffer()

  // Use Node Buffer for the response — most reliable across Next/Node Blob impls
  return new NextResponse(Buffer.from(buffer), {
    status: 200,
    headers: {
      'Content-Type':   blob.type || 'image/jpeg',
      'Content-Length': String(buffer.byteLength),
      'Cache-Control':  'private, max-age=86400',
      'Accept-Ranges':  'none',
    },
  })
}

// Force Node.js runtime (not Edge) so Buffer/Blob behave consistently
export const runtime = 'nodejs'
