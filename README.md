
<p align="center">
  <img src="readme/assets/planweave-readme-animation.svg" width="860" alt="PlanWeave brand motion." />
</p>
<h1 align="center">PlanWeave</h1>


<p align="center">
  A file-backed agent workflow canvas where tasks become nodes, docs become blocks, and the whole project stays visible to your agents.
</p>

<p align="center">
  <a href="readme/README.zh-CN.md">中文 README</a>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.0.0-orange" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f" />
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178c6" />
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js-43853d" />
  <img alt="desktop" src="https://img.shields.io/badge/desktop-Electron-47848f" />
</p>



## Why PlanWeave

Most agent tools start from a chat transcript. PlanWeave starts from the work itself.

Your project is represented as a graph of task nodes and block documents. Each file has a stable place in the workflow, and each agent run receives the surrounding graph context instead of a narrow one-off prompt. That makes PlanWeave a better fit for long-running engineering work: implementation, review, feedback, follow-up fixes, and progress tracking all live in the same local project structure.

## Highlights

- **Files are nodes, documents are blocks**: the graph is not a decoration on top of chat. It is the project model.
- **Graph-friendly by default**: task flow, dependencies, review loops, and execution status are visible and editable.
- **Global context for agents**: agents can see the wider task graph, not only the current prompt fragment.
- **Per-node and per-block agent routing**: use Codex for one block, OpenCode for another, and local review scripts where deterministic checks are enough.
- **Full auto-run workflow**: PlanWeave can claim blocks, run agents, collect reports, handle review feedback, and continue the task flow.
- **Review and feedback as first-class work**: review blocks can produce structured feedback that returns to implementation blocks.
- **Desktop and CLI support**: use the visual Electron canvas or drive the same runtime from the terminal.
- **Live observability**: block runs keep logs, reports, metadata, and tmux attach commands for monitoring.
- **Statistics, search, and todo views**: inspect development efficiency and project state without leaving the workflow.
- **Local-first and file-backed**: plans, prompts, run records, and artifacts remain inspectable in your workspace.

## Repository Layout

```text
packages/runtime   Core graph, package, executor, auto-run, and desktop bridge logic
packages/cli       planweave command-line interface
packages/desktop   Electron desktop canvas
examples           Example PlanWeave packages
scripts            Repository checks
```

## Quick Start

Install dependencies and build all packages:

```bash
pnpm install
pnpm -r build
```

Run the desktop app:

```bash
pnpm --dir packages/desktop start
```

## Early Test Builds

PlanWeave is currently distributed as an early test build. macOS packages are not Developer ID signed or Apple-notarized yet. If you download a DMG from GitHub Releases, macOS may show an unidentified developer warning on first launch.

For early testing, open the app with **Right Click -> Open** and confirm the prompt. Formal signed and notarized builds can be added after the project is ready for broader distribution.

Build a local unsigned macOS DMG and ZIP:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir packages/desktop dist:mac
```

Run the CLI from this workspace:

```bash
pnpm --filter @planweave/cli planweave --help
pnpm --filter @planweave/cli planweave help
```

Initialize or open a project workspace:

```bash
pnpm --filter @planweave/cli planweave init --json
pnpm --filter @planweave/cli planweave validate --json
```

Run one automatic step:

```bash
pnpm --filter @planweave/cli planweave run --once
```

Inspect execution state:

```bash
pnpm --filter @planweave/cli planweave status
pnpm --filter @planweave/cli planweave run-status
```

## CLI Help

PlanWeave includes a product-level help command for agent workflows:

```bash
pnpm --filter @planweave/cli planweave help
pnpm --filter @planweave/cli planweave help work
pnpm --filter @planweave/cli planweave help submit
pnpm --filter @planweave/cli planweave help recovery
```

Use `planweave --help` for the raw command list, and `planweave help <command>` for command-specific options. Use `planweave help <topic>` for workflow guidance:

- `setup`: locate or initialize the PlanWeave workspace.
- `plan`: inspect and refresh prompt surfaces.
- `work`: inspect current work, preview claims, and claim executable blocks.
- `submit`: submit implementation, review, and feedback results.
- `explain`: understand why a block is or is not claimable.
- `recovery`: diagnose blocked, diverged, or inconsistent state.
- `autorun`: inspect executors and run controlled auto-run steps.

## Agent Workflow

A typical manual agent loop is:

```bash
pnpm --filter @planweave/cli planweave current
pnpm --filter @planweave/cli planweave claim-next --dry-run
pnpm --filter @planweave/cli planweave prompt T-001#B-001
pnpm --filter @planweave/cli planweave submit-result T-001#B-001 --report report.md
```

For review gates, submit a structured review result:

```bash
pnpm --filter @planweave/cli planweave submit-review T-001#R-001 --result review-result.json
```

If a review returns `needs_changes`, PlanWeave creates runtime feedback work. Handle it with:

```bash
pnpm --filter @planweave/cli planweave submit-feedback --report feedback-report.md
```

When scheduling is unclear, prefer `planweave explain <ref>`, `planweave why-not <ref>`, and `planweave doctor` before editing package or state files.

## Agent Execution

PlanWeave supports executor profiles, so different blocks can run through different agents or local commands. A typical graph can mix:

- Codex execution for implementation work.
- OpenCode execution for blocks that should run in an OpenCode session.
- Local review commands for deterministic validation.
- Review-feedback loops that continue automatically when feedback is enabled.

Each block run writes durable output under the PlanWeave workspace, including prompt, stdout, stderr, report, metadata, and monitor commands when available.

## Agent Skills

The repository includes focused agent skills under `skills/`:

- `plan-importer`: create a PlanWeave Plan Package from project docs, with plan-quality checks before writing.
- `plan-auditor`: review an already-authored PlanWeave plan for coverage, lifecycle gaps, contract drift, weak prompts, and unverifiable completion criteria.
- `plan-runner`: execute already-authored PlanWeave work items. For command syntax, use `planweave help` instead of copying CLI reference into the skill.

## Development

Run tests:

```bash
pnpm test
```

Build the workspace:

```bash
pnpm -r build
```

Run the desktop smoke test after building:

```bash
pnpm --filter @planweave/desktop smoke
```

## License

MIT. See [LICENSE](LICENSE).
