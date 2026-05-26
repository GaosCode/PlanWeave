---
name: plan-importer
description: Generate a schema-checked PlanWeave Plan Package from project documentation and validate it through the PlanWeave CLI. Use when importing plans, PRDs, roadmaps, issue sets, or architecture notes into a PlanWeave package.
---

# Plan Importer

Use this skill to turn project planning material into a PlanWeave Plan Package.

## Command Entry

Resolve the command before writing files:

1. Use a user-provided command if given.
2. Else try global `planweave`.
3. In the PlanWeave repo, prefer `pnpm --filter @planweave/cli planweave`.
4. If the repo defines another local script, use that exact entry and show it in the report.

Write examples as `<pw> ...`, where `<pw>` is the resolved command.
Use `<pw> help schema` for schema navigation and `<pw> schema manifest` before writing package JSON.

## Workspace

- Run `<pw>` from the target project root, not from the PlanWeave repo unless PlanWeave itself is the target project.
- Do not create or write `./.planweave` inside the target project by hand.
- PlanWeave stores project plans under `PLANWEAVE_HOME` when set; otherwise defaults to:
  - macOS: `~/.planweave`
  - Linux: `~/.planweave`
  - Windows: `%USERPROFILE%\.planweave`
- Read the exact package path from `<pw> init --json` or `<pw> paths --json`; write only inside the returned `workspace.packageDir` / `packageDir`.
- Treat the CLI-returned package directory as the only writable Plan Package location.

## Import Workflow

1. Scan README, planning docs, ADRs, issues, specs, domain notes, and referenced source files.
2. Record the scanned source list before writing.
3. Extract executable Task Nodes and Blocks; graph nodes are task-only.
4. Do not create context nodes. Put goals, requirements, constraints, risks, references, and architecture gates into project/global prompt, task acceptance, task prompt, or block prompt.
5. Run the Plan Quality Gate below before writing. Build a coverage map: each task has concrete acceptance, each block has verifiable done criteria, and key requirements have an explicit prompt placement.
6. Run `<pw> init --json` and `<pw> schema manifest`, then write `manifest.json`, task prompts, and block prompts under the returned package directory.
7. Run `<pw> validate --json`; fix validation errors and weak importer-created coverage.
8. Output a Plan Import Report listing source docs, command entry, package path, prompt placement, canvas strategy, review strategy, and validation result.

## Plan Quality Gate

- Map every authoritative goal to a task, block, acceptance item, or prompt; flag omitted, weakened, or incorrectly deferred requirements.
- Do not accept a demo subset as complete delivery unless the user explicitly scoped it that way.
- Identify core objects and trace create, structure, validation, transform, state, storage, consumer, side effects, final output, failure, retry, rollback, and manual intervention.
- Keep schema, types, APIs, CLI flags, events, files, and prompt inputs/outputs consistent across producers and consumers.
- Contract-changing tasks must cover callers, tests, fixtures, docs, and migrations when relevant; do not hide missing contracts with fallback, default values, `any`, or mock-only paths.
- Model the real execution order: parallel tasks must be independent, sequential gates must be explicit, and each canvas must map to a phase, capability area, or parallel work group.
- Reject fake completion such as schema with no runtime use, API with no caller, UI with no behavior, config never read, provider abstraction without live client, queue without consumer, file path without file, dry-run without live path, or fixture-only testing.
- Cover errors, retry, cancellation, timeout, permission failure, partial success, external outage, failed human review, and recovery when the domain needs reliable execution.
- Every block must name concrete validation: commands, tests, output artifacts, observable state changes, or end-to-end flows.
- Complex blocks must encode architecture boundaries, test location, config/env handling, README or `.env.example` updates when applicable, and real provider vs mock/dry-run expectations in done criteria.
- Do not copy other projects' skills, bootstrap rules, or prompt conventions into this plan unless the target repository explicitly requires them.
- Separate plan defects from PlanWeave toolchain defects in the report.

## Prompt Placement

- PlanWeave Global Prompt / Project Prompt: cross-cutting rules, architecture constraints, reference files, coding standards, shared risks.
- Task Prompt: task-local context, acceptance rationale, dependencies, files likely touched.
- Block Prompt: exact execution instructions, validation commands, output/report expectations.
- Do not write rendered prompt output back into source prompt files. Rendered prompts come from `<pw> prompt <ref>` and are derived artifacts.
- Do not leave block prompts empty. If a block needs no separate detail, say that it inherits task/project context and list the concrete done condition.

## Task And Block Granularity

- Do not split for the sake of splitting. Split by data flow, ownership boundary, dependency, risk, or independently verifiable acceptance.
- Merge tasks that are too small to claim, test, or report independently.
- Use `implementation` blocks for executable work and encode explicit verification in done criteria, validation commands, or review gates.
- Add review blocks only for complex code, cross-contract changes, database/schema migration, provider integration, security/privacy, architecture changes, or high-risk user-visible behavior.
- Do not add review blocks for simple docs, config tweaks, local copy edits, or low-risk single-file changes unless the user asks.

## Multi-Canvas Strategy

- For small plans, use one package canvas.
- For large plans, especially 100+ tasks/nodes, split by phase, subsystem, workflow, or owner into task canvases.
- Keep each canvas scannable, usually 10-30 tasks when the source plan allows it.
- Express cross-canvas dependencies through task dependency edges and explain canvas order in project/global prompt.
- Different canvases are not automatically parallel; run them in parallel only when dependency edges and locks make that safe.

## Block Shape

Each block needs `id`, `type`, `title`, `prompt`, `depends_on`, parallel safety/locks, done criteria, validation, and report expectations. If review is justified, add `R-001` after implementation blocks with `review.required: true` and a clear review prompt.

## Rules

- Treat `package/manifest.json`, source prompts, and task/block prompt files as plan content source of truth.
- Do not hand-author manifest, state, or layout from memory; use `<pw> schema manifest`, `<pw> schema state`, or `<pw> schema layout`.
- Do not create `feedback` block types; feedback is runtime state.
- Do not write implementation state into the manifest.
- Use `state.json` only for runtime task/block/feedback state.
- Do not create runtime graph mirrors, `.plan/`, SQLite stores, HTTP APIs, Docker services, or MCP servers.
- Do not use the Plan Import Report as a substitute for manifest edges, task acceptance, or prompt content.
