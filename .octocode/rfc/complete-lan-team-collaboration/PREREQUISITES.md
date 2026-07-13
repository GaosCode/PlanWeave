# PREREQUISITES

## Scope

Existing Team Mode, collaboration API, SQLite modules, Desktop bridge, local Agent tools, and merge queue. RFC anchor: `RFC.md` §Reference-Level Explanation.

## Required Current-State Evidence

| Requirement | Evidence | Confidence | Owner |
|---|---|---|---|
| Host/member onboarding exists in app | `packages/desktop/src/renderer/team/TeamModeShell.tsx:175` | confirmed | Desktop |
| Server owns transactional work leases/submissions | `packages/server/src/work/services.ts:161` | confirmed | Server |
| Attachment storage is durable but not routed | `packages/server/src/attachments/attachments.ts:31`; no attachment route in `packages/server/src/collaborationApi.ts:76` | confirmed | Server |
| Coordinator artifacts exist but only fake provider is wired | `packages/server/src/agents/providers/fakeProvider.ts:18` | confirmed | Agent |
| Desktop bridge stops at claim/status | `packages/desktop/src/shared/remoteTypes.ts:120` | confirmed | Desktop |
| Host checks and human review exist | `packages/server/src/git/mergeQueue.ts:153` | confirmed | Git |
| Merge queue bare repository is not initialized from a real project | `packages/server/src/git/worktreeManager.ts:52`; `packages/desktop/src/main/localTeamHost.ts:20` | confirmed | Git/Desktop |

## Environment And Setup

| Need | How to verify | Source |
|---|---|---|
| Node with `node:sqlite` | `node --version` and server tests | `packages/server/package.json:1` |
| Git CLI with bundle/worktree support | `git --version` and integration test | `packages/server/src/git/worktreeManager.ts:21` |
| pnpm workspace | `pnpm --version` | root `package.json:5` |
| Optional local Agent CLIs | Desktop detection; absence must not block manual work | `packages/desktop/src/main/agentTools.ts:6` |

## Baseline Verification

| Check | Command | Expected baseline | Evidence |
|---|---|---|---|
| Static gates | `pnpm lint` | pass | passed 2026-07-13 |
| Collaboration regression | focused server/work/git/bridge Vitest command | 36 passing | passed 2026-07-13 |

## Blockers Before Implementation

None. Public schema/security approval is supplied by the user in the implementation request.

## Contracts And Migration Constraints

| Contract/data/API | Compatibility constraint | Rollback or guardrail |
|---|---|---|
| SQLite schemas | additive migrations only | old tables remain readable |
| `/api/v1` | keep existing routes and envelopes | new clients feature-detect endpoints |
| Desktop IPC | preload, handler, shared type change together | bridge contract test |
| Personal Mode | no server dependency in runtime | root lint/typecheck and runtime tests |
| Git import | never use shell strings; bound bytes/output/time | integration tests with invalid bundle/path/history |
