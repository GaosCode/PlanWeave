# A2 work coordination — final report

**Status:** DONE & committed on `feature/a2-work-coordination` (commit `3e1c7de`).
**Depends on:** A1 (`feature/server-foundation`, commit `1de6d5f`).
**Touched contract version:** CONTRACTS-v1.

## Files added (strictly within `packages/server/src/work/**`)

- `types.ts` — domain types (WorkTask / WorkAssignment / WorkSubmission / WorkReview / WorkTaskPolicy) + `WorkError` matching CONTRACTS-v1 codes + command shapes (idempotency key + `expectedVersion` semantics).
- `migrations.ts` — `workMigrations` (v2) + `applyWorkMigrations`. Kept in this package so A1's `migrations.ts` stays untouched. Integration PR folds this into the central array.
- `repository.ts` — CRUD helpers using A1's `UnitOfWork`.
- `services.ts` — `claimTask` / `heartbeat` / `submit` / `review` / `withdraw` / `reclaimExpiredLeases`. Plain functions, no HTTP coupling. Every mutating command runs through A1's `executeIdempotent`.
- `ids.ts` — public surface.
- `README.md` — design + integration notes.
- `__tests__/helpers.ts`, `__tests__/work.test.ts` — real SQLite, no mocks.

## One boundary crossing (intentional, documented in commit message)

- `packages/server/package.json` — extended the `test` script glob to include `packages/server/src/work/__tests__/*.test.ts` so the package-level test command discovers the new work tests. The A1 test file at `packages/server/src/__tests__/store.test.ts` is unmodified and still passes.

## Design (one paragraph)

Every state-changing command takes a `WorkCommandBase` with `deviceId`, `idempotencyKey` (16-128 ASCII), `aggregateType/Id`, `expectedVersion` (omit on creation), `projectId`, `actorId`, and the body. The service validates inputs, then runs `executeIdempotent` with a `UnitOfWork` that batches the row write + `appendEvent` + `audit` in one transaction. The "exactly one active assignment per task" invariant is enforced by a SQLite-level `UNIQUE INDEX ... WHERE status='active'`. A claim uses `INSERT OR IGNORE` — the partial index silently drops losers, and the service translates the dropped row to `version_conflict` with `details.currentVersion = <winner-version>` per the spec. Lease reclaim transitions `active → expired` and bumps the task version; assignment rows, branches, and submissions are preserved.

## Acceptance test results

`pnpm --filter @planweave-ai/server typecheck` → OK
`pnpm --filter @planweave-ai/server test` → **10/10 pass** (2 test files: A1 `store.test.ts` + A2 `work.test.ts`)
`pnpm lint` → OK across all 5 packages
`pnpm test` (full monorepo) → **1430/1430 pass** across 198 test files

Acceptance scenarios from RFC §A2, all verified:

| # | Scenario | Result |
|---|----------|--------|
| 1 | 20 barrier-synchronized claims for one task | exactly 1 active assignment; 19 get `version_conflict` / `state_conflict` |
| 2 | Repeated submit / heartbeat with same idempotency key | `replayed: true`, identical body, no extra event / audit / idempotency row |
| 3 | Lease expiry: `reclaimExpiredLeases` | flips status to `expired`, task back to `ready` and version bumped, branch/base preserved, `task.lease_expired` event emitted |
| 4 | Dependency not ready | `state_conflict` with `details.blockingDependencyIds = ['task_dep-prereq']` |
| 5 | Parallel vs locked policy | parallel task → 2 active assignments across 2 different tasks; locked task → second claim rejected |
| 6 | Stale `expectedVersion` | `version_conflict` with `currentVersion = 2` (after winner's bump) |

## Open coordination items for downstream

1. **Integration PR** (post-A2/A3/A4): wire `workMigrations` into `packages/server/src/migrations.ts` (or call `applyWorkMigrations` after `applyMigrations` in `lifecycle.ts`).
2. **A7/A8 HTTP layer**: translate JSON bodies into `*Command` objects; map `WorkError` codes to `ApiError` envelope (status codes per CONTRACTS-v1: 409 for the three conflict codes).
3. **A4 events**: project `task.claimed / task.heartbeated / task.submitted / task.reviewed / task.lease_expired / task.withdrawn` into `EventEnvelopeV1` over the WebSocket. Aggregate types are `task` / `assignment` / `submission`.
4. **A5 runtime parity**: mirror the state transitions in file-backed mode (existing `claimScheduler.ts:28-99`).
5. **A9 merge queue**: consumes `WorkSubmission.headCommit` as the immutable review target.

Branch is ready for orchestrator MR / merge. No push performed.
