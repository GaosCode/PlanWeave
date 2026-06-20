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
pnpm -r build
pnpm --dir packages/desktop start
```

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

The desktop app's **Settings -> MCP Tunnel** page manages the local MCP server for ChatGPT tunnel traffic, so end users should prefer the desktop flow. This source-level command is mainly for contributor testing and direct MCP client integration.

## Verification

Run the full test suite:

```bash
pnpm test
```

Build the workspace:

```bash
pnpm -r build
```

Run the desktop smoke test after building:

```bash
pnpm --filter @planweave-ai/desktop smoke
```

## Local Packaging

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
