'use client'

/**
 * Last-resort boundary: catches throws in the ROOT layout itself, which the
 * per-route error.tsx cannot. Must render its own <html>/<body> because it
 * replaces the root layout entirely.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem 1.5rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ fontSize: '0.875rem', color: '#666', marginTop: '0.5rem' }}>
          The app hit an unexpected error. Try again, or reload the page.
        </p>
        {error.digest && (
          <p style={{ fontSize: '0.75rem', color: '#888', fontFamily: 'monospace', marginTop: '0.5rem' }}>
            Reference: {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          style={{ marginTop: '1.25rem', padding: '0.5rem 1rem', fontSize: '0.875rem', cursor: 'pointer' }}
        >
          Try again
        </button>
      </body>
    </html>
  )
}
