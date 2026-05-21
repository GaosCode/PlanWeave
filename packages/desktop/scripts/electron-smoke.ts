import { spawn } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initWorkspace } from "@planweave/runtime";

const mainEntry = resolve(process.cwd(), "dist", "main", "main.js");
const electronBin = resolve(process.cwd(), "node_modules", ".bin", "electron");
const repoRoot = resolve(process.cwd(), "../..");
const smokeHome = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-home-"));
const smokeUserData = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-user-data-"));
const smokeProjectRoot = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-project-"));
process.env.PLANWEAVE_HOME = smokeHome;
const init = await initWorkspace({ projectRoot: smokeProjectRoot });

await cp(resolve(repoRoot, "examples", "basic-plan-package", "package"), init.workspace.packageDir, {
  recursive: true,
  force: true
});
await writeFile(init.workspace.projectPromptFile, "Desktop smoke project prompt.\n", "utf8");

const child = spawn(electronBin, [mainEntry], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PLANWEAVE_HOME: smokeHome,
    PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT: smokeProjectRoot,
    PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR: smokeUserData,
    PLANWEAVE_DESKTOP_SMOKE: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";

child.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});

child.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error("Electron smoke timed out.");
  process.exit(1);
}, 15_000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  if (!output.includes("PLANWEAVE_DESKTOP_SMOKE_READY")) {
    console.error("Electron smoke did not report readiness.");
    process.exit(1);
  }
});
