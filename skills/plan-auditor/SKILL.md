---
name: plan-auditor
description: Review an already-authored PlanWeave plan for goal coverage, lifecycle gaps, contract drift, execution graph errors, weak prompts, and unverifiable completion criteria. Use when auditing, reviewing, checking, or challenging a PlanWeave plan before execution.
---

# Plan Auditor

Use this skill to audit an existing PlanWeave plan. Do not import a new plan, execute blocks, repair state, or rewrite the package unless the user explicitly asks.

## Quick Start
1. Find the authority sources: user request, PRD, schema, design docs, current code, and the PlanWeave package.
2. Read `manifest.json`, source prompts, task/block definitions, canvas structure, dependencies, validation output, and `planweave schema` output when available.
3. Compare the plan against real goals, object lifecycles, contracts, execution order, prompts, failure paths, and verification criteria.
4. Report a verdict first: `PASS`, `NEEDS_REVISION`, or `BLOCKED`.
5. List findings by severity, with evidence and concrete plan changes.

## Audit Checklist

### Goal Coverage
- Identify the authoritative target before judging the plan.
- Check whether all key goals, requirements, constraints, and risks are represented.
- Flag omitted, weakened, or incorrectly deferred requirements.
- Do not accept a demo subset as full delivery unless the user explicitly scoped it that way.

### Core Object Lifecycle
- Identify the project's core objects before checking UI/API/DB/worker tasks.
- For each object, trace who creates it, which structure describes it, where it is validated, who transforms it, how state changes, whether it is stored, who consumes it, what side effects fire, what final output exists, and how failure/retry/rollback/manual intervention works.
- If an object has producers but no consumer, or setup but no final output, record a gap.

### Contract Consistency
- Check schema, types, API parameters, CLI flags, events, file formats, and prompt input/output.
- Producers and consumers must use the same fields, statuses, and semantics.
- Contract-changing tasks must cover callers, tests, fixtures, docs, and migrations when relevant.
- Flag fallback/default/`any`/mock-only paths that hide missing contracts.

### Execution Graph
- Check whether tasks, blocks, canvases, and dependency edges express the real execution order.
- Parallel tasks must be independent in data flow, locks, and contract timing.
- Different canvases are not automatically parallel; cross-canvas dependencies must be explicit.
- Sequential gates must be explicit.
- Flag tasks split only for count, and tasks that cross too many boundaries.
- Each canvas should represent a clear phase, capability area, or parallel work group.

### Task And Review Granularity
- Reasonable tasks should map to one verifiable feature slice, contract slice, or lifecycle phase.
- Merge tiny tasks that only add scheduling overhead.
- Split tasks that would make a subagent cross unrelated layers or lose control of validation.
- Simple docs, config, low-risk copy edits, and local fixes usually do not need review.
- Cross-layer, contract, database, provider, architecture, security, privacy, or high-risk behavior changes should have review gates.

### Prompt Quality
- Every task/block prompt should let a subagent start without guessing.
- Check for goal, reference file paths, impact scope, forbidden actions, done criteria, and validation method.
- If the plan relies on global/project prompt, verify that those prompts contain the required background.
- Check that prompt placement summary identifies global/project/task/block source of truth.
- Flag prompts that only say "implement this" without explaining how completion is judged.

### Real Completion
- Look for fake completion: schema without runtime use, interface without caller, UI without behavior, config never read, provider abstraction without live client, queue without consumer, file path without file, dry-run without live path, or fixture tests without real-chain coverage.
- Check complex blocks include architecture boundary, test location, config/env handling, README or `.env.example` updates when applicable, and real provider vs mock expectations.
- Require the plan to distinguish mock, dry-run, live path, and real artifacts.

### Failure Paths
- Check errors, retries, cancellation, timeout, permissions, partial success, external service outage, failed human review, and recovery.
- Reliable execution and state-machine work must include abnormal states and recovery strategy early, not as a final polish task.

### Verification Standards
- Each block needs verifiable completion criteria.
- Prefer concrete commands, tests, output artifacts, observable state changes, or end-to-end flows.
- Reject vague criteria like "logic correct", "implemented", or "looks usable".

### Architecture Quality
- Check layer boundaries, single source of truth, duplicate schema/rule risks, temporary fallback, mock-as-product risk, testability, and maintainability.
- Flag copied skills, bootstrap rules, or prompt conventions from unrelated projects unless explicitly required.
- If foundation tasks are incomplete, flag plans that prematurely schedule large UI or packaging layers.

### PlanWeave Executability
- Check whether PlanWeave can actually run the plan: prompts exist, blocks can be claimed, dependencies unlock, reviews can be submitted, prompt sources are editable, and canvas order is clear.
- Compare suspicious manifest/state/layout structure against `planweave schema manifest`, `planweave schema state`, and `planweave schema layout`.
- Separate plan design defects from PlanWeave toolchain defects.

## Finding Format
Use this shape for every finding:

```md
[P1] Short title
Evidence: path/ref/line or task/block/canvas id.
Impact: why this blocks or weakens execution.
Plan change: exact task, block, edge, prompt, review, or validation update needed.
```

End with the recommended revision order. Do not stop at generic advice.
