# Architecture

Shiftfolio is a standalone Next.js 15 and React 19 App Router demo. Its active route tree contains a single root page, which renders a client-side weekly schedule, payroll preview, and team roster. The sample week begins October 5, 2026. Fictional workers, channels, shifts, and rates are defined in the demo model.

## Offline boundary

The original application used Supabase authentication and Postgres storage, with server-rendered queries and message delivery functions. Its original routes are retained under `reference/app`, outside Next.js's active `src/app` tree. Middleware denies non-root application paths. Supabase client entrypoints are disabled in this copy; there is no environment file or live service connection needed to run the demo. The original production deployment and configuration are outside this repository.

The root demo reads deterministic seed shifts, then checks browser local storage for saved edits. Creating, editing, and deleting shifts updates local React state and local storage. **Reset demo** restores the seed shifts and fixed sample week. Payroll CSV export creates a browser-side Blob from the displayed fictional records. No shift change or export is sent to a server.

## Reused logic and presentation

The portfolio schedule is a custom weekly grid. The original FullCalendar views remain in the reference source, but they do not render in the live demo. The demo reuses the original assignment conflict helper to reject a host or moderator with overlapping shifts and a payout helper to project pay from scheduled time and sample rates. The surrounding shell, roster, seed scenario, and local editing flow are portfolio-specific presentation work.

The original application uses a Pacific-time wall-clock convention for stream timestamps. The fixed demo dates and selected helper calls should continue to receive explicit time-boundary checks, especially around daylight-saving changes.

## Verification

Run `npm test`, `npm run lint`, `npm run build`, and `npm run scan:privacy` from the repository root. The normal test script runs unit tests and checked-in synthetic regression harnesses, including disabled Edge entrypoint checks. PostgreSQL concurrency tests have a separate CI job with an isolated database; they were not run in the local browser verification. See [local verification](VERIFICATION.md) for observed results and the [roadmap](ROADMAP.md) for remaining publication checks.
