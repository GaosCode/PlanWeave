<h1 align="center">PlanWeave</h1>

<p align="center">
  PlanWeave is a file-backed coordination system for turning project plans into claimable, reviewable, and recoverable work across local or remote coding agents.
</p>

<p align="center">
  <img src="readme/assets/planweave-readme-animation.svg" width="860" alt="PlanWeave brand motion." />
</p>

<p align="center">
  <a href="readme/README.zh-CN.md">中文 README</a>
</p>

<!-- planweave-badges:start -->
<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.1.4-orange?style=for-the-badge" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge" />
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178c6?style=for-the-badge" />
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js-43853d?style=for-the-badge" />
  <img alt="desktop" src="https://img.shields.io/badge/desktop-Electron-47848f?style=for-the-badge" />
  <img alt="agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code%20%7C%20OpenCode%20%7C%20Pi-6f42c1?style=for-the-badge" />
</p>
<!-- planweave-badges:end -->



## Why PlanWeave

Most agent tools start from a chat transcript. PlanWeave starts from the work itself.

Your project is represented as a graph of task nodes and block documents. Each file has a stable place in the workflow, and each agent run receives the surrounding graph context instead of a narrow one-off prompt. That makes PlanWeave a better fit for long-running engineering work: implementation, review, feedback, follow-up fixes, and progress tracking all live in the same local project structure.

## Highlights

- **Files are nodes, documents are blocks**: the graph is not a decoration on top of chat. It is the project model.
- **Graph-friendly by default**: task flow, dependencies, review loops, and execution status are visible and editable.
- **Global context for agents**: agents can see the wider task graph, not only the current prompt fragment.
- **Per-node and per-block agent routing**: use Codex for one block, Claude Code, OpenCode, or Pi for another, and local review scripts where deterministic checks are enough.
- **MCP authoring for ChatGPT**: connect ChatGPT to PlanWeave through the local MCP server or desktop secure tunnel, then ask it to create canvases, tasks, blocks, review pipelines, and dependencies.
- **Full auto-run workflow**: PlanWeave can claim blocks, run agents, collect reports, handle review feedback, and continue the task flow.
- **Review and feedback as first-class work**: review blocks can produce structured feedback that returns to implementation blocks.
- **Desktop and CLI support**: use the visual Electron canvas or drive the same runtime from the terminal.
- **Live observability**: block runs keep logs, reports, metadata, and tmux attach commands for monitoring.
- **Statistics, search, and todo views**: inspect development efficiency and project state without leaving the workflow.
- **Local-first and file-backed**: plans, prompts, run records, and artifacts remain inspectable in your workspace.

## Quick Start

PlanWeave is currently CLI-first. The desktop app is available for testing, but it is experimental and unsigned.

Install the CLI with npm:

```bash
npm install -g @planweave-ai/cli
```

Or install it with Homebrew:

```bash
brew install GaosCode/tap/planweave
```

Then run:

```bash
planweave --help
```

## MCP and ChatGPT Web Planning

PlanWeave includes a local HTTP MCP server for using PlanWeave from MCP clients such as ChatGPT. The MCP tools are not just read-only status helpers: they can also author plans by initializing projects, creating canvases, adding tasks and blocks, wiring dependencies, editing prompts, configuring review pipelines, and validating the local project.

For ChatGPT in the browser, use PlanWeave Desktop's MCP settings. You can use ChatGPT Pro as the planning partner: describe the project goal, ask it to draft the task graph, then let PlanWeave save the result as a canvas.

1. Open **Settings -> MCP Tunnel** in the desktop app.
2. Download or select the OpenAI `tunnel-client`.
3. Enter your Tunnel ID and Runtime API key, then start the secure tunnel.
4. Add PlanWeave in ChatGPT using the Tunnel connection mode.

Once connected, ChatGPT can ask PlanWeave for authoring rules and schema, generate a plan from your project goal, write it into a new task canvas, preview the execution graph, and validate the package before you run it.

Source-level MCP server setup is documented in [Development](DEVELOPMENT.md).

## Agent Execution

PlanWeave supports executor profiles, so different blocks can run through different agents or local commands. A typical graph can mix:

- Codex execution for implementation work.
- Claude Code execution for non-interactive terminal agent runs.
- OpenCode execution for blocks that should run in an OpenCode session.
- Pi execution for non-interactive terminal agent runs.
- Local review commands for deterministic validation.
- Review-feedback loops that continue automatically when feedback is enabled.

Each block run writes durable output under the PlanWeave workspace, including prompt, stdout, stderr, report, metadata, and monitor commands when available.

## Agent Skills

The repository includes focused agent skills under `skills/`:

- `plan-maker`: design a PlanWeave plan draft from a fuzzy goal or sparse codebase context before a formal package exists.
- `plan-importer`: create a PlanWeave Plan Package from project docs, with plan-quality checks before writing.
- `plan-auditor`: review an already-authored PlanWeave plan for coverage, lifecycle gaps, contract drift, weak prompts, and unverifiable completion criteria.
- `plan-coordinator`: keep a full PlanWeave execution loop moving as the main agent, dispatching implementation, review, and recovery work.
- `plan-runner`: execute one implementation block and produce a completion report.
- `plan-reviewer`: execute one review gate and produce a structured `passed` or `needs_changes` result.
- `plan-recovery`: diagnose and recover stale current refs, state/results drift, blocked/diverged work, and submit retry confusion.

Install them with the `skills` CLI:

```bash
npx skills@latest add GaosCode/PlanWeave
```

## Agent Workflow

After installing the skills, use this flow in your target project:

1. Ask your agent to create or import a plan.

```text
Use skill: plan-maker
Create a PlanWeave plan for this project from the goal below...
```

If you already have PRDs, roadmaps, issues, or architecture notes, use `plan-importer` instead.

2. Ask the coordinator to run the plan.

```text
Use skill: plan-coordinator
Run the current PlanWeave package. Route implementation to plan-runner, review gates to plan-reviewer, and recovery work to plan-recovery.
```

3. Let the coordinator dispatch focused agents.

The coordinator should assign one concrete block at a time. Implementation agents use `plan-runner`; review agents use `plan-reviewer`; abnormal state or submit retry problems use `plan-recovery`.

4. Use the CLI for inspection when needed.

```bash
planweave status
planweave current
planweave explain <ref>
planweave doctor
```

For simple tasks, one agent can use `plan-runner` directly. For larger plans, use `plan-coordinator` as the main agent and route subagent work to `plan-runner`, `plan-reviewer`, or `plan-recovery`.

## Auto Run

PlanWeave includes an experimental one-command execution path:

```bash
planweave run --once
planweave run-status
```

Auto Run can claim work, call an executor, collect run artifacts, and continue review-feedback loops. It is still experimental: scheduling, executor integration, and recovery behavior may be unstable. Inspect `planweave run-status` and generated run artifacts before relying on it for unattended work.

## Manual CLI Workflow

Most users should drive PlanWeave through skills. The manual CLI loop is useful for debugging, demos, or writing your own agent integration:

```bash
planweave init --json
planweave validate --json
planweave current
planweave claim-next --dry-run
planweave prompt T-001#B-001
planweave submit-result T-001#B-001 --report report.md
```

Review gates and feedback loops can be handled manually too:

```bash
planweave submit-review T-001#R-001 --result review-result.json
planweave submit-feedback --report feedback-report.md
```

PlanWeave resolves the target project root from the shell's current directory. Package managers may set `INIT_CWD`, which PlanWeave uses before `cwd`. When running from another directory, pass the global option before the subcommand:

```bash
planweave --project-root /path/to/project status --json
planweave --project-root /path/to/project claim-next --canvas desktop
```

When scheduling is unclear, prefer `planweave explain <ref>`, `planweave why-not <ref>`, and `planweave doctor` before editing package or state files.

## Experimental Desktop App

The desktop app is an experimental build. It is useful for trying the visual task canvas, configuring MCP tunnel access for ChatGPT, and reviewing generated plans before execution, but the CLI remains the recommended interface for serious work.

Install a packaged build from GitHub Releases. Current desktop installers are unsigned. macOS may show an unidentified developer warning, and Windows may show an unknown publisher or SmartScreen warning. For early testing on macOS, open the app with **Right Click -> Open** and confirm the prompt.

For repository layout, source setup, tests, and packaging commands, see [Development](DEVELOPMENT.md).

## Future Direction

PlanWeave is still early, and several directions can make plan-based agent work smoother:

- **Better Auto Run UX and reliability**: make automatic execution easier to understand, monitor, pause, resume, recover, and trust, while improving scheduling correctness, failure recovery, and long-running stability.
- **Collaborative planning board**: let multiple people edit the same task board, refine plan structure together, and turn shared planning decisions into executable blocks.
- **Cross-host coordination**: PlanWeave already supports routing different blocks to different local agents or executor profiles. A future coordinator could let remote Agent Hosts register capabilities, claim plan blocks through leases, report heartbeats, and submit artifacts safely, making it possible to run specialized frontend, review, runtime, docs, or other agents on different machines.

## Development

Contributor setup, repository layout, test commands, and local packaging notes live in [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
