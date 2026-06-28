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
