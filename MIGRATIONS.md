# A3 Migration Integration Notes

This document accompanies the A3 work package and explains the per-module
migration approach used in this branch. It exists so the integration PR that
wires the per-module migrations into `packages/server/src/migrations.ts` can
land after A2/A3/A4 without further coordination.

## Per-module migrations

A3 adds four migration files under the new modules. Each is independently
applicable, so they are stored next to the module that owns the schema:

| File | Module version | Owning module | Notes |
|------|----------------|----------------|-------|
| `packages/server/src/identity/migrations.ts` | 2 | identity | Adds `users`, `devices`, `invitations`, `sessions`. Also seeds the `_system` project row required by the strict `domain_events.project_id` foreign key. |
| `packages/server/src/planning/migrations.ts` | 3 | planning | Adds `rooms`, `messages` plus BEFORE UPDATE / BEFORE DELETE triggers that make messages immutable. |
| `packages/server/src/proposals/migrations.ts` | 4 | proposals | Adds `proposals`, `proposal_revisions` (UNIQUE on `(proposal_id, revision_number)`), and `approvals` (UNIQUE on `(revision_id, approver_user_id)`). |
| `packages/server/src/attachments/migrations.ts` | 5 | attachments | Adds `attachments` with a CHECK constraint covering `staged`, `ready`, `failed`, and `superseded` (used for cross-project dedup). |

Each module exports a `migrations` array of `{ version, sql }` records and an
`applyXxxMigrations(database)` runner that reuses the same `schema_migrations`
table as the central runner. The runner is intentionally inlined in each
module's `migrations.ts` so modules stay self-contained and do not import
from a shared helper that lives outside any of the allowed paths.

## Why a separate `_system` project

The A1 v1 schema has `domain_events.project_id TEXT NOT NULL REFERENCES
projects(id)`. Identity-only aggregates (users, devices, sessions) have no
natural project context, so the identity v2 migration seeds a single
reserved `_system` project row. All identity events use this project id; the
integration PR is not required to filter them out, but downstream event
consumers (A4) may choose to do so.

## How the integration PR lands

The integration PR is a one-line follow-up that:

1. Imports the per-module `migrations` arrays from
   `packages/server/src/identity/migrations.js`,
   `packages/server/src/planning/migrations.js`,
   `packages/server/src/proposals/migrations.js`, and
   `packages/server/src/attachments/migrations.js`.
2. Concatenates them into the central `migrations` array in
   `packages/server/src/migrations.ts`.
3. Bumps the `applyMigrations` readiness / latest-version check in
   `packages/server/src/lifecycle.ts` from `1` to `5` so the `readiness()`
   payload reflects the new schema version.

After that, the per-module runners can either be kept as a developer
convenience or removed once every consumer of the server constructs
`SqliteDatabase` through `startPlanweaveServer`.

## Test discovery note

`packages/server/package.json`'s `test` script was updated from
`vitest run packages/server/src/__tests__/*.test.ts` to
`vitest run packages/server/src` so it picks up tests under each module's
`__tests__/` directory (which is what the A3 spec requires). The directory
form is the one vitest interprets as a file path rather than a test name
filter.
