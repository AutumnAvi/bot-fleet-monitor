# Bot Fleet monitor

Read-only status dashboard for Avi Weinreb's Grok Bots across two accounts (work + Leaf). Avi only, password-protected.

This repository was seeded on 2026-11-24 with mockups and a work-account roster. The v1 app is built on branch `feat/v1`.

- Light list UI (primary): `docs/mockups/bot-fleet-light.jpg`
- Activity feed reference (dark): `docs/mockups/bot-fleet-dark-feed.jpg`
- Work-account roster seed: `docs/roster-seed.json`

v1 is ingest-only: bots push status while they are already working. The dashboard never polls or wakes bots.
