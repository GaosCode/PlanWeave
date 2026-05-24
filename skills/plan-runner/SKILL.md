---
name: plan-runner
description: Claim and execute PlanWeave blocks through the planweave CLI.
---

# Plan Runner

Use this skill when a user wants an agent to execute work from an existing PlanWeave Plan Package.

## Workflow

1. Run `planweave status --json`.
2. Run `planweave claim-next`, or `planweave claim-next --parallel` only when package parallel execution is enabled.
3. Parse the JSON Claim Result:
   - `kind: "block"`: use `ref` as the only execution identifier.
   - `kind: "feedback"`: treat `content` as the current task input.
   - `kind: "batch"`: execute every returned block `ref`.
   - `kind: "none"`: stop and report no claimable work.
   - `kind: "blocked"`: stop and report `reason`.
4. For `kind: "block"`, run `planweave prompt <ref>`.
5. If `blockType` is `implementation` or `check`, execute the prompt, write a Markdown report, then run `planweave submit-result <ref> --report <path>`.
6. If `blockType` is `review`, execute the prompt, write `review-result.json`, then run `planweave submit-review <ref> --result <path>`.
7. For `kind: "feedback"`, handle the feedback, write a Markdown feedback report, then run `planweave submit-feedback --report <path>` and follow `nextCommand`.
8. If a block is externally blocked, run `planweave mark-blocked <ref> --reason "<reason>"`.
9. If a block becomes unblocked, run `planweave unblock <block-ref> --reason "<reason>"`.
10. If implementation reality diverges from the plan, run `planweave mark-diverged <ref> --reason "<reason>"`.

## Auto Run Boundary

- Skill Mode stays agent-native: this skill uses `claim-next`, `prompt`, and submit commands from inside the current agent.
- Auto Run Mode is a separate PlanWeave-managed entrypoint: `planweave run` uses executor profiles and may call `codex exec`.
- Use `planweave run --once --executor manual` only to write the next rendered prompt artifact and leave the block `in_progress` for manual submission.
- Use `planweave executors list` and `planweave executors test <profile>` before asking PlanWeave to call an external executor.

## Prompt Source Editing

- PlanWeave Global Prompt, Project Prompt, Task Node Prompt, and Block Prompt are editable source prompts, not immutable system policy.
- Agents may update those source prompts when the user asks for it or the claimed plan work requires prompt maintenance.
- Do not write rendered prompt output back into source prompt files. Rendered prompts are derived artifacts from `planweave prompt <ref>`.
- Keep prompt edits scoped to the relevant source file and preserve the normal CLI submit flow for execution results.

## Claim Result Contract

```ts
{ kind: "block"; ref: string; taskId: string; blockId: string; blockType: "implementation" | "check" | "review"; reason?: "claimed" | "current" | "feedback_resolved" }
{ kind: "feedback"; content: string }
{ kind: "batch"; refs: string[] }
{ kind: "none"; reason?: string }
{ kind: "blocked"; ref?: string; reason: string }
```

## Rules

- Do not edit `state.json` or `results/` directly; use the CLI.
- Do not call task-level commands; all agent-facing execution commands use block refs like `T-001#B-001`.
- Do not create feedback blocks in the Plan Package. Feedback is runtime state and is handled with `submit-feedback`.
- Do not mark tasks verified manually. Task Node `implemented` is aggregated by the Task Manager after required implementation/check blocks complete and required review blocks pass.
- Do not implement a diverged block as normal work. Reconcile the Plan Package, then use `planweave resolve-divergence <block-ref> --reason "<reason>"`.
