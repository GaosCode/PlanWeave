# Success & Verification: Complete LAN Team Collaboration

> Verifies `RFC.md` §Goals and the implementation build.

## User Stories to Check

- As a Host, I can create a durable team project, freeze a reviewed baseline, and recover after restart.
- As a member, I can use my local Agent, claim one task, work offline, reconnect, validate, and submit immutable commits.
- As a reviewer, I can see source requirements, check evidence, reject with feedback, or approve a serialized merge.
- As any member, I see the same versioned board, graph, assignments, reviews, and merge state after reconnect.

## Acceptance Criteria

```gherkin
Feature: durable LAN collaboration
  Scenario: freeze only an approved consensus revision
    Given a draft baseline with cited requirements and no open questions
    When the configured members approve that exact revision and a maintainer freezes it
    Then every client reads the same immutable frozen version

  Scenario: reject an invalid member submission
    Given a member owns a live assignment with path and check policies
    When the member uploads a bundle with unrelated history or out-of-scope files
    Then the Host rejects it without changing the target branch

  Scenario: recover review state after restart
    Given a submission passed checks and awaits approval
    When the Host restarts and the member reconnects from its last event cursor
    Then the queue entry remains reviewable and no event is duplicated

  Scenario: merge a valid submission
    Given a frozen baseline, claimed task, valid bundle, passing Host checks, Agent evidence, and human approval
    When the Host processes the queue
    Then exactly one merge commit updates the target and all members receive the merged state
```

## Definition of Done

- [x] All server-side scenarios have deterministic automated coverage.
- [x] Two-user API/WebSocket tests cover join and convergence; Electron smoke covers the complete desktop process boundary.
- [x] Root lint/build/test are green.
- [x] README distinguishes product workflow, invariants, and trusted-LAN boundary.

## Success Metrics

| Metric | Type | Baseline | Target | Window | Source |
|---|---|---|---|---|---|
| Completed end-to-end collaboration scenarios | outcome | 0 | 4/4 | release gate | integration tests |
| Reconnect state convergence | leading | partial | 100% in smoke runs | release gate | event cursor assertions |
| Unauthorized/invalid writes accepted | guardrail | 0 expected | 0 | continuous | security tests/audit |
| Personal Mode regressions | guardrail | 0 expected | 0 | continuous | full test suite |

## Decision Rule

Ship only when all four scenarios pass, invalid write acceptance remains zero, and the full Personal Mode regression suite is green. Disable new write routes if authorization, data durability, or Host validation can be bypassed.

## Traceability Matrix

| RFC requirement | User story | Acceptance criteria | Verification | Status |
|---|---|---|---|---|
| Goals 1-2 | Host/member shared baseline | freeze scenario | coordination integration test | passed |
| Goal 3 | local Agent secrets | local Agent scenario | settings/IPC test | passed |
| Goals 4-5 | safe submission | invalid and valid bundle scenarios | Git integration test | passed |
| Goal 6 | Personal Mode | all | root regression | passed |
| Goal 7 | Desktop complete flow | all | renderer/browser/Electron smoke | passed |
