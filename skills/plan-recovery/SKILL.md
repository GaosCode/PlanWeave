---
name: plan-recovery
description: Diagnose and recover PlanWeave execution anomalies such as stale current refs, state/results drift, orphan artifacts, blocked or diverged blocks, submit retries, and review-feedback loop inconsistencies. Use when PlanWeave execution state looks wrong, doctor reports issues, submit partially succeeded, or coordinator cannot safely continue.
---

# Plan Recovery

Use this skill for abnormal PlanWeave execution state. Do not perform normal implementation or review work.

## Quick Start

1. Stop dispatching dependent work.
2. Resolve the CLI entry and run `<pw> help recovery` for exact commands.
3. Inspect current/status/explain output; run doctor only for state/results consistency questions.
4. Separate plan defects from runtime state/results drift.
5. Prefer CLI repair and explicit recovery commands over direct file edits.
6. Report what was repaired, what remains unsafe, and the next coordinator action.

## Doctor Boundary

- `doctor` detects narrow runtime state/results consistency issues such as stale current refs, orphan results, and state/index run drift.
- `doctor --repair` is not a general plan repair tool.
- Do not use doctor to fix bad dependencies, unsafe parallelization, missing prompts, wrong review-gate design, unclear task/block granularity, or schema-invalid package structure.
- For plan defects, report `NEEDS_PLAN_UPDATE` and guide manual edits to the Plan Package, prompts, dependencies, or review gates.

## Diagnose First

Check:

- active current refs and current feedback.
- block/task status and claim hints.
- latest run indexes versus state block `lastRunId`.
- orphan result artifacts.
- stale current refs.
- diverged or blocked refs and reasons.
- review attempts, feedback status, and re-review state.
- whether a retry is same-content idempotency or a fresh work revision.

## Recovery Actions

- Use doctor before state/results repair; use repair only when the reported fix is narrow and evidence-backed.
- Continue using CLI when status/current/explain agree with package files; treat CLI as a reference only when they conflict.
- If CLI cannot safely claim/submit, have the coordinator read package/state/results and manually assign exact refs until write-back is safe.
- Use blocked/unblocked commands for external prerequisites or temporary stops.
- Use diverged/resolve-divergence when implementation reality no longer matches the Plan Package.
- For submit partial success, look for persisted report/result artifacts before creating new runs or attempts.
- For feedback resolved but still current, re-check current/status before submitting anything.
- For parallel mismatch, compare sequential and parallel claimability before declaring no work.
- If parallel mismatch comes from package design, adjust dependencies, parallel safety, or review gate placement manually instead of running repair.

## Manual Fallback

Direct file inspection is allowed when CLI output contradicts files:

- read `package/manifest.json`, source prompts, `state.json`, `results/`, and `planweave schema manifest/state/layout` when structure is suspect.
- verify metadata belongs to the same task/block/run before trusting indexes.
- do not edit `state.json` or `results/` directly unless CLI repair cannot express the fix and the user accepts the risk.
- preserve evidence paths and explain why CLI write-back was unavailable.

## Stop Conditions

Stop and ask for user or plan update when:

- package dependencies or prompts are wrong.
- state cannot be repaired without guessing.
- multiple current refs conflict with actual work ownership.
- result metadata points to the wrong block or task.
- review/feedback state is contradictory after doctor.
- a recovery command would hide a real product or contract defect.

## Recovery Report

Report:

- verdict: `RECOVERED`, `NEEDS_PLAN_UPDATE`, or `BLOCKED`.
- symptoms and evidence.
- commands run.
- files inspected.
- repairs made or intentionally skipped.
- next safe command for `plan-coordinator`.
