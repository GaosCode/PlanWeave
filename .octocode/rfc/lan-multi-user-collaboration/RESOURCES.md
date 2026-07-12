# Resources: LAN Multi-User Collaboration and Server-Coordinated Delivery

## Primary Sources

| Resource | Link or path | Why it matters |
|---|---|---|
| Repository operating instructions | `AGENTS.md` | Build order, tests, Desktop boundaries, release constraints |
| Root workspace scripts | `package.json:8-40` | Authoritative validation commands and tool versions |
| RFC decision | `RFC.md` | Goals, scope, authority boundaries, alternatives |

## Local Code References

| Area | File and lines | Notes |
|---|---|---|
| Runtime state schema | `packages/runtime/src/types/state.ts:35-41` | Current whole-state aggregate |
| Runtime persistence | `packages/runtime/src/state.ts:27-37` | Direct file read/write boundary |
| Atomic JSON write | `packages/runtime/src/json.ts:9-22` | Prevents partial files but not lost read-modify-write updates |
| Claim mutation | `packages/runtime/src/taskManager/claimScheduler.ts:28-99` | Primary concurrency migration boundary |
| Parallel dispatch | `packages/runtime/src/taskManager/claimBlockDispatch.ts:12-41` | Existing parallel-safe enforcement |
| Lock conflict policy | `packages/runtime/src/taskManager/selectors.ts:161-189` | Dependency and logical lock conflict behavior |
| MCP config/auth | `packages/mcp/src/config.ts:99-124` | Existing LAN authentication guard |
| MCP HTTP lifetime | `packages/mcp/src/server.ts:62-105` | Per-request server/transport creation |
| MCP runtime gateway | `packages/mcp/src/toolRuntime.ts:67-95` | Useful adapter seam for local/remote mode |
| Desktop startup | `packages/desktop/src/main/main.ts:36-56` | Current local handler/watcher registration |
| Desktop local state events | `packages/desktop/src/main/runtimeStateWatch.ts:182-203` | Current local notification mechanism |
| Desktop preload bridge | `packages/desktop/src/preload/preload.ts:19-48` | Typed isolation boundary for remote client additions |
| Desktop runtime handlers | `packages/desktop/src/main/runtimeBridgeHandlerRegistry.ts:306-380` | Current direct local runtime calls |
| PlanGraph SQLite layer | `packages/runtime/src/plangraph/sqlite/` | Local database precedent; remains derived index |

## Prior Art And Related Systems

| Resource | Link | Use for this RFC |
|---|---|---|
| Git | Local installed CLI and repository | Immutable code submissions, branches, worktrees, ancestry, target history |
| MCP Streamable HTTP SDK | Installed `@modelcontextprotocol/sdk` usage in `packages/mcp/src/server.ts` | Preserve Agent tool transport while separating collaboration API |
| PlanWeave review and feedback loop | `packages/runtime/src/taskManager/reviewSubmission.ts` and related tests | Reuse domain review semantics rather than inventing a second workflow |
| PlanWeave PlanGraph SQLite index | `packages/runtime/src/plangraph/sqlite/` | In-repo patterns for schema/query tests; explicitly not durable collaboration SSOT |

## Internal Research Artifacts

| Artifact | Path | Notes |
|---|---|---|
| Architecture evidence review | This RFC document set | Structure, stream, and connection evidence collected 2026-07-12 |
| Implementation work graph | `IMPLEMENTATION.md` §Agent Work Packages and Dependency Graph | Direct assignment and merge ordering source |
| Acceptance/metric traceability | `KPI.md` | Requirement-to-verification mapping |

## Open Research Leads

- SQLite driver and migration library — compare only maintained primary packages against Node ESM, CI targets, and packaged Desktop constraints in A0.
- HTTP/WebSocket stack — measure whether a dedicated collaboration server router improves typed routing and testability without breaking `/mcp`.
- Secure credential storage — select per platform/Desktop versus CLI after defining device-token lifecycle.
- Git hosting adapters — defer until the local bare repository merge queue is proven.
- PostgreSQL — revisit only from measured lock wait, availability, or deployment requirements.

## Search Prompts

```text
PlanWeave local state mutation claimNext writeState concurrency boundaries
PlanWeave MCP per-request StreamableHTTPServerTransport server lifetime
Node 22 ESM SQLite WAL migration library cross-platform Electron packaging
Node HTTP WebSocket authenticated durable event replay backpressure
Git bare repository worktree merge queue crash recovery immutable commit
SQLite transactional outbox idempotency key optimistic concurrency single process
```
