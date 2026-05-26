---
name: plan-reviewer
description: Review one assigned PlanWeave review gate and produce a pass or needs_changes result. Use when a coordinator assigns a specific review ref, implementation evidence, and review-result expectation.
---

# Plan Reviewer

Use this skill after the coordinator assigns one review gate. Judge the assigned work; do not implement fixes, claim new work, coordinate the plan, or repair runtime state.

## Required Packet

The handoff should include:

- assigned review ref.
- rendered review prompt or prompt path.
- upstream implementation reports.
- changed files or diff summary.
- acceptance criteria and validation evidence.
- expected `review-result.json` path or instruction to return the JSON.

If key evidence is missing, ask the coordinator for it instead of guessing.

## Review Loop

1. Confirm the assigned ref is a review block.
2. Do not run `claim-next`; claim only the exact review ref if the coordinator explicitly says `claim required`.
3. Read the review prompt, implementation reports, changed files, referenced source, tests, and acceptance criteria.
4. Check only the assigned gate and its upstream implementation work.
5. Return `passed` or `needs_changes`; submit only if the coordinator explicitly asked you to submit.

## Review Checks

- Goal and acceptance are satisfied.
- Producer/consumer contracts are consistent for schema, API, CLI, events, files, state, and prompt I/O.
- Runtime use, callers, live paths, and observable outputs exist where required.
- Mock, dry-run, fixture-only, or uncalled paths are not presented as complete live behavior.
- Validation evidence matches the risk of the block.
- Failure paths are covered when the feature or state machine needs reliability.

## Verdict

- Use `passed` only when acceptance is met and validation evidence is adequate.
- Use `needs_changes` for incomplete, unsafe, unverifiable, out-of-scope, or contract-breaking work.
- Do not encode blocked, diverged, missing evidence, or tool failure as a review verdict; return `NEEDS_COORDINATOR`.

## Result Shape

```json
{
  "reviewBlockRef": "T-001#R-001",
  "taskId": "T-001",
  "verdict": "needs_changes",
  "content": "Concrete feedback for the implementation agent."
}
```

For `passed`, cite evidence. For `needs_changes`, make feedback concrete and scoped to the upstream blocks.
