# Resources: Complete LAN Team Collaboration

## Primary Sources

| Resource | Path | Why it matters |
|---|---|---|
| Product workflow | `README.md` §Core LAN collaboration | User-approved intended sequence |
| Decision | `RFC.md` | Goals, scope, authority, and alternatives |

## Local Code References

| Area | File | Notes |
|---|---|---|
| HTTP/WS API | `packages/server/src/collaborationApi.ts` | Current routed collaboration surface |
| Work leases | `packages/server/src/work/services.ts` | Claim, heartbeat, submit, review, reclaim |
| Attachments | `packages/server/src/attachments/attachments.ts` | Bounded digest-verified blob storage |
| Coordinator | `packages/server/src/agents/services.ts` | Checkpoints, citations, provider boundary |
| Events | `packages/server/src/events/` | Persistent replay and WebSocket projection |
| Merge queue | `packages/server/src/git/mergeQueue.ts` | Host checks, review gate, serialized merge |
| Team UI | `packages/desktop/src/renderer/team/TeamModeShell.tsx` | Current role/planning/graph/task/proposal/member views |
| Desktop transport | `packages/desktop/src/main/remoteClient.ts` | HTTP, WS, reconnect, projection reads |
| Local Agent detection | `packages/desktop/src/main/agentTools.ts` | Codex/Claude/OpenCode/Pi command profiles |

## Prior Art And Related Systems

The accepted implementation deliberately uses existing repository primitives rather than an external coordination service. Git bundle transport is provided by the installed Git CLI and will be verified against temporary local repositories in tests.

## Internal Research Artifacts

| Artifact | Path | Notes |
|---|---|---|
| Prerequisite ledger | `PREREQUISITES.md` | Confirmed current gaps and gates |
| Implementation plan | `IMPLEMENTATION.md` | Dependency-ordered work |
| Verification matrix | `KPI.md` | Release decision rule |

## Open Research Leads

- TLS termination and device-bound public keys — separate deployment/security RFC.
- Object storage for bundles larger than the trusted-LAN default limit.

## Search Prompts

```text
rg -n "assignment|submission|merge-queue|AgentProvider|attachment|baseline|approval" packages/server packages/desktop packages/cli
```
