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
archive            Archived planning material
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

## Verification

Run the full test suite:

```bash
pnpm test
```

The CI test suite is split into pure unit tests, Ubuntu-only integration tests, and
platform-dependent tests that run on both Ubuntu and Windows:

```bash
pnpm test:unit
pnpm test:integration
pnpm test:platform
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

Run the ACP contract, CLI, and Desktop tests:

```bash
pnpm exec vitest run \
  packages/runtime/src/__tests__/runnerContracts.test.ts \
  packages/runtime/src/__tests__/acpGrokLiveSmoke.test.ts \
  packages/runtime/src/__tests__/acpRunnerLifecycle.test.ts \
  packages/runtime/src/__tests__/acpEventController.test.ts \
  packages/cli/src/__tests__/acpCliE2E.test.ts \
  packages/cli/src/__tests__/acpLiveSmoke.test.ts \
  packages/desktop/src/__tests__/acpDesktopMockE2E.test.tsx
```

For live verification, run the smoke command for each configured profile:

```bash
node scripts/acp-live-smoke.mjs --profile codex-acp --evidence /tmp/codex-acp.json
node scripts/acp-live-smoke.mjs --profile claude-code-acp --evidence /tmp/claude-code-acp.json
node scripts/acp-live-smoke.mjs --profile opencode-acp --evidence /tmp/opencode-acp.json
node scripts/acp-live-smoke.mjs --profile pi-acp --evidence /tmp/pi-acp.json
```

Use `--cancellation-timeout <ms>` when an agent needs longer to enter the running state.

Grok has a separate opt-in live smoke. Run it after installing Grok CLI and completing its login:

```bash
PLANWEAVE_LIVE_GROK_ACP=1 pnpm exec vitest run packages/runtime/src/__tests__/acpGrokLiveSmoke.test.ts
```

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
