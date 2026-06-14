---
name: plan-importer
description: Generate a block-level PlanWeave Plan Package from project documentation and validate it through the PlanWeave CLI. Use when importing plans, PRDs, roadmaps, issue sets, or architecture notes into a PlanWeave package.
---

# Plan Importer

Use this skill to turn project planning material into a PlanWeave Plan Package.

## Command Entry

Resolve the command before writing files:

1. Use a user-provided command if given.
2. Else try global `planweave`.
3. In the PlanWeave repo, prefer `pnpm --filter @planweave-ai/cli planweave`.
4. If the repo defines another local script, use that exact entry and show it in the report.

Write examples as `<pw> ...`, where `<pw>` is the resolved command.

## Workspace

- Run `<pw>` from the target project root, not from the PlanWeave repo unless PlanWeave itself is the target project.
- Do not create or write `./.planweave` inside the target project by hand.
- PlanWeave stores project plans under `PLANWEAVE_HOME` when set; otherwise defaults to:
  - macOS: `~/.planweave`
  - Linux: `~/.planweave`
  - Windows: `%USERPROFILE%\.planweave`
- Read exact workspace paths from `<pw> init --json` or `<pw> paths --json`.
- For single-canvas plans, write only inside the returned `workspace.packageDir` / `packageDir`.
- For formal multi-canvas plans, write `project-graph.json` at the returned project/workspace root and write each canvas package only under the package directories named by that project graph.
- Treat CLI-returned project/workspace and package directories as the only writable PlanWeave locations.

## Import Workflow

1. Scan README, planning docs, ADRs, issues, specs, domain notes, and referenced source files.
2. Record the scanned source list before writing.
3. Extract executable Task Nodes and Blocks; task canvas graphs are task-only.
4. Do not create context nodes. Put goals, requirements, constraints, risks, references, and architecture gates into project/global prompt, task acceptance, task prompt, or block prompt.
5. Run the Plan Quality Gate below before writing. Build a coverage map: each task has concrete acceptance, each block has verifiable done criteria, and key requirements have an explicit prompt placement.
6. Choose one canvas or a formal multi-canvas project graph. For multi-canvas imports, plan `project-graph.json` first, then each canvas `manifest.json`.
7. Run `<pw> init --json`, then write `project-graph.json` when needed, plus each canvas `manifest.json`, task prompts, and block prompts under the returned/declared package directories.
8. Run `<pw> validate --json`; fix validation errors and weak importer-created coverage.
9. Output a Plan Import Report listing source docs, command entry, project graph path when present, package paths, prompt placement, canvas strategy, review strategy, and validation result.

## Plan Quality Gate

- Map every authoritative goal to a task, block, acceptance item, or prompt; flag omitted, weakened, or incorrectly deferred requirements.
- Do not accept a demo subset as complete delivery unless the user explicitly scoped it that way.
- Identify core objects and trace create, structure, validation, transform, state, storage, consumer, side effects, final output, failure, retry, rollback, and manual intervention.
- Keep schema, types, APIs, CLI flags, events, files, and prompt inputs/outputs consistent across producers and consumers.
- Contract-changing tasks must cover callers, tests, fixtures, docs, and migrations when relevant; do not hide missing contracts with fallback, default values, `any`, or mock-only paths.
- Model the real execution order: parallel tasks must be independent, sequential gates must be explicit, and each canvas must map to a phase, capability area, or parallel work group.
- For multi-canvas imports, canvas-level order must be encoded as formal project graph edges, and cross-canvas task blockers must be encoded as explicit `crossTaskEdges`.
- Do not rely on project/global prompt prose as the only source of canvas order or cross-canvas blockers.
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
- Materialize large or multi-phase imports as a formal `project-graph.json` plus one `manifest.json` per canvas.
- Use project graph canvas dependency edges for canvas-level order.
- Use explicit `crossTaskEdges` for task-to-task blockers across canvases.
- Keep single-canvas `manifest.json` semantics unchanged; do not place cross-canvas edges inside a canvas manifest.
- The project/global prompt may explain strategy, but it is not the authority for dependency enforcement.
- Different canvases are not automatically parallel; run them in parallel only when project graph edges, `crossTaskEdges`, and locks make that safe.

## Project Graph Shape

When writing a formal multi-canvas plan, include:

- `project-graph.json` at the PlanWeave project/workspace root.
- `canvases` entries with stable ids, titles, package directories, state/results paths when required by the schema, and no invisible legacy-only canvas records.
- canvas dependency edges for phase/subsystem order.
- explicit `crossTaskEdges` for blockers from one canvas task to another canvas task.
- no context nodes, feedback nodes, runtime state, or layout-only graph mirrors.

After writing, validate with `<pw> validate --json`; project graph schema/read/compile diagnostics such as missing canvas refs, missing cross-task refs, and cycles must be fixed before reporting success.

## Block Shape

Each block needs `id`, `type`, `title`, `prompt`, `depends_on`, parallel safety/locks, done criteria, validation, and report expectations. If review is justified, add `R-001` after implementation blocks with `review.required: true` and a clear review prompt.

## Rules

- Treat `project-graph.json` (when present), each canvas `manifest.json`, source prompts, and task/block prompt files as plan content source of truth.
- Do not create `feedback` block types; feedback is runtime state.
- Do not write implementation state into the manifest.
- Use `state.json` only for runtime task/block/feedback state.
- Do not create runtime graph mirrors, `.plan/`, SQLite stores, HTTP APIs, Docker services, or MCP servers.
- Do not use the Plan Import Report as a substitute for manifest edges, task acceptance, or prompt content.
