import type { Migration } from "./types.js";

/**
 * Server-scoped Owner Fleet semantic lift for stock hosts (Phase A / plan §5.1).
 *
 * No schema change is required: exclusive workspace binding in `workspace_agent_hosts`
 * is no longer a usability gate. Host auth, heartbeat, and fleet membership semantics
 * use Server-scoped Host credential state. Legacy projection rows stay in place for
 * enrollment migration and runtime evidence; this migration is an idempotent marker so
 * upgrades record that stock hosts remain usable without destructive wipe.
 *
 * Regression coverage: `stockHostFleetMigration.test.ts`.
 */
export const stockHostFleetMigration: Migration = {
  version: 46,
  sql: "SELECT 1;"
};
