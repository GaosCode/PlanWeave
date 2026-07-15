---
name: plan-coordinator
description: Coordinate end-to-end PlanWeave execution as the main agent by inspecting status, assigning work to subagents, routing review and recovery, and keeping the plan loop moving. Use when orchestrating a full PlanWeave plan, managing multiple agents, continuing execution, or deciding what should run next.
---

# Plan Coordinator

Use this skill as the main agent/controller for a PlanWeave package. The coordinator thread is a dispatcher only: it must not implement blocks, review gates, feedback fixes, edit target source files, edit Plan Package files, or write implementation/review artifacts itself.

`plan-runner`, `plan-reviewer`, and `plan-recovery` are role instructions for worker subagents. They are not permission for the coordinator to switch roles inside the same thread. If current-agent or manual work cannot be handed to a native subagent mechanism, stop and report `NEEDS_COORDINATOR` unless the user explicitly authorizes coordinator fallback.

## Quick Start

1. Resolve the CLI entry. Use `<pw> help work`, `<pw> help submit`, and `<pw> help recovery` for command syntax.
2. Run preflight: confirm `PLANWEAVE_HOME`, project id, project graph path when present, package/canvas paths, source prompt paths, current refs, and active feedback.
3. Decide whether to assign implementation work, review work, feedback work, or recovery work.
4. Give each worker subagent exactly one work item, claim ownership, rendered prompt path/content, expected artifact, submit command, and validation expectations.
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

- Treat PlanWeave skills as execution roles for worker subagents. The coordinator owns routing and must tell each current-agent subagent which skill to use.
- Treat PlanWeave executor assignment as the routing authority for every implementation block, review block, and feedback claim. Use `<pw> claim-next --dry-run --json` only for automatic preview; exact `claim <ref>` has no dry-run option. After `claim-next --json`, `claim-next --dry-run --json`, or `claim <ref>`, read the claim's `effectiveExecutor`; for parallel batch claims, read `effectiveExecutors` per ref.
- Before routing `manual` or current-agent work, discover the current agent's native subagent mechanism. In Codex, search for the multi-agent/subagent tool and spawn a bounded worker with the subagent packet.
- If `effectiveExecutor` is `manual`, route the item through the current agent's native subagent workflow instead of `planweave run --executor manual`.
- If `effectiveExecutor` names the current agent, route the item through the current agent's native subagent workflow instead of invoking that same agent through PlanWeave's configured runner.
- If `effectiveExecutor` names a different agent, run that ref through PlanWeave runtime so the configured runner (CLI or ACP) owns the work: `<pw> run --once --scope block --block <ref>`. Do not add `--executor <name>` unless deliberately overriding the Plan Package assignment.
- For feedback claims, apply the same rule to the feedback claim's `effectiveExecutor`; if it is `manual` or the current agent, route through a current-agent worker subagent, otherwise use PlanWeave runtime.
- If PlanWeave runtime delegation to a non-current executor fails, do not complete or submit that same ref with the current agent unless the user explicitly authorizes an executor override or fallback. Preserve the blocker, inspect run-status/latest record/logs, and route to `plan-recovery` or fix executor configuration before retrying.
- Assign `plan-runner` to a worker subagent for one implementation block only when that block's `effectiveExecutor` is `manual` or the current agent.
- Assign `plan-reviewer` to a worker subagent for one review gate only when that review block's `effectiveExecutor` is `manual` or the current agent. If a review block inherits `opencode`, `claude-code`, `pi`, or another non-current executor from its task or package default, route it through PlanWeave runtime instead of reviewing it locally.
- Assign `plan-recovery` to a worker subagent or run recovery commands yourself only for doctor findings, stale current refs, orphan results, state/index drift, blocked/diverged work, or submit retry confusion. Recovery must not include implementation or review work.
- If no native subagent tool is available for `manual` or current-agent work, stop and report `NEEDS_COORDINATOR`; do not run `plan-runner` or `plan-reviewer` directly in the coordinator thread.
- Do not send review gates to current-agent implementation subagents. This does not override PlanWeave executor assignment: if the Plan Package assigns a review gate to a non-current runner profile, the runtime should dispatch that profile.
- Do not send recovery work to normal implementation agents.

## Coordinator Loop

1. Check current and status before claiming.
2. Prefer explicit claims when assigning known refs; use automatic claim only when PlanWeave should choose.
3. Preview automatic scheduling with `<pw> claim-next --dry-run --json`; preview parallel batches with `<pw> claim-next --parallel --dry-run --json`, then split the batch by each ref's `effectiveExecutors` entry.
4. For each assigned item, record ref, task, block type, effective executor, prompt source, submit command, and agent owner. For native current-agent work, the owner must be a subagent id/name, not the coordinator thread.
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

- Within one canvas, use runtime-reported ready, claimable, and dispatchable results as the scheduling authority. Do not reproduce scheduler rules in the coordinator.
- Treat `parallel.sharedResources` as non-blocking coordination context for worker handoffs and overlap warnings. It does not change readiness, claimability, batch selection, or concurrency capacity.
- Different canvases are not automatically parallel; cross-canvas dependencies must come from formal project graph canvas edges and explicit `crossTaskEdges` when `project-graph.json` exists.
- If no formal project graph exists, do not assume cross-canvas parallelism; require explicit user or package guidance before dispatching across canvases.
- Do not dispatch downstream canvas work while upstream canvas blockers or explicit cross-task blockers remain incomplete.
- Use `status --json`, `claim-next --dry-run --json`, or `claim-next --parallel --dry-run --json` to build the next batch, then assign refs explicitly.
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
- for plan update handoffs, CLI-returned workspace paths, exact semantic files expected to change, and canvas-scoped plus project validation commands when project graph dependencies may change.

The coordinator may submit an artifact after a worker returns it, but must not author the implementation report, feedback report, or review-result JSON itself.

## Executor Run Monitoring

- Select the observation path from the run's `runnerKind`, capabilities, session identity, and record metadata.
- After delegating to a non-current agent with `<pw> run --once --scope block --block <ref>`, inspect `<pw> run-status --json` and `<pw> run-session <session-id> --json`; verify the effective executor, agent id, runner kind, ordered runner progress, pending-interaction diagnostics, terminal phase/reason, and latest record path before deciding whether to continue.
- Use `run-status --follow --json` for live ordered runner progress.
- Keep execution on the selected runner transport. Route authentication, quota, provider, permission, and elicitation boundaries through the capabilities and diagnostics returned for that run.
- For bounded unattended execution, pass an explicit positive `--timeout <ms>` to `run`; timeout and Ctrl-C must reach the selected runner cancellation/cleanup chain.
- Use normalized runner events, session state, diagnostics, and record artifacts as the primary evidence for every transport.
- For ACP runs, follow ordered runner events and resolve permission or elicitation requests through the runtime-provided interaction identity and capability.
- For CLI runs, use the terminal monitoring, attach commands, and captured-output artifacts present in the run record.
- Determine the outcome from terminal state, metadata, diagnostics, report/review result, artifacts, and submitted state.
- For executor failures, timeouts, stale current refs, missing reports, or inconsistent submitted state, stop dependent dispatch and route to `plan-recovery`.

## Review And Feedback

- Review gates are sequential control points.
- A `needs_changes` review creates runtime feedback work; route feedback handling deliberately and then return to review.
- Do not mark review as passed from implementation confidence alone.
- Do not resubmit resolved feedback as current work.
- If review cycles are exhausted or contradictory, route to `plan-recovery` before continuing.

## Recovery Boundary

- Use `plan-recovery` before runtime repair commands, state/results changes, or Plan Package reconciliation.
- Keep plan defects separate from PlanWeave toolchain defects.
- Treat `doctor` as a state/results consistency probe, not a general plan repair tool.
- For bad dependencies, wrong parallelization, missing prompts, or review-gate design problems, stop dependent dispatch and hand off a Plan Package update instead of `doctor --repair`.
- The coordinator must not directly edit `project-graph.json`, canvas `manifest.json`, or source prompt Markdown; include the target paths and validation commands in the worker handoff.
- Do not hide partial success, duplicate runs, stale current refs, or orphan artifacts.
- If package changes are needed to resolve divergence, pause dependent execution until the package is reconciled.

## Completion Report

When stopping, report:

- completed refs and submitted artifacts.
- open refs, blockers, or divergence.
- validation run.
- recovery actions taken.
- whether the next action is claim, review, recovery, import/update plan, or user decision.
