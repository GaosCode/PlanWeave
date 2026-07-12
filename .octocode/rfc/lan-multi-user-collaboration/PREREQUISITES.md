# PREREQUISITES

## Scope

Existing-code areas affected: `packages/runtime`, `packages/mcp`, `packages/cli`, `packages/desktop`, root workspace scripts, plus new `packages/server`.

RFC anchors: `RFC.md` §Goals and Non-Goals, §Reference-Level Explanation, §Compatibility and rollback.

## Required Current-State Evidence

| Requirement | Evidence | Confidence | Owner |
|---|---|---|---|
| Local runtime state is whole-file data | `packages/runtime/src/types/state.ts:35-41`; `packages/runtime/src/state.ts:27-37` | confirmed | Runtime Agent |
| Current writes are atomic-file replacement, not transactional read-modify-write | `packages/runtime/src/json.ts:9-22`; `packages/runtime/src/taskManager/claimScheduler.ts:28-99` | confirmed | Runtime Agent |
| Parallel locks and dependency conflict semantics already exist | `packages/runtime/src/taskManager/selectors.ts:161-189` | confirmed | Runtime Agent |
| MCP supports authenticated non-loopback binding | `packages/mcp/src/config.ts:99-108` | confirmed | Server/API Agent |
| MCP transport is created per POST without a server session ID | `packages/mcp/src/server.ts:62-93` | confirmed | MCP Agent |
| Desktop is local IPC plus local filesystem observation | `packages/desktop/src/main/runtimeBridgeHandlerRegistry.ts:306-380`; `packages/desktop/src/main/runtimeStateWatch.ts:37-41` | confirmed | Desktop Agent |
| Final repository check order is lint, build, tests | `AGENTS.md`; `package.json:8-13`; `package.json:33` | confirmed | Integration Agent |
| SQLite exists as a rebuildable PlanGraph index, not collaboration SSOT | `packages/runtime/src/plangraph/sqlite/graphRows.ts`; `packages/runtime/src/__tests__/plangraphCommand.test.ts` | confirmed | Storage Agent |

## Environment And Setup

| Need | How to verify | Source |
|---|---|---|
| Node >= 22.5 and pnpm 10.32.1 | `node --version`; `pnpm --version` | `AGENTS.md`; `package.json:7` |
| Clean dependency installation | `pnpm install --frozen-lockfile` | `AGENTS.md` |
| Baseline monorepo build order | `pnpm -r build` | `AGENTS.md`; `package.json:9` |
| Baseline local Git executable | `git --version` and a temporary bare/worktree smoke test | Required by RFC §Merge policy |
| Cross-platform target list | Confirm macOS, Linux, Windows CI responsibilities before Git worker implementation | Desktop release commands in `package.json:15-22` |

## Baseline Verification

| Check | Command or method | Expected baseline | Evidence |
|---|---|---|---|
| Version consistency | `pnpm check:versions` | Pass | Root script `package.json:11` |
| Renderer DOM boundary | `pnpm check:dom-boundaries` | Pass | Root script `package.json:10` |
| Type compatibility | `pnpm typecheck` | Pass | Root script `package.json:13` |
| Workspace build | `pnpm -r build` | Pass | Root script `package.json:9` |
| Existing behavior | `pnpm test` | Pass | Root script `package.json:33` |
| Focused runtime claim baseline | `pnpm --filter @planweave-ai/runtime vitest run src/__tests__/claimNext.test.ts src/__tests__/claimParallel.test.ts` | Pass | Existing tests |
| MCP server/auth baseline | `pnpm --filter @planweave-ai/mcp vitest run src/__tests__/server.test.ts src/__tests__/config.test.ts` | Pass | Existing tests |

## Blockers Before Implementation

| Blocker | Impact | Owner | Resolution needed before Step 1 |
|---|---|---|---|
| Human schema/security approver not named | Security and public API changes cannot be accepted | Project owner | Record owner in `IMPLEMENTATION.md` rollout section before server API merge |
| First topology not confirmed | Changes repository/project keys and CLI connection UX | Project owner | Default to one server hosting multiple projects, each bound to at most one repository, unless owner rejects |
| SQLite driver/package compatibility unverified | Could fail Electron/native packaging or Node ESM builds | Storage Agent | Spike candidate driver in `packages/server` only; run build and packaged constraints before schema work |
| HTTP/WebSocket package choice unverified | Shapes transport and tests | Server/API Agent | Compare reuse of Node HTTP/MCP server with a separate server router; record decision before public endpoints |

## Contracts And Migration Constraints

| Contract/data/API | Compatibility constraint | Rollback or guardrail |
|---|---|---|
| Runtime public exports | Existing CLI/MCP/Desktop local calls must continue compiling | Add ports behind existing functions; parity tests before switching any caller |
| `state.json` and Plan Package | Do not silently change current file schema in first slice | Keep file repository and optional server projection |
| MCP `/mcp` | Existing local clients keep current behavior | Remote gateway is opt-in and separately configured |
| Desktop preload API | Renderer remains isolated from Node and raw network credentials | Remote calls live in main/preload bridge; follow DOM boundary rule |
| Git target branch | Never mutate until validation and final head check pass | Serialized queue; immutable submission commits; retain contributor branch |
| Collaboration database | Migrations must be forward-applied and backupable | Schema version, startup backup/export, migration tests |
| Attachments | Paths and MIME claims are untrusted | Content addressing, staged validation, size cap, authorization |

