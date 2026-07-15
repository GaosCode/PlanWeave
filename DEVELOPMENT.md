# Development

This document is for contributors working from source. The main README is user-facing and assumes the `planweave` CLI is installed.

## Repository Layout

```text
packages/runtime   Core graph, package, executor, auto-run, and desktop bridge logic
packages/cli       planweave command-line interface
packages/desktop   Electron desktop canvas
examples           Example PlanWeave packages
scripts            Repository checks
skills             Agent skills distributed from this repository
readme             README assets and localized README content
archive            Historical planning material, not current implementation authority
```

## Source Setup

Install dependencies and build all packages:

```bash
pnpm install
pnpm -r build
```

Run the CLI from the workspace without installing it globally:

```bash
pnpm --filter @planweave-ai/cli planweave --help
pnpm --filter @planweave-ai/cli planweave help
```

Run the desktop app from source:

```bash
git clone https://github.com/GaosCode/PlanWeave.git
cd PlanWeave
pnpm install
pnpm --dir packages/desktop build
pnpm --dir packages/desktop start
```

`pnpm -r build` builds every workspace package. Use it for full-repository verification. `pnpm --dir packages/desktop build` is the narrower command for preparing the Electron desktop app; it also builds the runtime and MCP packages that desktop needs.

## MCP Server From Source

Start the local HTTP MCP server from the workspace:

```bash
pnpm --filter @planweave-ai/mcp mcp
```

By default it listens on `http://127.0.0.1:8787/mcp`. For non-loopback hosts, configure `PLANWEAVE_MCP_TOKEN` or enable MCP OAuth with `PLANWEAVE_MCP_OAUTH_ENABLED=true`.

Useful environment variables:

```bash
PLANWEAVE_MCP_HOST=127.0.0.1
PLANWEAVE_MCP_PORT=8787
PLANWEAVE_MCP_TOKEN=<token>
PLANWEAVE_MCP_OAUTH_ENABLED=true
PLANWEAVE_HOME=/path/to/planweave/home
```

The installed CLI also exposes the same MCP server and tunnel workflow:

```bash
planweave mcp serve
planweave mcp tunnel download
planweave mcp tunnel configure --tunnel-id tunnel_xxx
planweave mcp tunnel status --json
planweave mcp tunnel doctor --json
planweave mcp tunnel print-systemd --planweave-home /srv/planweave --env-file /etc/planweave/mcp-tunnel.env
```

`planweave mcp tunnel run --serve` is the foreground command intended for the printed systemd unit. Runtime API keys should come from `OPENAI_RUNTIME_API_KEY` or `CONTROL_PLANE_API_KEY`, typically through an `EnvironmentFile`; they are not written to the MCP tunnel JSON config.

The desktop app's **Settings -> MCP Tunnel** page remains available for local ChatGPT tunnel traffic. Headless or VPS deployments should use the CLI systemd path instead of the desktop app.

MCP planning clients should start with `list_tool_groups`. The recommended default path uses bounded tools:

- graph reads: `get_graph_summary`, `list_tasks`, `get_graph_slice`
- graph diagnostics: `validate_graph_quality`, `validate_execution_readiness`
- content reads: `list_package_files`, `read_package_file`, `read_prompt_source`, `get_rendered_prompt`, `get_prompt_sources`
- package draft import: `validate_package_draft`, `preview_package_import`, `import_package_draft`

Default discovery hides compatibility aliases and heavy/debug tools. Legacy MCP clients that still discover or call aliases such as `get_project_graph`, `preview_execution_graph`, `get_block_detail`, `refresh_prompts`, `export_plan_package`, or `import_plan_package` should start the server with `PLANWEAVE_MCP_TOOL_DISCOVERY=compat`. New clients should keep the default discovery mode and prefer the bounded tool names; heavy/debug output is only behind explicit tools such as `get_block_detail_full_debug`, `refresh_prompts_full_debug`, and `export_plan_package_full`.

The equivalent CLI flow for package-shaped drafts is:

```bash
planweave package-draft validate --draft-root <draft> --json
planweave package-draft quality --draft-root <draft> --json
planweave package import --from <draft> --dry-run --json
planweave package import --from <draft> --apply --json
```

## Dependency override rationale

`pnpm-workspace.yaml` pins several transitive packages under `overrides`. These were introduced in `88972b61` (`fix(deps): resolve dependabot npm advisories`) to clear Dependabot/npm security advisories without waiting for every direct dependency to bump.

| Override | Version | Rationale |
|----------|---------|-----------|
| `@babel/core` | `7.29.6` | Security pin from Dependabot advisories (transitive). |
| `form-data` | `4.0.6` | Security pin from Dependabot advisories (transitive). |
| `hono` | `4.12.25` | Security pin from Dependabot advisories (transitive). |
| `js-yaml` | `4.2.0` | Security pin from Dependabot advisories (transitive). |
| `tar` | `7.5.16` | Security pin from Dependabot advisories (transitive). |
| `tmp` | `0.2.7` | Security pin from Dependabot advisories (transitive). |
| `undici@^6.25.0` | `6.27.0` | Security pin for the undici 6.x range (transitive). |
| `undici@^7.25.0` | `7.28.0` | Security pin for the undici 7.x range (transitive). |

CI runs `pnpm audit --audit-level=high` on every PR/push so these pins cannot silently go stale. Prefer removing an override once upstream direct dependencies absorb the fixed version. Review this table quarterly (or whenever audit fails) and mark any unclear pin as **verify** rather than inventing a reason.

## Verification

Run the full test suite:

```bash
pnpm test
```

Build the workspace:

```bash
pnpm -r build
```

Build only the desktop app and its required runtime/MCP dependencies:

```bash
pnpm --dir packages/desktop build
```

Run the desktop smoke test after building:

```bash
pnpm --filter @planweave-ai/desktop smoke
```

## ACP Verification

Run the deterministic ACP contract, CLI, and Desktop tests:

```bash
pnpm exec vitest run \
  packages/runtime/src/__tests__/runnerContracts.test.ts \
  packages/runtime/src/__tests__/acpRunnerLifecycle.test.ts \
  packages/runtime/src/__tests__/acpEventController.test.ts \
  packages/cli/src/__tests__/acpCliE2E.test.ts \
  packages/cli/src/__tests__/acpLiveSmoke.test.ts \
  packages/desktop/src/__tests__/acpDesktopMockE2E.test.tsx
```

For live verification, use an isolated PlanWeave workspace with one block that submits an artifact and a second block that remains active beyond the cancellation timeout. Run the smoke command for each profile being verified:

```bash
node scripts/acp-live-smoke.mjs --profile codex-acp --evidence /tmp/codex-acp.json
node scripts/acp-live-smoke.mjs --profile claude-code-acp --evidence /tmp/claude-code-acp.json
node scripts/acp-live-smoke.mjs --profile opencode-acp --evidence /tmp/opencode-acp.json
node scripts/acp-live-smoke.mjs --profile pi-acp --evidence /tmp/pi-acp.json
```

The command checks profile preflight, a successful artifact submission, ordered runner events, bounded cancellation, cleanup, canonical session identity, and stable replay. Use `--cancellation-timeout <ms>` when the selected agent needs a longer interval to enter the running state. Evidence files are written with mode `0600`.

## Local Packaging

The npm pack/publish scripts include runtime, MCP, and CLI packages so the CLI's `@planweave-ai/mcp` dependency is available when published.

Build an unsigned macOS DMG and ZIP:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir packages/desktop dist:mac
```

Build Windows and Linux desktop artifacts with electron-builder:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir packages/desktop exec electron-builder --win nsis --x64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir packages/desktop exec electron-builder --win nsis --arm64 --publish never
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir packages/desktop exec electron-builder --linux AppImage --x64 --publish never
```

The generated desktop installers are ignored by git under `packages/desktop/release/`.
