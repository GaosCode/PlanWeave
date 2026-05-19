---
name: plan-importer
description: Generate a PlanWeave Plan Package from project documentation and validate it through the planweave CLI.
---

# Plan Importer

Use this skill when a user wants to turn project documents into a PlanWeave Plan Package.

## Workflow

1. Scan the target project's planning documents, README, ADRs, and domain notes.
2. Run `planweave init`.
3. Locate the workspace package directory under `~/.planweave/projects/<project-id>/package/`.
4. Write `manifest.json`, `global-prompt.md`, and `nodes/*.prompt.md` directly into that package directory.
5. Ensure every task Prompt Surface contains:

```md
<!-- planweave:user:start task-body -->
...
<!-- planweave:user:end task-body -->
```

6. Run `planweave validate`.
7. Fix validation errors in the Plan Package.
8. Run `planweave refresh-prompts`.

## Rules

- Treat `package/manifest.json` and `nodes/*.prompt.md` as the plan content source of truth.
- Do not create runtime graph mirrors, `.plan/`, SQLite stores, HTTP APIs, Docker services, or MCP servers.
- Do not write implementation state into the manifest.
- Use `state.json` only for runtime task state.
