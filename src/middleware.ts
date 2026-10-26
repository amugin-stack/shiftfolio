import { NextResponse, type NextRequest } from 'next/server'

/** The portfolio is a static, synthetic demonstration of the scheduler. */
export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  const isAsset = path === '/favicon.ico' || path.startsWith('/_next/static/')

  if (path === '/' || isAsset) {
    const response = NextResponse.next()
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
    return response
  }

  // Includes copied login, dashboard, API, and image proxy routes.
  return new NextResponse('Not found', { status: 404 })
}

export const config = {
  matcher: '/:path*',
}
