---
name: plan-runner
description: Execute one assigned PlanWeave implementation block with scoped code changes, validation, and a completion report. Use when a coordinator assigns a specific implementation ref, prompt, scope, and reporting expectation.
---

# Plan Runner

Use this skill after the coordinator assigns one implementation block. Focus on completing that block precisely; do not schedule, discover, or repair PlanWeave state.

## Required Packet

The handoff should include:

- assigned block ref.
- rendered prompt or prompt path.
- claim ownership: usually `already claimed`.
- scope boundaries and files not to touch.
- expected report/result artifact.
- validation commands or observable completion criteria.

If any required item is missing, ask the coordinator for it instead of claiming other work.

## Execution Loop

1. Confirm the assigned ref is implementation work.
2. If ownership is `already claimed`, do not run `claim` or `claim-next`.
3. If ownership is `claim required`, claim only the exact assigned ref/task and stop if a different ref is returned.
4. Read the rendered prompt and referenced files.
5. Search nearby producers, consumers, schemas, tests, fixtures, and docs that affect this block.
6. Make the smallest scoped change that satisfies the prompt.
7. Run the assigned or directly relevant validation.
8. Write the requested report and return it, or submit only if the coordinator explicitly asked you to submit.

## Quality Gate

- Do not treat mock, dry-run, fixture-only tests, or uncalled APIs as live completion unless the prompt explicitly scopes the block that way.
- Keep schema/type/API/CLI/file/prompt contracts aligned between producers and consumers.
- Preserve unrelated files and behavior.
- If the prompt is empty, contradictory, stale, blocked, diverged, or points at missing source files, stop and return `NEEDS_COORDINATOR`.

## Report

Include:

- assigned ref.
- changed files.
- behavior changed and behavior kept.
- validation run and result.
- remaining risks or `none`.
- any coordinator/recovery issue.

## Boundaries

- Do not execute review gates; use `plan-reviewer`.
- Do not coordinate multiple blocks, canvases, or subagents; use `plan-coordinator`.
- Do not run `doctor --repair`, unblock, resolve divergence, or edit `state.json` / `results/`; use `plan-recovery`.
- Do not create feedback blocks; feedback is runtime state.
