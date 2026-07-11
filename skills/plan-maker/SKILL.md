---
name: plan-maker
description: Create a PlanWeave package-shaped plan draft from a fuzzy goal, sparse requirements, codebase context, or a user idea before a formal Plan Package exists. Use when the user asks to make, draft, design, break down, or plan PlanWeave work without an existing PRD, roadmap, issue set, or strong source plan. Materialize a Plan Package only when the user explicitly asks.
---

# Plan Maker

Use this skill to design a PlanWeave package-shaped plan draft from incomplete input. Do not execute work, audit an existing package, or write a Plan Package unless the user explicitly asks to materialize the plan.

## Quick Start

1. Restate the user's goal, non-goals, constraints, and likely success criteria.
2. Ask only blocking clarification questions; otherwise state assumptions and continue.
3. Gather lightweight context from README, current code, schemas, tests, examples, and nearby docs.
4. Identify core objects, lifecycle stages, contracts, risks, and validation paths.
5. Draft canvases, tasks, blocks, formal project graph dependencies, prompt placement, review gates, and verification using PlanWeave's existing package concepts.
6. End with open assumptions and the recommended next action: refine with the user, audit with `plan-auditor`, or materialize the draft when explicitly requested.

## Context Discovery

- If strong source docs exist and the main job is converting them into a Plan Package, use `plan-importer`.
- If no docs exist, inspect the current codebase enough to avoid invented architecture.
- Search producers and consumers for likely core objects before splitting tasks.
- Treat user goals as authority, but mark uncertain scope, missing domain rules, and unknown external dependencies.
- Do not invent large product requirements to make the plan look complete.

## Planning Principles

- Design around core object lifecycles: create, validate, transform, state, storage, consumption, side effects, final output, failure, retry, rollback, and manual intervention.
- Keep schema, types, APIs, CLI flags, events, files, and prompt inputs/outputs consistent across producers and consumers.
- Split tasks by data flow, contract boundary, ownership, risk, or independently verifiable acceptance.
- Do not split only to create more nodes; merge tiny tasks that cannot be claimed, tested, or reported independently.
- Model real execution order with explicit dependencies and gates.
- Parallel tasks must be genuinely independent in data and contract timing. Record possible overlap
  with `parallel.sharedResources` so agents and the canvas can surface coordination context.
- Express mandatory order with graph dependencies.
- For multi-canvas plans, model orchestration as a formal project graph, not as prose-only canvas order.
- Do not schedule broad UI/package polish before foundation contracts and runtime behavior are stable.
- Do not import other projects' skills, bootstrap rules, or prompt conventions unless this target repository explicitly requires them.

## Plan Shape

Output a package-shaped plan draft plus a human-readable explanation. The draft must use PlanWeave's existing concepts as the source of truth for later materialization: project graph, canvas, task, block, dependencies, prompt files, and layout. The Markdown report is only an explanatory view.

If not writing files, show the draft as a package file plan rather than a new schema:

```text
Project:
  title: ...
  projectGraph: project-graph.json

Canvases:
  - id: ...
    packageDir: ...
    manifest: .../manifest.json
    tasks: ...

Dependencies:
  canvas: ...
  crossTaskEdges: ...

Prompts:
  .../nodes/.../prompt.md
```

The human-readable explanation should use these sections:

```md
## Goal
## Assumptions And Open Questions
## Canvas Strategy
## Project Graph
## Task Graph
## Prompt Placement
## Review Strategy
## Verification Strategy
## Risks And Recovery
## Handoff
```

For each task include:

- task id, title, owner canvas, objective, acceptance, dependencies, and likely files.
- blocks with type, purpose, shared resources, done criteria, validation, and report expectations.
- review only when risk justifies it.
- complex blocks must include architecture boundaries, test location, config/env handling, README or `.env.example` updates when applicable, and real provider vs mock/dry-run expectations.

For multi-canvas drafts include a `Project Graph` section with:

- canvas ids, titles, package directories, and why each canvas exists.
- canvas-level dependency edges for stage, capability, subsystem, or workflow order.
- Default multi-canvas drafts to `crossTaskEdges: []`.
- Before adding a cross-task edge, first move tightly coupled tasks into the same canvas or use a canvas dependency edge when the relation orders a whole stage, capability, subsystem, or workflow.
- Use explicit `crossTaskEdges` only for sparse, irreducible task blockers between otherwise cohesive and independently executable canvases, and record why task relocation or a canvas edge would be incorrect.
- Treat dense or repeated cross-task edges between the same canvases, stage-wide ordering expressed as task edges, and task edges redundant with canvas order as a canvas-boundary defect; repartition the tasks or promote the dependency.
- which canvases can run in parallel and why their data, contracts, and upstream blockers are independent;
  list possible shared-resource overlap separately without claiming it prevents execution.
- any manual graph-editing assumption; formal graph dependencies must not exist only in prose.

Small plans may stay single-canvas and omit `project-graph.json` materialization, but large plans, multi-stage plans, or plans split by subsystem should be drafted as a formal project graph.

## Prompt Placement

- Global/project prompt: shared goals, architecture rules, coding standards, references, and cross-cutting risks.
- Task prompt: task-local context, acceptance rationale, dependencies, and likely files.
- Block prompt: exact execution instructions, constraints, validation commands, and report expectations.
- Keep requirements in source prompts or task acceptance, not only in the planning report.
- Do not leave block prompts empty; if inherited context is enough, state the concrete done condition.

## Review Strategy

- Skip review for simple docs, config tweaks, copy edits, and low-risk local fixes unless the user asks.
- Add review for cross-layer code, schema/API/CLI contracts, database changes, provider integration, security/privacy, architecture, or high-risk user-visible behavior.
- Review gates should explain why they exist, who should run them, what pass means, and where `needs_changes` returns.

## Verification Strategy

- Every block needs observable completion: commands, tests, output artifacts, state transitions, or end-to-end flows.
- Distinguish mock, dry-run, live path, and real artifacts.
- Reject acceptance like "implemented", "logic correct", or "looks usable".
- Include failure-path validation when the feature needs reliable execution.

## Rules

- This skill produces a package-shaped plan draft, not runtime state.
- Do not create context nodes; place context in prompts, acceptance, or references.
- Do not create `feedback` blocks; feedback is runtime state.
- Do not model cross-canvas dependency order only in task prompts or narrative text; use project graph canvas edges and explicit cross-task dependencies in the draft.
- Do not write package files, run `planweave init`, or submit work unless the user explicitly asks to materialize or execute the plan.
- A package-shaped plan draft can be validated or materialized directly when the user asks to write or materialize it.
- When materializing, keep the package-shaped plan draft as the authoritative input. Resolve the workspace with the PlanWeave CLI, write the declared package files, validate through the PlanWeave CLI, and report remaining diagnostics.
- Use CLI/runtime commands for mechanical workspace operations: canvas creation, path allocation, id dedupe, active canvas selection, validation, recovery transactions, and runtime state/results changes.
- Edit Plan Package semantic files directly inside CLI-returned workspace paths: `project-graph.json` canvas intent and dependencies, each canvas `manifest.json` tasks/blocks/edges/acceptance/prompt paths, and source prompt Markdown.
- Use narrow CLI edit commands when they exactly express the semantic change; otherwise update the source package files and prompts directly.
- After direct plan edits, run canvas-scoped validation for edited canvases and project validation when `project-graph.json`, canvas edges, or `crossTaskEdges` changed.
- If the draft is intended for execution, recommend auditing it before import when risk is high.
