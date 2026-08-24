#!/usr/bin/env node
import { spawn } from "node:child_process";
import electronPath from "electron";
import { context } from "esbuild";
import { resolve } from "node:path";
import { createServer } from "vite";
import {
  desktopPackageRoot,
  electronBuildOptions,
  prepareElectronBuildOutput,
  writePreloadModuleMetadata
} from "./electron-build.mjs";

const rendererPort = 5173;
const agentHostCliPath = resolve(desktopPackageRoot, "..", "agent-host", "dist", "bin.js");
let electronProcess = null;
let electronRestartRequested = false;
let restartTimer = null;
let lifecycleReady = false;
let stopping = false;
let viteServer;
let mainContext;
let preloadContext;

function launchElectron(rendererUrl) {
  const child = spawn(electronPath, [resolve(desktopPackageRoot, "dist", "main", "main.js")], {
    cwd: desktopPackageRoot,
    env: {
      ...process.env,
      PLANWEAVE_DESKTOP_DEV_SERVER_URL: rendererUrl,
      PLANWEAVE_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PLANWEAVE_DESKTOP_AGENT_HOST_CLI_PATH: agentHostCliPath
    },
    stdio: "inherit"
  });
  electronProcess = child;
  child.once("error", (error) => {
    console.error(error);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (electronProcess !== child) return;
    electronProcess = null;
    if (electronRestartRequested && !stopping) {
      electronRestartRequested = false;
      launchElectron(rendererUrl);
      return;
    }
    if (!stopping) void shutdown(code ?? (signal ? 1 : 0));
  });
}

function requestElectronRestart(rendererUrl) {
  if (stopping) return;
  electronRestartRequested = true;
  if (!electronProcess) {
    electronRestartRequested = false;
    launchElectron(rendererUrl);
    return;
  }
  electronProcess.kill();
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (electronProcess) electronProcess.kill();
  await Promise.allSettled([
    viteServer?.close(),
    mainContext?.dispose(),
    preloadContext?.dispose()
  ]);
  process.exitCode = exitCode;
}

await prepareElectronBuildOutput();
let rendererUrl = `http://127.0.0.1:${rendererPort}/`;
const onBuildEnd = (_name, result) => {
  if (!lifecycleReady || result.errors.length > 0 || stopping) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => requestElectronRestart(rendererUrl), 120);
};
const buildOptions = electronBuildOptions(onBuildEnd);
[mainContext, preloadContext] = await Promise.all([
  context(buildOptions.main),
  context(buildOptions.preload)
]);
await Promise.all([mainContext.rebuild(), preloadContext.rebuild()]);
await writePreloadModuleMetadata();
await Promise.all([mainContext.watch(), preloadContext.watch()]);

viteServer = await createServer({
  configFile: resolve(desktopPackageRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: rendererPort, strictPort: true }
});
await viteServer.listen();
rendererUrl = viteServer.resolvedUrls?.local[0] ?? rendererUrl;
lifecycleReady = true;
launchElectron(rendererUrl);

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
