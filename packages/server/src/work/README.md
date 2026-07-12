# A2 — Transactional Work Coordination

Application services for server-coordinated task ownership, leases, submissions, and review on top of the A1 authoritative store.

## Public surface

Everything an HTTP/WS layer (A7/A8) needs is exported from [`ids.ts`](./ids.ts):

- `WorkError` — error class with a `code` and a structured `details` payload. Application services throw these; the HTTP layer maps to the `ApiError` envelope from `CONTRACTS-v1.md`.
- `createWorkRepository(database)` — durable row read/write helpers.
- `createWorkServices({ repository, now? })` — application services (`claimTask`, `heartbeat`, `submit`, `review`, `withdraw`, `reclaimExpiredLeases`).
- `applyWorkMigrations(database)` and `workMigrations` — the v2 schema additions. These are kept in this package so A1's `migrations.ts` stays untouched; the integration PR folds `workMigrations` into the central `migrations` array (or calls `applyWorkMigrations` after `applyMigrations`).

## Domain model

| Aggregate | Purpose | Key invariants |
|-----------|---------|----------------|
| `WorkTask` | Server binding of a PlanWeave task id (per project). Owns dependency snapshot. | `version` is the optimistic lock. `status` flows `planned → ready → leased → submitted → accepted/expired/needs_changes/withdrawn`. |
| `WorkAssignment` | Claim / lease row. | UNIQUE partial index `WHERE status='active'` — at most one active row per `(project, task)`. `version` increments on every state change. |
| `WorkSubmission` | Submitted head commit for an assignment. | `head_commit` is the immutable review target. |
| `WorkReview` | Verdict on a submission. | `verdict ∈ {accepted, needs_changes}`. Drives the next task status. |

## Command surface

Every state-changing command is a plain TypeScript function that returns `{ replayed, value, eventIds }`. The command body is wrapped in `executeIdempotent` (from A1) with:

- a validated `Idempotency-Key` (16..128 ASCII printable, per CONTRACTS-v1 §"Mutating-command consistency")
- `expectedVersion` for commands that mutate an existing aggregate
- a `UnitOfWork` that batches `INSERT assignment/submission/review` + `appendEvent` + `audit` into one transaction

The HTTP layer never touches SQL; it only:

1. Validates the JSON body
2. Builds a `*Command` object from the request
3. Calls the matching `services.*` function
4. Maps the `WorkError` to the wire `ApiError` envelope

## Concurrency

The claim transaction uses `INSERT OR IGNORE` into `work_assignments` with a `UNIQUE INDEX ... WHERE status='active'`. The partial index is the database-level serialization point — exactly one row can hold `status='active'` for a given `(project_id, task_id)`. Other transactions that try to insert silently get `changes = 0`, and the service translates that to `version_conflict` with `details.currentVersion = <winner-version>` so the client can refresh and retry.

For 20 concurrent claims, the test in `__tests__/work.test.ts` exercises the barrier pattern with a shared `Promise`; the partial UNIQUE index guarantees exactly one active row regardless of how SQLite serializes the BEGIN IMMEDIATE write lock.

## Conflict semantics

| Condition | Code | `details` |
|-----------|------|-----------|
| Caller's `expectedVersion` is stale | `version_conflict` | `{ aggregateType, aggregateId, currentVersion, expectedVersion }` |
| Task has an active assignment (parallel/lock) | `version_conflict` | `{ aggregateType:"task", aggregateId, currentVersion }` (currentVersion reflects the winner's bump) |
| Dependency is not in a terminal-success state | `state_conflict` | `{ aggregateType:"task", aggregateId, blockingDependencyIds: [...] }` |
| Caller retries a non-`active`/`needs_changes` assignment | `state_conflict` | `{ aggregateType:"assignment", aggregateId }` |
| Idempotency key reused with a different fingerprint | `idempotency_key_reused` | (thrown by A1's `executeIdempotent`; HTTP layer maps to 409) |

The HTTP status code mapping is fixed by CONTRACTS-v1: `version_conflict` / `state_conflict` / `idempotency_key_reused` → 409.

## Lease expiry

`reclaimExpiredLeases(now?)` is a server-owned function. It runs in a single `executeIdempotent` write transaction that:

1. Scans `work_assignments WHERE status='active' AND lease_expires_at <= now`
2. For each: transitions `status` from `active` to `expired`, bumps the task version, appends a `task.lease_expired` event, and writes an audit row
3. **Does not** delete the assignment row or any submission branch — those remain visible to the contributor and the merge queue

The function is callable from a `StartupReconciliationHook` (registered in `lifecycle.ts`'s second argument) or from a periodic timer; both are out of scope for A2 and belong to A10.

## Schema (v2, additive)

`work_tasks`, `work_task_dependencies`, `work_assignments` (with the UNIQUE partial index), `work_submissions`, `work_reviews`. Foreign keys reference `projects(id)`, `work_tasks(id)`, `work_assignments(id)`, and `work_submissions(id)`.

## Integration with the rest of the project

- A1 — `migrations.ts`, `store.ts`, `sqlite.ts`, `lifecycle.ts`. This package reuses `executeIdempotent` and `UnitOfWork` directly; no fork.
- A4 — durable events. The work package emits `task.claimed`, `task.heartbeated`, `task.submitted`, `task.reviewed`, `task.lease_expired`, `task.withdrawn` to `domain_events`; A4's WebSocket notifier projects these into `EventEnvelopeV1` envelopes.
- A5 — runtime parity. `packages/runtime` should eventually mirror these transitions in file-backed mode; that parity suite is A5's deliverable.
- A7/A8 — HTTP/WS wiring. The application services are pure functions; HTTP layer translates `WorkError` to the wire envelope and back.
- A9 — merge queue. `WorkSubmission.headCommit` is the immutable head the merge queue operates on.
