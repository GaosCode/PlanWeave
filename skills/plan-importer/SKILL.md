---
name: plan-importer
description: Generate a block-level PlanWeave Plan Package from project documentation and validate it through the planweave CLI.
---

# Plan Importer

Use this skill when a user wants to turn a project's own planning documents into a PlanWeave Plan Package for that project.

## Workspace Location

- Run PlanWeave commands from the target project's root, not from the PlanWeave repository unless PlanWeave itself is the target project.
- Do not create or write `./.planweave` inside the target project by hand.
- PlanWeave stores project plans under `PLANWEAVE_HOME` when that environment variable is set.
- When `PLANWEAVE_HOME` is not set, the default home is the user's `.planweave` directory:
  - macOS: `~/.planweave`
  - Linux: `~/.planweave`
  - Windows: `%USERPROFILE%\.planweave`
- A specific project package is nested under that home as `projects/<project-id>/package`; never guess `<project-id>`.
- Always read the exact package path from `planweave init --json` or `planweave paths --json`, then write only inside that returned `workspace.packageDir` / `packageDir`.

## Workflow

1. Scan the target project's planning documents, README, ADRs, issue notes, and domain notes.
2. Record the scanned source list before writing the package.
3. Extract goals, requirements, constraints, key decisions, components, risks, Task Nodes, and executable Blocks.
4. Build a coverage map:
   - every task should implement at least one goal or requirement;
   - important constraints should be linked with `constrained_by`;
   - important component impact should be linked with `touches`;
   - known risks should be risk nodes linked with `conflicts_with` or other relevant context edges;
   - task `acceptance` entries must be concrete, verifiable outcomes.
5. Run `planweave init --json` from the target project root.
6. Read `.workspace.packageDir` from the JSON output. If the workspace already exists and you need to confirm paths, run `planweave paths --json`.
7. Write `manifest.json` into the returned package directory.
8. Write task prompts as `nodes/<task-id>/prompt.md`.
9. Write block prompts as `nodes/<task-id>/blocks/<block-id>.prompt.md`.
10. Add executor profiles only when the source plan needs Auto Run; otherwise rely on the built-in `manual` executor.
11. Run `planweave validate --json`.
12. Fix validation errors and importer-created weak coverage where possible.
13. Output a Plan Import Report for user review. The report is not runtime truth and must not be added to the manifest schema.

## Block Authoring

Every executable Task Node must include at least:

```text
T-001/
├─ prompt.md
└─ blocks/
   ├─ B-001.prompt.md
   └─ R-001.prompt.md
```

Manifest block shape:

```json
{
  "blocks": [
    {
      "id": "B-001",
      "type": "implementation",
      "title": "Implement current task",
      "prompt": "nodes/T-001/blocks/B-001.prompt.md",
      "depends_on": [],
      "parallel": { "safe": false, "locks": [] }
    },
    {
      "id": "R-001",
      "type": "review",
      "title": "Review current task",
      "prompt": "nodes/T-001/blocks/R-001.prompt.md",
      "depends_on": ["B-001"],
      "review": {
        "required": true,
        "maxFeedbackCycles": 1,
        "hook": null
      }
    }
  ]
}
```

If source docs explicitly include testing or verification work, add a `check` block and make the review block depend on it.

## Executor Profiles

Use the built-in manual executor unless the plan explicitly needs Auto Run:

```json
{
  "execution": {
    "defaultExecutor": "manual",
    "parallel": { "enabled": false, "maxConcurrent": 1 }
  },
  "executors": {
    "manual": { "adapter": "manual" }
  }
}
```

## Rules

- Treat `package/manifest.json`, `nodes/<task-id>/prompt.md`, and `nodes/<task-id>/blocks/*.prompt.md` as the plan content source of truth.
- Treat the CLI-returned package directory as the only writable Plan Package location.
- Do not write `package/global-prompt.md`.
- Do not write `manifest.global_prompt`.
- Do not create `feedback` block types.
- Do not create runtime graph mirrors, `.plan/`, SQLite stores, HTTP APIs, Docker services, or MCP servers.
- Do not write implementation state into the manifest.
- Use `state.json` only for runtime task/block/feedback state.
- Do not use the Plan Import Report as a substitute for manifest edges, task acceptance, or prompt content.
