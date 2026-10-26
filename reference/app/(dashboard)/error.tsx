'use client'

/**
 * Error boundary for every dashboard route.
 *
 * WHY THIS EXISTS. The app had NO error boundary anywhere — no error.tsx, no
 * global-error.tsx. In the Next.js App Router that means any uncaught throw in
 * a server component propagates to the root, and the user gets a bare
 * "Application error: a server-side exception has occurred (Digest: …)" with
 * nothing else on screen. One failing query took down the whole page.
 *
 * That is not hypothetical here: src/lib/supabase/fetchAll.ts THROWS on a page
 * error rather than returning a short list — deliberately, because a silently
 * truncated payroll is worse than a visible failure. But "visible failure" only
 * works if something catches it and says so.
 *
 * With this boundary the rest of the app (sidebar, nav, other routes) keeps
 * working, the user gets a Try again button, and the digest is shown so it can
 * be matched against the server log instead of being guessed at.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-lg font-semibold text-foreground">
          This page didn&apos;t load
        </h1>
        <p className="text-sm text-muted-foreground">
          Something went wrong fetching the data for this page. The rest of the
          app should still work — try again, or pick another page from the menu.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground font-mono break-all">
            Reference: {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
