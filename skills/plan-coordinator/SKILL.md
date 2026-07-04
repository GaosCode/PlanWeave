---
name: plan-coordinator
description: Coordinate end-to-end PlanWeave execution as the main agent by inspecting status, assigning work to subagents, routing review and recovery, and keeping the plan loop moving. Use when orchestrating a full PlanWeave plan, managing multiple agents, continuing execution, or deciding what should run next.
---

# Plan Coordinator

Use this skill as the main agent/controller for a PlanWeave package. Do not implement block work yourself unless the task is small enough to run with `plan-runner` directly.

## Quick Start

1. Resolve the CLI entry. Use `<pw> help work`, `<pw> help submit`, and `<pw> help recovery` for command syntax.
2. Run preflight: confirm `PLANWEAVE_HOME`, project id, project graph path when present, package/canvas paths, source prompt paths, current refs, and active feedback.
3. Decide whether to assign implementation work, review work, feedback work, or recovery work.
4. Give each subagent exactly one work item, claim ownership, rendered prompt path/content, expected artifact, submit command, and validation expectations.
5. Collect reports/results, submit or verify submission, then re-check status.
6. Continue until the plan is complete, genuinely blocked, or diverged and needs user/plan reconciliation.

## Preflight

- Read `<pw> paths --json` before dispatching and record project id, package dir, state path, and results dir.
- Identify the active canvas/package scope and where cross-canvas dependencies are expressed.
- For formal multi-canvas projects, treat `project-graph.json` as the authority for canvas-level dependencies and explicit cross-task blockers.
- Do not infer runnable canvas order from prompt prose when a formal project graph exists.
- Confirm source of truth for global, project, task, and block prompts; rendered prompts are derived output.
- Produce a prompt source summary when prompts look empty, inherited, or surprising.
- Surface inherited prompt sources before dispatching work, including global prompt, project/canvas prompt, task node prompt, block prompt, and any higher-level flow requirements.
- Do not inject other projects' skills, bootstrap rules, or agent instructions into prompts unless the target repository explicitly requires them.

## Routing

- Treat PlanWeave skills as execution roles. The coordinator owns routing and must tell each subagent which skill to use.
- Treat PlanWeave executor assignment as the routing authority when it is present. After `claim-next`, `claim`, or a dry-run claim, read the claim's `effectiveExecutor`; for batch claims, read `effectiveExecutors` per ref.
- If `effectiveExecutor` is `manual`, route the item through the current agent's native subagent/skill workflow instead of `planweave run --executor manual`.
- If `effectiveExecutor` names the current agent, prefer the current agent's native subagent/skill workflow instead of invoking that same agent through PlanWeave's CLI executor.
- If `effectiveExecutor` names a different agent, run that ref through PlanWeave runtime so the configured CLI executor owns the work: `<pw> run --once --scope block --block <ref>`. Do not add `--executor <name>` unless deliberately overriding the Plan Package assignment.
- For feedback claims, apply the same rule to the feedback claim's `effectiveExecutor`; if it is `manual` or the current agent, route through the current agent workflow, otherwise use PlanWeave runtime.
- If PlanWeave runtime delegation to a non-current executor fails, do not complete or submit that same ref with the current agent unless the user explicitly authorizes an executor override or fallback. Preserve the blocker, inspect run-status/latest record/logs, and route to `plan-recovery` or fix executor configuration before retrying.
- Use `plan-runner` for one implementation block.
- Use `plan-reviewer` for one review gate.
- Use `plan-recovery` for doctor findings, stale current refs, orphan results, state/index drift, blocked/diverged work, or submit retry confusion.
- If no subagents are available and the work is small, run a single implementation block with `plan-runner`.
- Do not send review gates to implementation agents.
- Do not send recovery work to normal implementation agents.

## Coordinator Loop

1. Check current and status before claiming.
2. Prefer explicit claims when assigning known refs; use automatic claim only when PlanWeave should choose.
3. Preview parallel claims before dispatching a batch, and split the batch by each ref's `effectiveExecutors` entry.
4. For each assigned item, record ref, task, block type, effective executor, prompt source, submit command, and agent owner.
5. Keep only active subagents running; close completed agents after report submission.
6. If the active tool exposes close, archive, or stop controls for subagents, close completed, failed, or idle subagents after their report is captured.
7. If no close/archive/stop API exists, stop polling inactive agents and record their terminal lifecycle state instead of implying they were closed.
8. After every submit, re-run status/current before assigning more work.
9. If `none`, compare parallel and sequential claimability before declaring the plan idle.
10. If `blocked`, `diverged`, stale, or inconsistent, stop dispatching dependent work and route to recovery.

## Claim Ownership

- If the coordinator already claimed a ref, mark the handoff `already claimed`; the subagent must not run `claim` or `claim-next`.
- If the subagent must claim first, mark the handoff `claim required` and name the exact ref or task.
- If a subagent claims a different ref than assigned, stop and reconcile before execution.

## Parallel Dispatch

- Within one canvas, dispatch only ready blocks whose dependency edges are satisfied and whose locks/parallel safety do not conflict.
- Different canvases are not automatically parallel; cross-canvas dependencies must come from formal project graph canvas edges and explicit `crossTaskEdges` when `project-graph.json` exists.
- If no formal project graph exists, require explicit documented canvas order before dispatching across canvases and report that this is legacy compatibility rather than enforced project graph behavior.
- Do not dispatch downstream canvas work while upstream canvas blockers or explicit cross-task blockers remain incomplete.
- Use dry-run/status to build the next batch, then assign refs explicitly.
- Review gates are sequential control points unless the plan explicitly models otherwise.

## Subagent Packet

Every subagent handoff should include:

- explicit instruction: `Use skill: plan-runner`, `Use skill: plan-reviewer`, or `Use skill: plan-recovery`.
- block ref or feedback id, plus claim ownership: `already claimed` or `claim required`.
- block type and expected skill: `plan-runner`, `plan-reviewer`, or `plan-recovery`.
- effective executor and why the work is routed to this agent instead of another PlanWeave executor.
- rendered prompt path/content and source prompt paths when relevant.
- exact report/result artifact expected.
- submit command or instruction to return the artifact to the coordinator.
- validation commands or observable completion criteria.
- scope boundaries and files not to touch.

## Executor Run Monitoring

- After delegating to a non-current agent with `<pw> run --once --scope block --block <ref>`, inspect `<pw> run-status --json` and the latest record path before deciding whether to continue.
- Runtime run records use `metadata.json`, `stdout.md`, and `stderr.log`; `run-status` provides summaries, not a streaming terminal.
- If `run-status --json` or `metadata.json` contains `tmuxSessionName`, prefer non-interactive inspection with `tmux capture-pane -p -e -S -5000 -t <session>` while the session is alive. Repeat capture-pane for low-risk live monitoring.
- Treat `tmuxAttachCommand` as a human interactive terminal entrypoint, not the coordinator's default observation path. After the session exits, read `stdout.md` and `stderr.log`.
- Do not assume a missing live tmux session means the run failed; check the run metadata, exit code, report/review result, and submitted state.
- For executor failures, timeouts, stale current refs, missing reports, or inconsistent submitted state, stop dependent dispatch and route to `plan-recovery`.

## Review And Feedback

- Review gates are sequential control points.
- A `needs_changes` review creates runtime feedback work; route feedback handling deliberately and then return to review.
- Do not mark review as passed from implementation confidence alone.
- Do not resubmit resolved feedback as current work.
- If review cycles are exhausted or contradictory, route to `plan-recovery` before continuing.

## Recovery Boundary

- Use `plan-recovery` before running repair commands or editing package/state files.
- Keep plan defects separate from PlanWeave toolchain defects.
- Treat `doctor` as a state/results consistency probe, not a general plan repair tool.
- For bad dependencies, wrong parallelization, missing prompts, or review-gate design problems, route to manual Plan Package adjustment instead of `doctor --repair`.
- Do not hide partial success, duplicate runs, stale current refs, or orphan artifacts.
- If package changes are needed to resolve divergence, pause dependent execution until the package is reconciled.

## Completion Report

When stopping, report:

- completed refs and submitted artifacts.
- open refs, blockers, or divergence.
- validation run.
- recovery actions taken.
- whether the next action is claim, review, recovery, import/update plan, or user decision.
