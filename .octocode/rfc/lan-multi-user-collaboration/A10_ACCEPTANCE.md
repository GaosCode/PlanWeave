# A10 Integration, Fault-Injection, and Security Acceptance

**Run date:** 2026-07-12  
**Baseline:** `5f01a32` plus the A10 working-tree changes listed below  
**Status:** Blocked from final acceptance; Server/CLI A10 scope passes, but one RFC prerequisite and two unrelated Desktop baseline tests remain open.

## Outcome

The integrated Server and remote CLI paths are buildable and their focused suites pass. A10 added attack-oriented and fault-injection coverage and fixed confirmed authorization/path/availability defects. Final acceptance is not claimed because the A2 work-task schema does not persist ownership scopes or acceptance checks, so the Merge Queue cannot yet enforce the RFC's path-boundary policy from authoritative task data.

## Confirmed defects fixed

| Area | Defect | Fix | Verification |
|---|---|---|---|
| Attachments / BOLA | Any contributor in the same project could overwrite or complete another contributor's staged attachment | Restrict mutation to uploader, maintainer, or owner | `attachments.test.ts` cross-user attack |
| Merge queue / BFLA | Enqueue trusted caller-supplied `actorId`, project, and submission commits | Require project membership; with production work schema, require a real project submission, immutable commit match, and assignee/maintainer authority | `mergeQueue.test.ts`; `submissionAuthorization.test.ts` |
| Ownership path matching | `startsWith` allowed `events-rogue/**` to match ownership of `events/**`; traversal/absolute input was not classified early | Normalize repository paths, reject absolute/backslash/traversal input, and require path-segment boundaries | `security.test.ts` |
| Event HTTP availability | Malformed percent-encoding could throw during `decodeURIComponent` | Safe decode and return the standard validation error while keeping the server healthy | `publisher.test.ts` malformed URL plus health check |
| CLI E2E reliability | Tests invoked Corepack/pnpm inside a temporary `HOME`, causing registry access and offline timeouts | Launch the source CLI with the repository-local `tsx` binary | `remoteCliE2e.test.ts` |

## Fault-injection and recovery evidence

| Scenario | Expected invariant | Result |
|---|---|---|
| Exception after project/event/audit writes | Transaction rolls back domain row, event, audit row, and idempotency receipt | Pass |
| Merge worker interrupted in checking/reviewing/merging | Startup reconciliation returns entry to pending and removes worktree best-effort | Existing A9 tests pass |
| Merge conflict, stale target, ancestry failure, check failure | Entry fails/conflicts without losing submitted commit identifiers | Existing A9 tests pass |
| Event drop, duplicate, reorder, slow consumer, missed pong | Client can resync; bounded subscriber is disconnected; dead client removed | Existing A4 tests pass |
| SQLite backup creation | Non-empty file has a valid SQLite header | Pass |
| Server process restart after Agent cancellation | Prior artifact/checkpoint remains recoverable | Existing A6 tests pass |

## Security acceptance matrix

| Vector | Evidence | Verdict |
|---|---|---|
| Authentication/session revocation | Identity and WebSocket suites | Pass |
| Project BOLA/BFLA | Planning cross-project tests, attachment mutation test, merge membership/submission tests | Pass for covered endpoints |
| SQL injection | Dynamic values use prepared statements; backup filename is allowlisted and SQL quotes are escaped | Pass for reviewed server paths |
| Shell command injection | Git/check execution uses `execFile` argument arrays | Pass for reviewed execution path |
| Path traversal | Attachment paths are server-generated; ownership matcher rejects traversal/absolute input | Pass for covered paths |
| Upload size/digest/authorization | Declared and actual size/digest checks; project read authorization; uploader mutation authorization | Pass |
| WebSocket auth/backpressure/revocation | Unauthorized upgrade, queue overflow, heartbeat, session reauthorization tests | Pass |
| Idempotent replay and optimistic conflict | Store, work, proposal, event, merge tests | Pass |
| Ownership-scope enforcement from task policy | Required fields absent from `work_tasks`; `validateAssignmentScope` remains a pass-through | **Blocking gap** |
| Full automated Ghost scan | `~/.ghost/.../cache/repo.md` absent and required `repo-context` skill unavailable | Not run; targeted manual/static review used as fallback |

## Commands and receipts

| Command | Result |
|---|---|
| `pnpm --filter @planweave-ai/server test` | Pass — 11 files, 84 tests |
| `pnpm --filter @planweave-ai/server typecheck` | Pass |
| `pnpm exec vitest run packages/cli/src/__tests__/remoteCliE2e.test.ts` | Pass — 4 tests |
| `pnpm lint` | Pass |
| `pnpm -r build` | Pass; existing Desktop renderer chunk-size warning only |
| `pnpm test` | Not green — after removing CLI/Corepack instability, two existing Desktop assertions remain inconsistent with the current uncommitted localization changes |
| Focused failing Desktop tests | 13 pass, 2 fail: `rendererI18n.test.ts` expects English for a zh-CN label; `todoAndInspectorInteractions.test.tsx` searches English `Source Prompt` while rendered UI uses `源 Prompt` |

## Blocking follow-up

Before marking A10 accepted, add a work-schema migration that persists `ownershipScopes`, protected scopes, reviewers, and acceptance checks; populate them during task binding; load the task/assignment for each submission; obtain changed files from the immutable base/head range; and call the hardened `validatePathWithinScope` before checks or merge. Add positive and negative production-schema integration tests.

The two Desktop test failures should be resolved by the owner of the current Desktop localization changes, because those files were already modified outside A10 and A10 does not rewrite user-owned work.

