# Implementation: Complete LAN Team Collaboration

> Decision: see `RFC.md` §Summary and §Rationale and Alternatives.

## Resolved Questions

| Question | Resolution | Evidence | Confidence |
|---|---|---|---|
| Where does collaborative truth live? | Host SQLite and integration repository; clients cache projections. | `packages/server/src/store.ts:1`, `packages/server/src/git/mergeQueue.ts:22` | confirmed |
| Where do Agent secrets live? | Desktop local settings/login only; server receives capability metadata and structured output. | `packages/desktop/src/shared/desktopSettings.ts:53` | confirmed |
| How do commits cross the LAN? | Authenticated bounded Git bundle upload and exact commit import. | Git is already argv-invoked in `packages/server/src/git/worktreeManager.ts:21`; additive extension | likely |
| Who freezes/merges? | Human owner/maintainer commands; Agent output is evidence. | `packages/server/src/agents/types.ts:4`, `packages/server/src/git/mergeQueue.ts:267` | confirmed |

## Approach

Implement the chosen host-authoritative design as additive modules and API/IPC extensions, then replace Team Mode placeholder surfaces with the complete workflow.

## Steps

### Phase 1: Contracts and documentation

- [x] Put the complete product flow and invariants at the top of `README.md`.
- [x] Add coordination types, migrations, services, and tests.
- [x] Add authenticated routes for baselines, approvals, preferences, agent capabilities, attachments, assignments, submissions, queue processing, and review.

### Phase 2: Git and lifecycle

- [x] Configure Team Host with an explicit repository and target branch.
- [x] Seed/fetch the persistent bare integration repository.
- [x] Import bounded member Git bundles and enqueue immutable submissions.
- [x] Add startup reconciliation, automatic backup retention, source projection, and queue processing hooks.

### Phase 3: Desktop and local agents

- [x] Extend shared IPC types, preload, handlers, remote client, and contract tests.
- [x] Add requirements board, upload, approval/freeze, preference/claim, validation, submit, and Host review UI.
- [x] Run configured local Agents without uploading credentials; validate and persist structured evidence.

### Phase 4: Verification

- [x] Server unit/integration/security tests.
- [x] Desktop bridge, renderer, browser, and Electron smoke tests.
- [x] Two-user HTTP/WebSocket integration with device session resume, restart reconciliation coverage, and real temporary Git repositories.
- [x] Root lint, build, and full test.

## Files / APIs / Contracts Touched

- `packages/server/src/coordination/**` — durable workflow state and consensus baseline.
- `packages/server/src/collaborationApi.ts` — authenticated Team API.
- `packages/server/src/git/**` — integration repository and bundle import.
- `packages/desktop/src/shared/remoteTypes.ts` — renderer/main contract.
- `packages/desktop/src/main/remoteClient.ts` and `remoteBridgeHandlers.ts` — transport and local operations.
- `packages/desktop/src/renderer/team/TeamModeShell.tsx` — complete product flow.

## Risk Mitigations

- Additive schemas; idempotent commands; strict versions.
- Upload and command limits; argv execution; exact commit validation.
- Immutable frozen baseline and submission records.
- Human-only freeze/review; Agent evidence is non-authoritative.
- Worktree cleanup and startup reconciliation.

## Test and Verification Plan

| Type | Scope | Approach | Command |
|---|---|---|---|
| Unit | coordination and bundle parsing | state transitions and invalid inputs | `pnpm --filter @planweave-ai/server test` |
| Integration | discussion to merge | real SQLite/HTTP/Git temp repos | focused Vitest suites |
| Contract | Desktop bridge | type/preload/handler parity | Desktop bridge tests |
| Regression | monorepo | type/lint/build/test | `pnpm lint && pnpm -r build && pnpm test` |

## Rollout / Migration / Rollback

- Apply additive migrations at Host start; old clients retain read access.
- New write surfaces require current API support and explicit role checks.
- Rollback trigger: data loss, unauthorized mutation, or Host validation bypass. Disable new write routes and preserve DB/bundle evidence for recovery.
- Owner/approver: repository user/maintainer.

## References

See `RESOURCES.md` for the local source inventory.
