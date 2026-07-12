# AGENTS.md

## Monorepo layout

```
packages/runtime   Core graph, package, executor, auto-run logic (dependency of all others)
packages/mcp       HTTP MCP server (depends on runtime)
packages/cli       planweave CLI (depends on runtime + mcp)
packages/desktop   Electron app (depends on runtime + mcp)
```

## Commands

```bash
# Install (uses pnpm 10.32.1, Node >= 22.5)
pnpm install --frozen-lockfile

# Full build (all packages): runtime → mcp, then cli + desktop
pnpm -r build

# Build only desktop (includes its runtime + mcp deps)
pnpm --dir packages/desktop build

# Lint chain (check:versions → check:dom-boundaries → typecheck)
pnpm lint

# Typecheck only (builds runtime + mcp first because CLI depends on their types)
pnpm typecheck

# Run all tests (includes check:versions + check:dom-boundaries pre-checks)
pnpm test

# Run a single package's tests
pnpm --filter @planweave-ai/runtime vitest run
pnpm --filter @planweave-ai/cli vitest run
pnpm --filter @planweave-ai/mcp vitest run

# Run a single test file
vitest run packages/cli/src/__tests__/some.test.ts

# Run CLI from source (no build required: uses tsx)
pnpm --filter @planweave-ai/cli planweave --help

# MCP server from source
pnpm --filter @planweave-ai/mcp mcp

# Desktop from source
pnpm --dir packages/desktop build && pnpm --dir packages/desktop start
```

## Build order matters

`pnpm -r build` respects workspace dependency order (runtime → mcp → cli/desktop). When running individual builds, you must build runtime and mcp before cli or desktop. Desktop's `build` script explicitly builds runtime and mcp first.

## typecheck is expensive

`pnpm typecheck` runs `tsc --noEmit` across **runtime, mcp, CLI, and desktop** (the desktop uses two tsconfigs: `tsconfig.json` for renderer, `tsconfig.main.json` for main process). Because CLI and MCP depend on runtime's compiled output, `pnpm typecheck` first builds runtime and mcp before typechecking them. This means `pnpm typecheck` also builds.

## Desktop architecture

The desktop app has three process layers, each with its own build pipeline:

| Layer | Source | Build | Output |
|-------|--------|-------|--------|
| Main | `src/main/` | esbuild bundle (ESM, node20) | `dist/main/main.js` |
| Preload | `src/preload/` | esbuild bundle (ESM, node20) | `dist/preload/preload.js` |
| Renderer | `src/renderer/` | Vite (React + Tailwind) | `dist/renderer/` |

- Main process: `tsconfig.main.json` — NodeNext module, Node types. Run with `tsc --noEmit` for typecheck only; actual JS is emitted by esbuild.
- Renderer process: `tsconfig.json` — Bundler module, DOM lib, `jsx: "react-jsx"`. Uses Vite for dev and build.
- The renderer uses React 19, Tailwind CSS 4, shadcn/ui, and @xyflow/react for the task graph canvas.
- The `@` import alias resolves to `packages/desktop/src/renderer` (defined in both vite.config.ts and renderer tsconfig.json).
- Main ↔ Renderer communication goes through the preload bridge (`src/preload/preload.ts`).

## Version metadata

When bumping the version, use the sync script because version strings exist in five package.json files, `packages/mcp/src/packageInfo.ts`, and two README badge blocks. The pre-commit hook and CI enforce consistency.

```bash
pnpm sync:versions -- --all 0.2.3     # update everything
pnpm check:versions                    # verify consistency (runs in pre-commit + CI)
```

## DOM boundary check (desktop renderer)

`scripts/check-renderer-dom-boundaries.mjs` scans `packages/desktop/src` for raw DOM access (`document.querySelector`, `getElementById`, `innerHTML`, `textContent`, `classList`) outside of an explicit allowlist and test files. All renderer DOM access must go through approved hooks in `packages/desktop/src/renderer/hooks/`. If you add a new hook that needs raw DOM access, add it to the `allowedFiles` set in the script.

## Tests

- Runner: vitest (v4), `fileParallelism: false`, 10s timeout per test
- Test files: any `packages/**/*.test.ts` or `packages/**/*.test.tsx`
- React component tests (`.test.tsx`) declare `/* @vitest-environment jsdom */` per-file; there is no global jsdom config
- MCP tests require runtime types — the MCP package's `test` script cds to repo root before running vitest
- `pnpm test` runs `check:versions` and `check:dom-boundaries` before tests. To run tests without pre-checks: `vitest run`
- CI workflow: `pnpm lint` → `pnpm -r build` → `pnpm test` (in that order)

## Pre-commit

Husky runs `pnpm check:versions` and `pnpm check:dom-boundaries` on commit. Pre-commit does NOT run tests or full builds.

## Desktop releases

Desktop releases must use the GitHub Actions "Desktop Release" workflow — not local scripts. Use `desktop:dist:mac`, `desktop:dist:linux`, `desktop:dist:win` for local unsigned builds. macOS unsigned builds need `CSC_IDENTITY_AUTO_DISCOVERY=false`.

Desktop smoke tests run on `macos-latest` in CI and verify both packaged and UI smoke. The smoke test uses `packages/desktop/scripts/electron-smoke.ts` which spawns the Electron app with a temporary workspace seeded from `examples/basic-plan-package`.

## Miscellaneous

- All packages are ESM (`"type": "module"`), strict TypeScript, NodeNext module resolution
- pnpm overrides pin specific versions of hono, js-yaml, tar, tmp, undici — don't upgrade these casually
- Electron native dependency `electron-liquid-glass` is excluded from ASAR bundling
- The root `vitest.config.ts` defines a `@` alias for desktop renderer, shared by all package tests
- `.octocode/rfc/` stores RFC documents (gitignored); e.g. `lan-multi-user-collaboration`
