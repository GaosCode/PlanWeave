# RFC: Complete LAN Team Collaboration

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Decision type** | Reversible protocol extension with additive migrations |
| **Author(s)** | PlanWeave maintainers |
| **Created** | 2026-07-13 |
| **Last Updated** | 2026-07-13 |

## Summary

Complete Team Mode as a host-authoritative collaboration loop: members discuss and upload source material; a host coordinator produces cited consensus artifacts; humans freeze a versioned baseline; tasks and dependencies are published from that baseline; members advertise their local agent, claim leased work, validate locally, and submit an immutable Git bundle plus evidence; the host imports the commits into an integration repository, reruns checks in an isolated worktree, records agent/human review, serializes merges, and projects every state change through the persistent event stream.

## Goals and Non-Goals

### Goals

1. Provide one versioned, auditable requirements baseline shared by every member.
2. Connect planning messages, attachments, coordinator artifacts, approvals, tasks, assignments, submissions, reviews, and merges in one recoverable state machine.
3. Keep each member's agent credentials and execution permissions local while publishing non-secret capability metadata to the host.
4. Transfer member commits to the host without requiring a shared filesystem or a separately administered Git daemon.
5. Make local validation advisory and host-side validation authoritative.
6. Preserve Personal Mode and existing file-backed runtime behavior.
7. Expose the complete workflow in the Desktop UI; CLI remains an automation surface, not an onboarding requirement.

### Non-Goals

- Internet-scale federation, public-cloud hosting, or untrusted WAN transport.
- Replacing Git with a custom source-control system.
- Uploading member Agent API keys or login sessions to the host.
- Allowing an Agent to freeze requirements or approve its own merge.
- Removing existing Personal Mode, MCP, or Plan Package execution paths.

## Motivation

The current Desktop path can join, send messages, approve proposals, display tasks, and claim work, but its public bridge ends at `claimRemoteTask`; it cannot upload attachments, renew leases, validate, submit, or review (`packages/desktop/src/shared/remoteTypes.ts:120`). The server already persists attachments and coordinator artifacts, but neither subsystem is wired into `collaborationApi.ts` (`packages/server/src/attachments/attachments.ts:31`, `packages/server/src/agents/services.ts:161`). The merge queue can rerun checks and require human approval, but Team Host does not configure a real integration repository and member commits have no LAN transport into its bare repository (`packages/server/src/git/mergeQueue.ts:22`, `packages/desktop/src/main/localTeamHost.ts:20`). Leaving these gaps produces a convincing viewer but not a durable collaboration system.

## Guide-Level Explanation

Team Mode has four explicit phases:

1. **Planning** — shared messages and attachments are mutable inputs.
2. **Consensus** — coordinator artifacts form a draft baseline; members approve a specific version; maintainers freeze it.
3. **Execution** — frozen baseline requirements are referenced by tasks; members express preferences, claim leases, heartbeat, work locally, and submit.
4. **Review** — host imports a Git bundle, checks ancestry and ownership scopes, runs acceptance/repository checks, records Agent evidence, requires owner/maintainer approval, and merges serially.

Clients cache projections only. The SQLite database and host integration repository are authoritative. A reconnect starts from the last durable event cursor.

## Reference-Level Explanation

### Consensus model

Add an independently versioned `coordination` schema with workflow state, immutable baseline revisions, per-revision approvals, task preferences, member agent capability records, and submission evidence. Freezing requires the configured approval threshold and zero open questions. Frozen baselines are immutable; changes create a new revision and supersede the prior active baseline.

### Agent boundary

The host and members run configured CLI agents in their local Desktop main process. The server stores only structured artifacts, citations, capability metadata, run status, and review evidence. Agent output is validated before it can become a baseline or review record. Human-only commands freeze baselines and approve merge queue entries.

### Git transport

The Host initializes a persistent bare integration repository from an explicitly selected local repository. A member submission creates a bounded Git bundle for `baseCommit..headCommit`, uploads it over the authenticated collaboration API, and the host imports the exact commit into the bare repository before enqueuing. Bundle size, commit format, ancestry, project membership, assignment ownership, and immutable submission metadata are validated.

### Long-running behavior

SQLite WAL, idempotency keys, optimistic versions, leases, startup reconciliation, event replay, atomic profile/settings writes, bounded uploads, bounded command output, and worktree garbage collection remain mandatory. Interrupted checking/merging entries are reconciled; reviewing entries remain stable for human action.

### Compatibility

All database changes are additive and independently migrated. Existing clients can continue reading current endpoints. Personal Mode and file runtime do not import the collaboration server. Team Host configuration can be removed without modifying a member repository.

## Drawbacks

- The host owns more operational responsibility: repository storage, backups, checks, and merge availability.
- Git bundles add temporary disk and network cost proportional to changed history.
- Running real agents can be slow and must be cancellable and bounded.
- The Desktop bridge grows; contract tests must guard renderer/main drift.
- LAN HTTP is only appropriate on a trusted private network unless a TLS reverse proxy is used.

### Pre-mortem — how this fails

- **Host exits during import/check:** persist upload and queue state before processing; reconcile on restart and keep immutable submissions.
- **A member submits unrelated history:** verify bundle, exact commit IDs, ancestry, assignment ownership, and path scopes before checks.
- **Consensus drifts while work is active:** tasks reference an immutable baseline revision; new baselines do not silently rewrite claimed work.
- **An Agent emits malformed or uncited output:** schema-validate output, require citations for claims, retain raw failure evidence, and keep human gates closed.
- **A lease expires during offline work:** preserve local work, surface expiry, and require reclaim/reconciliation before submission.
- **Checks execute arbitrary shell:** use argv execution without a shell; allow only validated task commands and host-configured repository checks.

## Rationale and Alternatives

### Why This Design?

It extends the repository's existing authoritative SQLite, event, lease, attachment, agent artifact, and merge queue modules instead of introducing a second state model. It also preserves local Agent choice and secrets while giving the host enough immutable evidence to make a safe merge decision.

### Alternative A: UI-only orchestration over existing endpoints

- **Pros:** small patch; fast demo.
- **Cons:** no frozen baseline, no attachment/agent wiring, no commit transport, no authoritative submit/review path.
- **Why not chosen:** it cannot satisfy recoverability or safe merge requirements.

### Alternative B: Peer-to-peer shared files and Git pushes

- **Pros:** fewer host APIs; Git-native when every machine is preconfigured.
- **Cons:** conflicting writers, difficult authorization/revocation, no single event order, and significant setup outside the app.
- **Why not chosen:** it conflicts with the existing server authority and in-app onboarding requirement.

### Alternative C: Host-authoritative state with authenticated Git bundles (chosen)

- **Pros:** reuses current modules, works on a private LAN without a Git daemon, supports offline local work, and keeps deterministic host checks.
- **Cons:** more API and lifecycle code; bundle storage must be bounded and cleaned.

| Dimension | UI-only | Peer-to-peer | Host + bundles |
|---|---|---|---|
| Authoritative recovery | Low | Low | High |
| In-app onboarding | Medium | Low | High |
| Secret locality | High | Medium | High |
| Merge safety | Low | Medium | High |
| Implementation cost | Low | Medium | High |
| Long-term operability | Low | Medium | High |

### What If We Do Nothing?

Team Mode remains a shared viewer with an incomplete CLI-assisted backend path. It would be unsafe to describe it as end-to-end collaboration in the README.

## Prior Art

The codebase itself supplies the relevant patterns: append-only domain events, lease-backed claims, immutable submissions, content-addressed attachments, provider-neutral coordinator artifacts, and a serialized merge queue. No external service is required for the accepted design.

## Unresolved Questions

No blocking questions remain. LAN transport is explicitly trusted-network HTTP in this RFC; TLS termination is deferred to a future deployment RFC. The user is the schema/security approver for this implementation.

## Future Possibilities

- Optional TLS certificates and device-bound public keys.
- Remote object storage for large attachments/bundles.
- Multiple Host replicas with leader election.
- Policy-configurable quorum beyond owner/maintainer approval.
