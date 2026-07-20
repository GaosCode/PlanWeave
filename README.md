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
  <img alt="version" src="https://img.shields.io/badge/version-0.3.0-orange?style=for-the-badge" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge" />
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178c6?style=for-the-badge" />
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js-43853d?style=for-the-badge" />
  <img alt="desktop" src="https://img.shields.io/badge/desktop-Electron-47848f?style=for-the-badge" />
  <img alt="agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code%20%7C%20OpenCode%20%7C%20Pi%20%7C%20Grok-6f42c1?style=for-the-badge" />
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
- **Per-node and per-block agent routing**: use Codex for one block, Claude Code, OpenCode, Pi, or Grok for another, and use local review scripts where deterministic checks are enough.
- **MCP authoring for ChatGPT**: connect ChatGPT to PlanWeave through the local MCP server, a headless systemd tunnel, or the desktop secure tunnel, then ask it to create canvases, tasks, blocks, review pipelines, and dependencies.
- **Full auto-run workflow**: PlanWeave can claim blocks, run agents, collect reports, handle review feedback, and continue the task flow.
- **Review and feedback as first-class work**: review blocks can produce structured feedback that returns to implementation blocks.
- **Desktop and CLI support**: use the visual Electron canvas or drive the same runtime from the terminal.
- **Live observability**: block runs keep ordered events, logs, reports, metadata, and available monitor actions.
- **Statistics, search, and todo views**: inspect development efficiency and project state without leaving the workflow.
- **Local-first and file-backed**: plans, prompts, run records, and artifacts remain inspectable in your workspace.

## Quick Start

Use PlanWeave Desktop for visual planning and execution, or install the CLI for terminal workflows.

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

PlanWeave includes a local HTTP MCP server for MCP clients such as ChatGPT. Its tools inspect and author plans by initializing projects, creating canvases, adding tasks and blocks, wiring dependencies, editing prompts, configuring review pipelines, validating graph quality, and importing package drafts.

For ChatGPT in the browser, use the CLI MCP tunnel on a VPS or PlanWeave Desktop's MCP settings on a local machine. You can use ChatGPT Web as the planning partner: describe the project goal, ask it to write a package-shaped draft in a temporary draft root, dry-run validate and quality-check it, preview the import, then apply it transactionally.

Recommended headless setup for a VPS uses systemd. The MCP server stays on loopback, the OpenAI `tunnel-client` keeps an outbound connection open, and systemd manages the service lifecycle.

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

Source-level MCP server setup is documented in [Development](DEVELOPMENT.md).

## Agent Execution

PlanWeave supports executor profiles, so different blocks can run through Codex, Claude Code, OpenCode, Pi, Grok, or local review commands. The runtime carries accepted results through review-feedback loops.

Each block run writes durable output under the PlanWeave workspace, including prompt, stdout, stderr, report, metadata, and monitor commands when available.

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

If you already have PRDs, roadmaps, issues, or architecture notes, use `plan-importer` instead. To materialize a plan, `plan-maker` writes a package-shaped draft and runs:

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

Auto Run claims ready work, invokes the selected executor, submits artifacts, continues review-feedback loops, and records each run as a session.

```bash
planweave run --once --json
planweave run --parallel --step-limit 20 --timeout 120000 --json
planweave run --scope task --task T-001 --once --json
planweave run --scope block --block T-001#B-001 --once --json
```

The executor is resolved from the block, task, and package defaults. Use `--executor <profile>` for an explicit run override and `--canvas <canvas-id>` to select a canvas.

PlanWeave Desktop provides scoped run controls, live progress, and session history. CLI users can inspect the same runtime state with:

```bash
planweave run-status --follow --json
planweave run-sessions --json
planweave run-session <session-id> --json
```

### ACP runners

Codex, Claude Code, OpenCode, Pi, and Grok provide explicit ACP profiles. Their canonical names follow the configured Agent transport, while the `*-acp` names explicitly select ACP:

```text
codex-acp
claude-code-acp
opencode-acp
pi-acp
grok-acp
```

When CLI transport is selected, the canonical Grok profile is `grok`. It runs `grok --no-auto-update --prompt-file <run-prompt-path>`. The path points to the same durable prompt artifact recorded for the run, so prompt content is not copied into process arguments.

Install the command used by the selected profile and complete its agent-owned login and provider setup before running preflight:

| Profile | Built-in ACP launch | Prerequisite |
| --- | --- | --- |
| `codex-acp` | `codex-acp` | Install and authenticate the separate Codex ACP agent. |
| `claude-code-acp` | `claude-agent-acp` | Install and authenticate the separate Claude Code ACP agent. |
| `opencode-acp` | `opencode acp` | Install OpenCode and configure its provider. |
| `pi-acp` | `pi-acp` | Install `pi-acp` and `pi`, then configure the agent. |
| `grok-acp` | `grok --no-auto-update agent stdio` | Install Grok CLI and complete Grok-owned login or provider configuration. |

Then verify and run the profile:

```bash
planweave executors test codex-acp --json
planweave run --once --executor codex-acp --timeout 120000 --json
```

ACP authentication is negotiated on every new transport. PlanWeave initializes the agent, considers only the `authMethods` returned by that initialize response, and chooses deterministically from methods that are safe without interaction: an `env_var` method only when all required variable names are present, or an agent-owned method only when its built-in definition marks that method ID as headless-safe. If the agent returns no `authMethods`, PlanWeave preserves compatibility by skipping protocol authentication and proceeding to session creation. A missing `agentInfo` is also valid and is shown as not provided; an `agentInfo` object with invalid name or version fields fails preflight.

Terminal login, browser login, and other interactive methods are never started automatically. When credentials are missing or no safe method is advertised, CLI and Desktop preflight return an action-required state with the advertised method IDs/types and the next step. Configure the named environment variables (and restart PlanWeave if they were added after launch) or finish login in the agent outside PlanWeave, then rerun preflight. For Grok's ACP transport, the built-in preference hints cover `xai.api_key` and `cached_token`, but the current agent's advertised methods remain authoritative; this documentation does not claim that every Grok account or authentication path has passed live verification. Grok CLI authentication remains Grok-owned and must also be completed before headless execution.

PlanWeave passes the existing process environment to the selected agent but does not collect or persist secret values in authentication state, run metadata, IPC, or renderer state. Diagnostics may retain the selected method ID and missing environment variable names. Grok's CLI and ACP runners are independent transports and never fall back to each other.

ACP runs provide structured messages, tool updates, artifacts, usage snapshots, and interaction requests. PlanWeave Desktop exposes the follow-up, cancellation, permission, elicitation, and retry actions available for the selected run. Run records keep normalized events and protocol diagnostics for inspection and replay.

Custom package profiles require exact trust for their resolved command and arguments:

```bash
planweave trust executor <profile>
```

For authentication or provider errors, follow the preflight next step and rerun `executors test`. Contributor verification commands, including the opt-in Grok live smoke, are documented in [Development](DEVELOPMENT.md#acp-verification).

## Desktop App

PlanWeave Desktop provides a visual task canvas, task workspaces, Auto Run controls, run history, search and statistics views, and MCP tunnel settings for ChatGPT.

<p align="center">
  <img src="readme/assets/planweave-desktop-canvas.png" width="860" alt="PlanWeave desktop canvas showing an agent task graph with implementation and review blocks." />
</p>

Install a packaged build from [GitHub Releases](https://github.com/GaosCode/PlanWeave/releases). Current desktop installers are unsigned, so macOS or Windows may show a security warning. If macOS blocks the app, confirm it came from this repository and run:

```bash
xattr -dr com.apple.quarantine "/Applications/PlanWeave.app"
```

For repository layout, source setup, tests, and packaging commands, see [Development](DEVELOPMENT.md).

## Future Direction

PlanWeave will continue to expand in three directions:

- **Auto Run**: improve execution control, recovery, and long-running reliability.
- **Collaborative planning**: let teams edit and refine the same task board together.
- **Cross-host execution**: coordinate specialized agents across different machines.

## Development

Contributor setup, repository layout, test commands, and local packaging notes live in [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
