# Shiftfolio roadmap

This roadmap tracks the portfolio demo, separate from the original production application. The current local implementation and its verification are described in [Verification](VERIFICATION.md).

## Implemented

- A synthetic sample week with a custom calendar, team roster, and projected payroll.
- Local shift creation, editing, deletion, search, week navigation, assignment conflict checks, reset, and sample CSV export.
- Browser-local persistence, with no account or database setup for the demo.
- Original application routes kept as reference material outside the active route tree.
- Local unit and synthetic harness checks, lint, build, and browser walkthrough recorded in the verification notes.

## Release completed — October 8, 2026

The synthetic portfolio is published at [amugin-stack/shiftfolio](https://github.com/amugin-stack/shiftfolio). All release gates passed for the initial reviewed release commit `7daad2803dd2cc19fd122192a9f77220c041d773`: local tests, lint, build, browser workflows, independent tree/history privacy review, remote commit match, and [GitHub CI including isolated PostgreSQL integration](https://github.com/amugin-stack/shiftfolio/actions/runs/40249972376).

The completion endpoint is a public, reproducible, synthetic-only repository with screenshots, documentation, and green CI. No deployment is included.

## Future maintenance

- Keep privacy, tests, lint, PostgreSQL checks and build passing on every change.
- Review new fixtures and screenshots before committing them.
- Keep reference routes disconnected from the running demo.
- Any expansion to the complete authenticated product or production deployment is a separate project.
