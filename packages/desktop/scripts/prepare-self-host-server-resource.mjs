#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const desktopRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "../..");
const outputRoot = resolve(desktopRoot, "build/generated/planweave-self-host-server");
const imageRoot = resolve(outputRoot, "image");
const stagingAppRoot = resolve(outputRoot, "staging-app");

function run(command, args, cwd = repositoryRoot) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`self-host resource build failed with exit ${code}`))
    );
  });
}

function capture(command, args, cwd = repositoryRoot) {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveCapture(Buffer.concat(chunks).toString("utf8").trim())
        : reject(new Error(`self-host resource metadata failed with exit ${code}`))
    );
  });
}

function pnpmInvocation(args) {
  const pnpmCliPath = process.env.npm_execpath;
  if (!pnpmCliPath) {
    throw new Error("self-host resource build must be invoked through pnpm");
  }
  return { command: process.execPath, args: [pnpmCliPath, ...args] };
}

async function assertPortableDirectory(directory) {
  for (const entry of await readdir(directory)) {
    const path = resolve(directory, entry);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`self-host resource contains symbolic link: ${path}`);
    }
    if (metadata.isDirectory()) await assertPortableDirectory(path);
  }
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(imageRoot, { recursive: true });
const deploy = pnpmInvocation([
  "--config.node-linker=hoisted",
  "--config.inject-workspace-packages=true",
  "--filter",
  "@planweave-ai/server",
  "--prod",
  "deploy",
  "--legacy",
  stagingAppRoot
]);
await run(deploy.command, deploy.args);
const appRoot = resolve(imageRoot, "app");
await cp(stagingAppRoot, appRoot, { recursive: true, dereference: true });
await rm(stagingAppRoot, { recursive: true, force: true });
await assertPortableDirectory(appRoot);
await run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    "await import('@agentclientprotocol/sdk'); await import('@planweave-ai/runtime');"
  ],
  appRoot
);
await Promise.all([
  cp(resolve(desktopRoot, "build/self-host-server.Dockerfile"), resolve(imageRoot, "Dockerfile")),
  cp(
    resolve(repositoryRoot, "packages/server/docker-entrypoint.sh"),
    resolve(imageRoot, "docker-entrypoint.sh")
  ),
  cp(resolve(desktopRoot, "build/self-host-compose.yaml"), resolve(outputRoot, "compose.yaml"))
]);
const buildRevision = await capture("git", ["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(buildRevision)) {
  throw new Error("self-host resource build revision is invalid");
}
const dockerfilePath = resolve(imageRoot, "Dockerfile");
const dockerfile = await readFile(dockerfilePath, "utf8");
const revisionMarker = "ARG PLANWEAVE_SERVER_BUILD_REVISION=development";
if (!dockerfile.includes(revisionMarker)) {
  throw new Error("self-host resource build revision marker is missing");
}
await writeFile(
  dockerfilePath,
  dockerfile.replace(revisionMarker, `ARG PLANWEAVE_SERVER_BUILD_REVISION=${buildRevision}`),
  "utf8"
);
