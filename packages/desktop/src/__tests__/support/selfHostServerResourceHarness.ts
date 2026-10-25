import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const desktop = fileURLToPath(new URL("../../..", import.meta.url));
const repository = fileURLToPath(new URL("../../../../..", import.meta.url));
export async function resourceFixture(mode: string, writer = false) {
  const root = await mkdtemp(join(tmpdir(), "planweave-resource-store-"));
  const isolatedDesktop = join(root, "packages/desktop");
  const scripts = join(isolatedDesktop, "scripts");
  const stores = join(root, "tmp");
  const parent = join(root, "external-store");
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(stores),
    mkdir(parent),
    mkdir(join(root, "packages/server"), { recursive: true }),
    mkdir(join(isolatedDesktop, "build"), { recursive: true })
  ]);
  await cp(
    join(desktop, "scripts/prepare-self-host-server-resource.mjs"),
    join(scripts, "prepare-self-host-server-resource.mjs")
  );
  await symlink(
    join(desktop, "node_modules"),
    join(isolatedDesktop, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await writeFile(join(root, ".git"), `gitdir: ${join(repository, ".git")}\n`);
  await writeFile(join(parent, "outside-marker"), "external owner");
  await mkdir(join(stores, "planweave-deploy-store-history"));
  await writeFile(join(stores, "planweave-deploy-store-history/keep"), "historical owner");
  await writeFile(join(isolatedDesktop, "build/self-host-compose.yaml"), "services: {}\n");
  await writeFile(join(root, "packages/server/docker-entrypoint.sh"), "#!/bin/sh\n");
  if (mode !== "copy-failure")
    await writeFile(
      join(isolatedDesktop, "build/self-host-server.Dockerfile"),
      mode === "validation-failure"
        ? "FROM scratch\n"
        : "ARG PLANWEAVE_SERVER_BUILD_REVISION=development\n"
    );
  const script = join(scripts, "prepare-self-host-server-resource.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: stores,
    TMP: stores,
    TEMP: stores,
    npm_execpath: fileURLToPath(new URL("./selfHostDeployFixture.mjs", import.meta.url)),
    STORE_TEST_ROOT: root,
    STORE_TEST_MODE: mode,
    STORE_TEST_WRITER: writer ? "1" : "0"
  };
  delete env.PLANWEAVE_BUILD_STORE_DIR;
  return {
    root,
    script,
    stores,
    parent,
    env,
    source: join(desktop, "scripts/prepare-self-host-server-resource.mjs")
  };
}
export function launchResource(
  f: Awaited<ReturnType<typeof resourceFixture>>,
  args: string[] = []
) {
  const child = spawn(process.execPath, [...args, f.script], {
    cwd: f.root,
    env: f.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "",
    stderr = "";
  let resolveReady: (value: { pid: number; store: string }) => void;
  let rejectReady: (error: Error) => void;
  const writerReady = new Promise<{ pid: number; store: string }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void writerReady.catch(() => undefined);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const match = /^WRITER_READY (.+)$/m.exec(stdout);
    if (match)
      resolveReady(
        z
          .object({ pid: z.number().int().positive(), store: z.string() })
          .parse(JSON.parse(match[1]))
      );
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        rejectReady(new Error(`resource closed before writer readiness: ${stderr}`));
        resolve({ code, stdout, stderr });
      });
    }
  );
  return { child, writerReady, done };
}
export async function ownedStore(f: Awaited<ReturnType<typeof resourceFixture>>) {
  return readFile(join(f.root, "store-path"), "utf8");
}
