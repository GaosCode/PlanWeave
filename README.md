<h1 align="center">PlanWeave</h1>

<p align="center">
  PlanWeave is a file-backed loop engineering system for long-running coding agents. It turns fuzzy plans into claimable tasks, routes them through implementation and review agents, records every run, and keeps the loop recoverable.
</p>

<p align="center">
  <img src="readme/assets/planweave-readme-animation.svg" width="860" alt="PlanWeave brand motion." />
</p>

<p align="center">
  <a href="readme/README.zh-CN.md">中文 README</a>
</p>

<!-- planweave-badges:start -->
<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.1-orange?style=for-the-badge" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge" />
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178c6?style=for-the-badge" />
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js-43853d?style=for-the-badge" />
  <img alt="desktop" src="https://img.shields.io/badge/desktop-Electron-47848f?style=for-the-badge" />
  <img alt="agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code%20%7C%20OpenCode%20%7C%20Pi-6f42c1?style=for-the-badge" />
</p>
<!-- planweave-badges:end -->



## Why PlanWeave

Chat is a useful place to start a plan, but it is a fragile place to run a long engineering loop.

PlanWeave turns a fuzzy goal or chat-authored plan into a task graph of nodes and block documents. Each block can be claimed by a focused agent, routed through implementation and review, and recorded as durable run artifacts. Agents get the current block plus relevant graph context, while the project keeps a recoverable history of what ran, what passed review, and what needs another loop.

That makes PlanWeave a better fit for complex engineering work: parallel implementation, staged checks, review feedback, follow-up fixes, continued execution, and progress tracking all stay inside the same local loop.

## Highlights

- **Files are nodes, documents are blocks**: the graph is not a decoration on top of chat. It is the project model.
- **Graph-friendly by default**: task flow, dependencies, review loops, and execution status are visible and editable.
- **Zero-config start**: install the CLI and agent skills, then use a few commands and skill prompts to create, run, and inspect a plan in an existing project.
- **Scoped graph context**: agents receive the current block plus relevant task graph context, and can inspect more when needed.
- **Focused responsibilities**: each claim hands one focused block to one agent, keeping context clean and avoiding unrelated plans, stale discussion, and wasted tokens.
- **Per-node and per-block agent routing**: use Codex for one block, Claude Code, OpenCode, or Pi for another, and local review scripts where deterministic checks are enough.
- **MCP authoring for ChatGPT**: connect ChatGPT to PlanWeave through the local MCP server, a headless systemd tunnel, or the desktop secure tunnel, then ask it to create canvases, tasks, blocks, review pipelines, and dependencies.
- **Full auto-run workflow**: PlanWeave can claim blocks, run agents, collect reports, handle review feedback, and continue the task flow.
- **Review and feedback as first-class work**: review blocks can produce structured feedback that returns to implementation blocks.
- **Desktop and CLI support**: use the visual Electron canvas or drive the same runtime from the terminal.
- **Live observability**: block runs keep logs, reports, metadata, and tmux attach commands for monitoring.
- **Statistics, search, and todo views**: inspect development efficiency and project state without leaving the workflow.
- **Local-first and file-backed**: plans, prompts, run records, and artifacts remain inspectable in your workspace.

For the default canvas, inspectable files live under `canvases/default/package`, `canvases/default/state.json`, and `canvases/default/results` inside the PlanWeave workspace. Use `planweave paths --json` for the exact local paths.

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

Install the agent skills as well:

```bash
npx skills@latest add GaosCode/PlanWeave
```

## MCP and ChatGPT Web Planning

PlanWeave includes a local HTTP MCP server for using PlanWeave from MCP clients such as ChatGPT. The MCP tools are not just read-only status helpers: they can also author plans by initializing projects, creating canvases, adding tasks and blocks, wiring dependencies, editing prompts, configuring review pipelines, validating graph quality, and importing package drafts.

For ChatGPT in the browser, use the CLI MCP tunnel on a VPS or PlanWeave Desktop's MCP settings on a local machine. You can use ChatGPT Web as the planning partner: describe the project goal, ask it to write a package-shaped draft in a temporary draft root, dry-run validate and quality-check it, preview the import, then apply it transactionally.

Recommended headless setup for a VPS uses systemd. The MCP server stays on loopback, and the OpenAI `tunnel-client` keeps an outbound connection open; PlanWeave does not run its own daemon or pidfile manager.

```bash
sudo mkdir -p /etc/planweave /srv/planweave
sudo chmod 700 /etc/planweave

planweave mcp tunnel download
planweave mcp tunnel configure --tunnel-id tunnel_xxx
planweave mcp tunnel print-systemd \
  --planweave-home /srv/planweave \
  --env-file /etc/planweave/mcp-tunnel.env
```

Put the Runtime API key in the systemd environment file, not in PlanWeave's JSON config:

```bash
PLANWEAVE_HOME=/srv/planweave
OPENAI_RUNTIME_API_KEY=...
```

Keep that file readable only by the service owner:

```bash
sudo chmod 600 /etc/planweave/mcp-tunnel.env
```

Install the printed service as `planweave-mcp-tunnel.service`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now planweave-mcp-tunnel
journalctl -u planweave-mcp-tunnel -f
```

For local desktop setup:

1. Open **Settings -> MCP Tunnel** in the desktop app.
2. Download or select the OpenAI [`tunnel-client`](https://github.com/openai/tunnel-client).
3. Enter your Tunnel ID and Runtime API key, then start the secure tunnel.
4. Add PlanWeave in ChatGPT using the Tunnel connection mode.

Once connected, ChatGPT can ask PlanWeave for authoring rules and schema, discover recommended tool groups with `list_tool_groups`, inspect bounded graph views with `get_graph_summary` / `get_graph_slice`, validate graph quality with `validate_graph_quality`, and read large content through path/ref tools instead of broad dumps. For large plans, the recommended MCP flow is `validate_package_draft`, `preview_package_import`, then `import_package_draft` with `apply: true`.

The default MCP discovery list hides legacy aliases and heavy/debug tools. Old MCP clients that still need aliases such as `get_project_graph`, `get_block_detail`, `refresh_prompts`, `export_plan_package`, or `import_plan_package` should start the server with `PLANWEAVE_MCP_TOOL_DISCOVERY=compat`. New clients should keep the default discovery mode and call bounded tools; heavy/debug paths such as `get_block_detail_full_debug`, `refresh_prompts_full_debug`, and `export_plan_package_full` are explicit opt-ins.

Source-level MCP server setup is documented in [Development](DEVELOPMENT.md).

## Agent Execution

PlanWeave supports executor profiles, so different blocks can run through different agents or local commands. Current executors include Codex, Claude Code, OpenCode, Pi, local review commands, and review-feedback loops.

Each block run writes durable output under the PlanWeave workspace, including prompt, stdout, stderr, report, metadata, and monitor commands when available.

ACP runner setup, safety boundaries, troubleshooting, and release-time live evidence are documented in [ACP runners](readme/ACP.md).

## Agent Skills

The repository includes focused agent skills under `skills/`:

- `plan-maker`: design a PlanWeave package-shaped draft from a fuzzy goal or sparse codebase context, then materialize it through draft validation/import when requested.
- `plan-importer`: create a PlanWeave package draft from strong source docs, then validate, preview, and import it through the draft import flow.
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

If you already have PRDs, roadmaps, issues, or architecture notes, use `plan-importer` instead. `plan-maker` no longer hands a Markdown-only report to `plan-importer`; when materializing, it should write a package-shaped draft and run:

```bash
planweave package-draft validate --draft-root <draft> --json
planweave package-draft quality --draft-root <draft> --json
planweave package import --from <draft> --dry-run --json
planweave package import --from <draft> --apply --json
```

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
planweave graph inspect --view summary --json
planweave graph quality --json
planweave doctor
```

For simple tasks, one agent can use `plan-runner` directly. For larger plans, use `plan-coordinator` as the main agent and route subagent work to `plan-runner`, `plan-reviewer`, or `plan-recovery`.

## Auto Run

PlanWeave includes an experimental one-command execution path:

```bash
planweave run --once
planweave run --reset --force --reason "rerun acceptance" --step-limit 20
planweave reset --force --reason "clear stale manual work"
planweave run-sessions
planweave run-session SESSION-0001
planweave run-status
```

Auto Run can claim work, call an executor, collect run artifacts, continue review-feedback loops, and record each run/reset as a session. `planweave reset` clears runtime state only; it is separate from `planweave init --reset-package`, which rewrites package source files during initialization.

For cron-style runs, keep execution bounded and inspect the session log afterward. This example can be used directly in crontab:

```bash
0 9 * * * cd /path/to/project && planweave run --reset --canvas default --force --reason "scheduled run" --step-limit 10 --json >> ~/.planweave-cron.log 2>&1
```

After a run, inspect the session log:

```bash
planweave run-sessions --json
```

Auto Run is still experimental: scheduling, executor integration, and recovery behavior may be unstable. Inspect `planweave run-status`, `planweave run-session <session-id>`, and generated run artifacts before relying on it for unattended work.

## Manual CLI Workflow

Most users should drive PlanWeave through skills. The manual CLI loop is useful for debugging, demos, or writing your own agent integration:

```bash
planweave init --json
planweave validate --json
planweave current
planweave claim-next --dry-run
planweave prompt T-001#B-001
planweave submit-result --canvas default T-001#B-001 --report report.md
```

Review gates and feedback loops can be handled manually too:

```bash
planweave submit-review --canvas default T-001#R-001 --result review-result.json
planweave submit-feedback --canvas default --report feedback-report.md
```

PlanWeave resolves the target project root from the shell's current directory. Package managers may set `INIT_CWD`, which PlanWeave uses before `cwd`. When running from another directory, pass the global option before the subcommand:

```bash
planweave --project-root /path/to/project status --json
planweave --project-root /path/to/project claim-next --canvas desktop
```

When scheduling is unclear, prefer `planweave explain <ref>`, `planweave why-not <ref>`, and `planweave doctor` before editing package or state files.

## Experimental Desktop App

The desktop app is an experimental build. It is useful for trying the visual task canvas, configuring MCP tunnel access for ChatGPT, and reviewing generated plans before execution, but the CLI remains the recommended interface for serious work.

<p align="center">
  <img src="readme/assets/planweave-desktop-canvas.png" width="860" alt="PlanWeave desktop canvas showing an agent task graph with implementation and review blocks." />
</p>

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
