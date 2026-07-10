---
name: plan-auditor
description: Review an already-authored PlanWeave plan for goal coverage, data-flow coverage, lifecycle gaps, contract drift, execution graph errors, weak prompts, and unverifiable completion criteria. Use when auditing, reviewing, checking, or challenging a PlanWeave plan before execution.
---

# Plan Auditor

Use this skill to audit an existing PlanWeave plan. The default output is findings and revision order; do not import a new plan, execute blocks, repair state, or rewrite the package while auditing.

## Quick Start
1. Find the authority sources: user request, PRD, schema, design docs, current code, and the PlanWeave package.
2. Read `project-graph.json` when present, every canvas `manifest.json`, source prompts, task/block definitions, canvas structure, dependencies, validation output, and `planweave schema` output when available.
3. Before judging task completeness, identify the plan's main value flows or lifecycle flows and fill the required Flow Coverage table.
4. Compare the plan against real goals, data-flow coverage, object lifecycles, contracts, execution order, prompts, failure paths, and verification criteria.
5. Report a verdict first: `PASS`, `NEEDS_REVISION`, or `BLOCKED`.
6. List findings by severity, with evidence and concrete plan changes.

## Plan Update Boundary

- Audit findings name the needed task, block, edge, prompt, review, or validation update; they do not apply the change.
- If the user explicitly asks to apply revisions, finish the audit first, then use the Plan Package semantic editing boundary: resolve CLI workspace paths, edit only `project-graph.json`, canvas `manifest.json`, and source prompt Markdown needed for the revision, and run canvas-scoped plus project validation.
- Do not edit runtime `state.json`, `results/`, active canvas selection, recovery transactions, or implementation artifacts from this skill.

## Required Output

1. Verdict: `PASS`, `NEEDS_REVISION`, or `BLOCKED`.
2. Flow Coverage table before findings.
3. Findings by severity.
4. Recommended revision order.

Flow Coverage table:

| Flow | Trigger/Input | Core Processing | External Dependency | State/Storage | Interface/Consumer | Output/Side Effect | Failure Path | Verification | Gaps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

For every cell, cite exact PlanWeave task/block ids, prompts, reference files, and validation methods when they exist. Use `Gap:` for missing task coverage, prompt coverage, dependency edge, verification, real behavior, or required failure handling.

## Audit Checklist

### Goal Coverage
- Identify the authoritative target before judging the plan.
- Check whether all key goals, requirements, constraints, and risks are represented.
- Flag omitted, weakened, or incorrectly deferred requirements.
- Do not accept a demo subset as full delivery unless the user explicitly scoped it that way.

### Data Flow Coverage
- This section is mandatory and must be completed before judging task-list completeness.
- Identify the plan's main value flows or lifecycle flows. A flow is any path where an input, decision, object, user action, external event, or scheduled job moves through the system and produces an observable outcome.
- For each major flow, trace the relevant stages that apply: source/trigger/input; validation/normalization/parsing; planning/decision/orchestration; processing/transformation/execution; external dependency/provider/model/tool call; state/persistence/cache/artifact storage; contract/interface/API/CLI/event/message; user or downstream consumption; output/side effect/artifact/report; error/retry/cancellation/recovery; verification/observability/acceptance evidence.
- Map every applicable stage to exact PlanWeave task/block ids, prompts, reference files, dependency edges, and validation methods.
- If a required stage has no task, no prompt, no dependency edge, no verification, or is only covered by mock behavior while the goal requires real behavior, report a gap.
- Do not let a long task list count as coverage when the end-to-end flow is broken.

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
- Check whether tasks, blocks, canvases, project graph edges, and dependency edges express the real execution order.
- Parallel tasks must be independent in data flow, locks, and contract timing.
- Different canvases are not automatically parallel; cross-canvas dependencies must be explicit in `project-graph.json` when a formal project graph exists.
- Canvas-level dependencies must be project graph canvas edges; cross-canvas task blockers must be explicit `crossTaskEdges`.
- Treat dense or repeated `crossTaskEdges`, stage-wide ordering expressed as task edges, and task edges redundant with canvas order as a canvas-boundary defect.
- Require tightly coupled tasks to move into the same canvas and stage-wide dependencies to become canvas edges. Accept cross-task edges only as sparse, irreducible blockers with a concrete reason that task relocation or a canvas edge would be incorrect.
- Flag plans that express canvas order only in project/global prompt prose, README text, or agent instructions.
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
- For formal multi-canvas plans, verify `project-graph.json` exists, every canvas points at an existing package, every cross-task ref resolves to a real task, and canvas/cross-task dependency cycles are absent.
- Confirm single-canvas `manifest.json` semantics stay local to that canvas; cross-canvas dependency enforcement must not be hidden in local manifests or prompt prose.
- Compare suspicious project graph, manifest, state, and layout structure against `planweave schema project`, `planweave schema manifest`, `planweave schema state`, and `planweave schema layout`.
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
