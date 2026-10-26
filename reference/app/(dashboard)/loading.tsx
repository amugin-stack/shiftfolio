/**
 * Instant loading state for every dashboard page.
 *
 * WHY THIS EXISTS. The app had no loading.tsx, no error.tsx and no Suspense
 * boundary anywhere. In the Next.js App Router that means a navigation has
 * nothing to render optimistically: clicking a sidebar link left the PREVIOUS
 * page frozen on screen, with no spinner and no visual acknowledgement, until
 * the entire server render finished — auth, roles, and every query. The app
 * was not just slow, it gave no sign it had heard the click, which reads as
 * "broken" rather than "loading".
 *
 * Next renders this file the instant a navigation starts, so feedback is
 * immediate regardless of how long the data takes. It also gives <Link>
 * prefetching a boundary to stop at.
 *
 * Deliberately a neutral shell rather than a per-page skeleton: this one file
 * covers every route under (dashboard), and a shape that guesses wrong is more
 * jarring than a plain one. Individual routes can add their own loading.tsx
 * later if a closer match is worth it.
 */
export default function DashboardLoading() {
  return (
    <div className="h-full p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="animate-pulse space-y-6">
        {/* Page title + action button */}
        <div className="flex items-center justify-between gap-4">
          <div className="h-7 w-48 rounded-md bg-secondary" />
          <div className="h-9 w-28 rounded-md bg-secondary" />
        </div>

        {/* Body: a few rows of content blocks */}
        <div className="space-y-3">
          <div className="h-24 rounded-xl bg-secondary" />
          <div className="h-24 rounded-xl bg-secondary" />
          <div className="h-24 rounded-xl bg-secondary" />
          <div className="h-24 rounded-xl bg-secondary" />
        </div>
      </div>
    </div>
  )
}
