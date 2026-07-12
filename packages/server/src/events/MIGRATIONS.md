# A4 — events schema migration (integration note for orchestrator)

## Status

A4 (`packages/server/src/events/**`) adds a private `events_schema_migrations` table
and a `subscribers` table for live subscriber state (eventing state, not domain state).
These are **not** wired into the v1 domain migration in `packages/server/src/migrations.ts`
because A4 is restricted to `packages/server/src/events/**` and must not modify
A1's migration runner.

## What A4 ships

- `packages/server/src/events/migrations.ts`
  - Exports `applyEventsMigrations(database)` and `eventsMigrations` (currently a single
    version-1 migration that creates `subscribers` and `events_schema_migrations`).
- `packages/server/src/events/index.ts`
  - Re-exports `applyEventsMigrations` and `eventsMigrations` for the integration PR.

## What the integration PR must do

1. In `packages/server/src/migrations.ts`:
   - Add `applyEventsMigrations(database)` to the migration runner, called once after
     the v1 domain migrations. The events migrations use their own
     `events_schema_migrations` table so they are independent of the v1 domain
     `schema_migrations` table.
2. In `packages/server/src/lifecycle.ts` (or wherever migrations are invoked at startup):
   - Call `applyEventsMigrations(database)` after `applyMigrations(database)`.
3. Bump the schema version check or document that `events_schema_migrations` is a
   separate, additive subsystem. The two schema-version trackers are independent.

## Schema added by the events v1 migration

```sql
CREATE TABLE IF NOT EXISTS subscribers (
  subscriber_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_seen_event_id TEXT NOT NULL DEFAULT '0',
  queue_size INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT NOT NULL,
  connected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscribers_project ON subscribers(project_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_user ON subscribers(user_id);
```

The `subscribers` table tracks LIVE subscriber state (eventing state). It is
intentionally separate from the v1 domain tables (`projects`, `domain_events`, etc.).
A `subscribers` row exists only while a WebSocket is connected; the row is deleted
when the subscriber disconnects, the publisher marks it for close, or the heartbeat
sweep detects a dead client.
