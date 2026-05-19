---
name: plan-runner
description: Claim and execute PlanWeave tasks through the planweave CLI.
---

# Plan Runner

Use this skill when a user wants an agent to execute tasks from an existing PlanWeave Plan Package.

## Workflow

1. Run `planweave status` to inspect the current plan state.
2. If parallel execution is enabled for the package, run `planweave claim-next --parallel`; otherwise run `planweave claim-next`.
3. For each claimed task, run `planweave prompt <task-id>`.
4. Treat the returned Markdown as the task prompt and execute it.
5. Write an implementation report as Markdown.
6. Run `planweave submit-result <task-id> --report <path>`.
7. If implementation reality diverges from the plan, run either:
   - `planweave submit-result <task-id> --report <path> --status diverged`
   - `planweave mark-diverged <task-id> --reason "<reason>"`

## Rules

- Do not edit `state.json` or `results/` directly; use the CLI.
- Do not mark tasks verified through `submit-result`.
- A failed review returns the task to `needs_changes`; the next claim prioritizes it.
