# Development

Contributor setup, repository layout, verification, distributed packages, and local packaging.

## Repository Layout

```text
packages/runtime                   Core graph, package, executor, auto-run, and desktop bridge logic
packages/cli                       planweave command-line interface
packages/mcp                       Local HTTP MCP server for plan authoring clients
packages/desktop                   Electron desktop canvas (private package; not npm-published)
packages/server                    Coordinator: operator HTTP, Host WSS, human collab, remote ops
packages/agent-host                Agent Host daemon: enroll, preflight, ACP-only remote runs
packages/agent-host-protocol      Schema-only Agent Host wire / compatibility contracts
packages/collaboration-protocol   Schema-only human collaboration wire DTOs for Desktop/Server
examples                           Example PlanWeave packages
scripts                            Repository checks, pack smoke, release-gate helpers
skills                             Agent skills distributed from this repository
readme                             Localized docs and static assets
archive                            Archived planning material (not implementation authority)
```

## Distributed architecture contracts

Module and security boundaries:

| Boundary | Authority | Non-authority |
| --- | --- | --- |
| Plan Package / Block content | Runtime package + project root on Coordinator | Host local git state; assignment blobs |
| Local claim / Auto Run | Runtime taskManager + autoRun | Server assignment; Host mailbox |
| Remote dispatch / ACP run | Server remote operation + Host ACP profile | Remote CLI executor fallback; silent rerun |
| Host transport | WSS `/agent-hosts/:hostId/connect` + Host credential | Human device tokens; operator bearer on Host connect |
| Human membership / devices | Server identity HTTP (`/api/v1/projects/:id/human/*`) | Host enrollment codes; operator routes |
| Assignment metadata | Server `work_assignments` CAS revision | Claim state; auto-start of remote runs |
| Human comments / attachments | Server comments + attachment HTTP (separate blob root) | ACP streams; Host mailbox; Runtime submit |
| Desktop collab UI | Renderer hooks → preload → main vault/client → contracts package | DOM as business state; renderer-held secrets |
| Compatibility | Matching package majors + `agentHostProtocolVersion` | Cross-major silent downgrade; ACP→CLI fallback |

All published packages require **Node.js >= 22.13**. This is the first Node.js 22 release where the built-in `node:sqlite` module used by Runtime, Server, and Agent Host is available without a runtime flag. Production transport is HTTPS/WSS; loopback plain HTTP/WS requires explicit `allowInsecureDevelopment`.

Provider API keys, Agent login state, Git credentials, and Host workspace/profile mappings remain on the Host machine. PlanWeave coordinates Blocks; it does not own Git branches, worktrees, or merge.

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

The desktop app's **Settings → MCP Tunnel** page remains available for local ChatGPT tunnel traffic. Headless or VPS deployments should use the CLI systemd path instead of the desktop app.

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

Run one or more exact test files, using their existing suite configuration and worker limit:

```bash
pnpm test:file packages/agent-host/src/__tests__/credentialRenewal.test.ts
pnpm test:file packages/agent-host/src/__tests__/credentialRenewal.test.ts packages/cli/src/__tests__/commandsSchemaHelp.test.ts
```

Files from different suites run sequentially. Duplicate paths run once. This command accepts file paths only, not directories, globs, name filters, or Vitest flags; empty or unclassified paths fail. Quote paths containing spaces. Use `pnpm test` for the full suite.

The CI test suite is split into unit, integration, performance, and platform-dependent tests:

```bash
pnpm test:unit
pnpm test:integration
pnpm test:performance
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

## Distributed packages from source

Packages: `@planweave-ai/server` → `planweave-server`, `@planweave-ai/agent-host` → `planweave-agent-host` (Node.js 22.13+). Desktop stays `private: true` and is not part of `publish:npm`.

Build order for the distributed graph (also used by `pnpm pack:distributed`):

```bash
pnpm --filter @planweave-ai/agent-host-protocol build
pnpm --filter @planweave-ai/collaboration-protocol build
pnpm --filter @planweave-ai/runtime build
pnpm --filter @planweave-ai/server build
pnpm --filter @planweave-ai/agent-host build
```

Run Coordinator / Host from the workspace after build (absolute config paths only; Server also accepts `PLANWEAVE_SERVER_CONFIG`):

```bash
node packages/server/dist/bin.js --help
node packages/agent-host/dist/bin.js --help

node packages/server/dist/bin.js serve --config /absolute/path/server.json
node packages/agent-host/dist/bin.js preflight --config /absolute/path/agent-host.json
node packages/agent-host/dist/bin.js enroll --config /absolute/path/agent-host.json --code pw_enroll_...
node packages/agent-host/dist/bin.js run --config /absolute/path/agent-host.json
node packages/agent-host/dist/bin.js revoke --config /absolute/path/agent-host.json
```

Package installations expose `planweave-server` and `planweave-agent-host` on `PATH`. The PlanWeave CLI also exposes Host commands through `planweave agent-host`.

Config shape (details and schema live in each package; use `--help` and package tests as contract sources):

| Side | You configure | Notes |
| --- | --- | --- |
| Coordinator | TLS (or loopback dev), `dataDirectory`, trusted project roots, operator token **digests** | Config stores `tokenSha256`, never the raw operator token |
| Agent Host | Coordinator URL, `dataDirectory`, workspace folders, ACP profile command paths | Provider API keys and agent login stay on the Host environment |

Operational defaults:

- Production transport is **HTTPS** and **WSS**. Plain HTTP/WS is loopback development only (`allowInsecureDevelopment`).
- Create one-time Host enrollment details as a Server administrator, choose the credential lifetime, enroll the Host, then `run`. Lifecycle-aware credentials renew automatically; administrators can also request renewal from Desktop. Revoke on the Server and/or run `planweave agent-host revoke` when a Host should no longer be trusted.
- Unauthenticated health endpoints: `/healthz`, `/readyz`, `/version`.
- **Assignment** is coordination metadata only; **dispatch** / remote run is an explicit action.
- Interrupted remote work needs an explicit lifecycle action (`cancel`, `resume_same_session`, `retry_new_attempt`, `fail`, `block`) — never silent re-run.
- Human comments/activity are not Host mailbox traffic or Runtime claim/submit.

Pack and clean-install smoke (no publish):

```bash
pnpm pack:distributed
pnpm check:distributed-package-install
```

## Distributed release gate

Print the live release checklist (deterministic CI suite, local real ACP, remote VPS) and evaluate sanitized evidence:

```bash
node scripts/planweave-release-gate.mjs --checklist
pnpm exec vitest run packages/server/src/__tests__/releaseGate.test.ts \
  packages/agent-host-protocol/src/__tests__/compatibility.test.ts
```

Do not treat skipped `PLANWEAVE_REAL_ACP` or `PLANWEAVE_VPS_E2E` evidence as a release pass. Run both live tiers in hard mode, then evaluate their current sanitized evidence with:

```bash
# After collecting evidence files (paths are examples):
node scripts/planweave-release-gate.mjs \
  --deterministic-evidence /tmp/det.json \
  --real-acp-evidence /tmp/real-acp.json \
  --vps-evidence /tmp/vps-e2e.json \
  --report /tmp/release-gate.json
```

Opt-in live helpers from the monorepo:

```bash
PLANWEAVE_REAL_ACP=1 node scripts/real-acp-host-smoke.mjs --list-profiles
PLANWEAVE_VPS_E2E=1 node scripts/vps-authenticated-e2e.mjs --profile local-tls-fixture
```

See `planweave-server release-gate --help`, `planweave-agent-host real-acp-smoke --help`, and `planweave-server vps-e2e --help` for flags and environment variables.

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
