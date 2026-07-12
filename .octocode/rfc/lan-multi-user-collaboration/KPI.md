# Success & Verification: LAN Multi-User Collaboration and Server-Coordinated Delivery

> Verifies `RFC.md` §Goals and the `IMPLEMENTATION.md` build. Goals are referenced, not restated.

## User Stories to Check

- **US1:** As a contributor, I can claim ready work exactly once even when teammates claim concurrently. (→ Goal 1)
- **US2:** As a participant, I can submit ideas and attachments and inspect how coordinator artifacts derived from them. (→ Goal 2)
- **US3:** As an approver, my approval applies only to the proposal revision I reviewed. (→ Goal 3)
- **US4:** As a coordinator, I can publish tasks whose people, boundaries, dependencies, locks, reviewers, and checks are explicit. (→ Goal 4)
- **US5:** As a developer, I can code locally and submit immutable commits to a controlled merge queue. (→ Goal 5)
- **US6:** As an existing user, I can continue using local CLI/Desktop workflows without starting a server. (→ Goal 6)
- **US7:** As an operator, I can identify, replay safely, recover, and audit every consequential command. (→ Goal 7)

## Acceptance Criteria (Gherkin)

```gherkin
Feature: Atomic task claim
  Scenario: Concurrent claim attempts
    Given one ready parallel-safe task and 20 authorized contributors
    When all contributors claim the same task concurrently
    Then exactly one active assignment exists
    And one caller succeeds
    And all other callers receive a deterministic conflict

Feature: Evidence-linked planning
  Scenario: Coordinator updates an artifact
    Given messages and authorized attachments from multiple members
    When the coordinator publishes a new artifact revision
    Then every material artifact claim references existing project sources
    And a member can navigate from the claim to those sources

Feature: Revision-bound consensus
  Scenario: Proposal changes after approval
    Given all required approvers approved proposal revision 4
    When proposal revision 5 is created
    Then revision 5 is not approved
    And execution cannot start until revision 5 meets the approval policy

Feature: Explicit allocation boundary
  Scenario: Plan enters execution
    Given an approved proposal and known members
    When the coordinator produces the execution graph
    Then every assignable task has ownership scopes, acceptance checks, dependencies, and reviewers
    And conflicting parallel work shares a lock or dependency edge

Feature: Controlled Git delivery
  Scenario: Valid submission is merged
    Given an immutable submission commit within its ownership scopes
    When targeted checks, review policy, and final repository checks pass
    Then the merge queue updates the target branch once
    And the audit record identifies submission, author, reviewers, checks, and resulting commit

Feature: Local compatibility
  Scenario: No remote profile is configured
    Given an existing local PlanWeave workspace
    When the user runs existing CLI and Desktop flows
    Then behavior and file formats remain compatible
    And no collaboration server is required

Feature: Restart recovery
  Scenario: Server exits during validation
    Given a queued immutable submission
    When the server exits during an intermediate merge state and restarts
    Then reconciliation reaches a safe queued, failed, or completed state
    And no target update occurs without recorded successful checks

Feature: Idempotent retry
  Scenario: Client loses an acknowledgement
    Given a command committed with an idempotency key
    When the client repeats the command with the same key and payload
    Then it receives the original result
    And no duplicate domain action or audit effect is created
```

## Definition of Done

- [ ] All acceptance scenarios pass in automated integration/E2E suites.
- [ ] Existing local-mode tests and desktop smoke remain green.
- [ ] Security owner has approved auth, attachment, process, and merge boundaries.
- [ ] Backup/restore and restart reconciliation have deterministic tests.
- [ ] Operator and user documentation is updated.
- [ ] Remote mode has completed a maintainer pilot without a rollback trigger.
- [ ] Traceability rows below include post-ship evidence rather than assertion.

## Success Metrics

| Metric | Type | Baseline | Target | Window | Source |
|--------|------|----------|--------|--------|--------|
| Duplicate active assignments for one task | correctness outcome | Not supported | 0 | Every release and first 30 pilot days | DB invariant monitor + audit query |
| Acknowledged commands missing after restart | durability outcome | Not supported | 0 | Every recovery test and first 30 pilot days | command/event reconciliation |
| Unauthorized project/blob reads in authorization suite | security guardrail | Not supported | 0 | Every CI run | negative authorization matrix |
| Client convergence after forced event loss/reconnect | reliability driver | Not supported | 100% of test scenarios | Every CI run | multi-client integration suite |
| Proposal approvals attached to stale revisions | correctness guardrail | Not supported | 0 | Every CI run and pilot | approval invariant query |
| Merge target updates lacking passed immutable evidence | delivery guardrail | Manual | 0 | Every merge | merge audit query |
| Local regression suite | compatibility guardrail | Current main | 100% existing tests pass | Every PR | `pnpm lint`, build, test, desktop smoke |
| Median claim command completion on reference LAN hardware | latency driver | To measure in A2 | <= 250 ms, p95 <= 750 ms | Pilot week | server telemetry |
| Team-rated planning traceability | qualitative outcome | To survey before pilot | >= 4/5 median | End of pilot | short member survey |

## Decision Rule

- **Pilot success if** all zero-tolerance correctness/security guardrails remain zero, reconnect convergence is 100% in controlled tests, local regressions remain green, and team-rated planning traceability reaches at least 4/5.
- **Iterate without broad rollout if** latency misses its target but correctness guardrails pass.
- **Freeze writes and merge queue immediately if** any duplicate active assignment, acknowledged command loss, unauthorized read, stale-revision execution, or unevidenced target update occurs. This mirrors `IMPLEMENTATION.md` §Rollout / Migration / Rollback.

## Traceability Matrix

| RFC requirement | User story | Acceptance criteria | Verification method | Post-ship status |
|---|---|---|---|---|
| Goal 1 | US1 | Atomic task claim | 20-way concurrency integration test + DB invariant | pending |
| Goal 2 | US2 | Evidence-linked planning | Coordinator contract and source navigation E2E | pending |
| Goal 3 | US3 | Revision-bound consensus | Proposal revision integration test | pending |
| Goal 4 | US4 | Explicit allocation boundary | Graph/policy validation test and manual workflow review | pending |
| Goal 5 | US5 | Controlled Git delivery | Temporary bare repo/worktree E2E + audit assertion | pending |
| Goal 6 | US6 | Local compatibility | Existing monorepo suite and Desktop smoke | pending |
| Goal 7 | US7 | Restart recovery; idempotent retry | Fault-injection, replay, backup/restore, audit tests | pending |

