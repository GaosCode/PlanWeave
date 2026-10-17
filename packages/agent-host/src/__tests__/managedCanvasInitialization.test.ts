import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rm, utimes, writeFile, symlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyState } from "@planweave-ai/runtime";
import { managedCanvasInitializationFixture } from "./support/managedCanvasInitializationFixture.js";
import type { ResolvedCanvasRuntime } from "../runtime/canvasRuntimeResolver.js";
import { runtimeStateSchema } from "../../../runtime/src/schema/runtimeState.js";

type Message = {
  type: string;
  from?: string;
  to?: string;
  path?: string;
  result?: ResolvedCanvasRuntime;
  error?: string;
};
const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    })
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const fixture = await managedCanvasInitializationFixture();
  roots.push(fixture.root);
  return fixture;
}
function worker() {
  const child = fork(
    fileURLToPath(new URL("./support/managedCanvasInitializationWorker.mjs", import.meta.url)),
    [],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  children.push(child);
  const queue: Message[] = [];
  const listeners = new Set<() => void>();
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  child.on("message", (value: Message) => {
    queue.push(value);
    for (const listen of listeners) listen();
  });
  child.on("exit", () => {
    for (const listen of listeners) listen();
  });
  return {
    child,
    wait: (type: string) =>
      new Promise<Message>((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(new Error(`worker timed out waiting for ${type}: ${output}`)),
          15_000
        );
        function finish(error?: Error, value?: Message) {
          clearTimeout(timeout);
          listeners.delete(check);
          if (error) reject(error);
          else if (value) resolve(value);
        }
        function check() {
          const failed = queue.find((value) => value.type === "failed");
          const index = queue.findIndex((value) => value.type === type);
          if (failed) finish(new Error(`${failed.error}\n${output}`));
          else if (index >= 0) finish(undefined, queue.splice(index, 1)[0]);
          else if (child.exitCode !== null || child.signalCode !== null)
            finish(new Error(`worker exited before ${type}: ${output}`));
        }
        listeners.add(check);
        check();
      })
  };
}
async function completeFiles(paths: string[]) {
  const bytes = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  for (const value of bytes.slice(0, 3)) expect(() => JSON.parse(value)).not.toThrow();
  expect(bytes[3]).toBe("# Project Prompt\n");
  return bytes;
}

describe("managed Canvas initialization across processes", () => {
  it("serializes first resolve across independent processes and preserves execution bytes on concurrent reuse", async () => {
    const { config, scope, paths, resolver } = await setup();
    const first = worker();
    const second = worker();
    await Promise.all([first.wait("ready"), second.wait("ready")]);
    first.child.send({ type: "start", config, scope, pauseAt: "project.json" });
    const paused = await first.wait("paused");
    expect(JSON.parse(await readFile(String(paused.from), "utf8")).id).toBe(scope.projectId);
    await expect(lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
    second.child.send({ type: "start", config, scope });
    await second.wait("contended");
    first.child.send({ type: "release" });
    const [a, b] = await Promise.all([first.wait("resolved"), second.wait("resolved")]);
    expect(a.result?.canvas.packageStorageIdentity).toBeTruthy();
    expect(b.result?.canvas.packageStorageIdentity).toBe(a.result?.canvas.packageStorageIdentity);
    expect(b.result?.canvas.projectCreatedAt).toBe(a.result?.canvas.projectCreatedAt);
    await completeFiles(paths);
    const state = {
      ...createEmptyState(),
      currentRefs: ["T-001#B-001"],
      blocks: { "T-001#B-001": { status: "in_progress" } }
    };
    runtimeStateSchema.parse(state);
    await writeFile(paths[2], `${JSON.stringify(state)}\n`);
    await writeFile(paths[3], "# Retain custom instructions\n");
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    const readers = [worker(), worker()];
    await Promise.all(readers.map((reader) => reader.wait("ready")));
    for (const reader of readers) reader.child.send({ type: "start", config, scope });
    const reused = await Promise.all(readers.map((reader) => reader.wait("resolved")));
    expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
    for (const value of reused) {
      expect(value.result?.canvas.packageStorageIdentity).toBe(
        a.result?.canvas.packageStorageIdentity
      );
      expect(value.result?.canvas.projectCreatedAt).toBe(a.result?.canvas.projectCreatedAt);
    }
    expect((await resolver.resolve(scope)).canvas.packageStorageIdentity).toBe(
      a.result?.canvas.packageStorageIdentity
    );
  }, 30_000);

  it.each([
    0, 1, 2, 3
  ])("recovers a dead lock owner before publishing initialization file %i", async (stage) => {
    const { config, scope, projectRoot, paths } = await setup();
    const crashed = worker();
    await crashed.wait("ready");
    crashed.child.send({
      type: "start",
      config,
      scope,
      pauseAt: paths[stage].split(/[\\/]/).at(-1)
    });
    const paused = await crashed.wait("paused");
    const prior = await Promise.all(paths.slice(0, stage).map((path) => readFile(path, "utf8")));
    await expect(lstat(paths[stage])).rejects.toMatchObject({ code: "ENOENT" });
    const orphan = String(paused.from);
    const orphanBytes = await readFile(orphan, "utf8");
    const lockPath = join(
      userInfo().homedir,
      ".cache",
      "planweave",
      "project-locks",
      createHash("sha256").update(projectRoot).digest("hex")
    );
    expect(JSON.parse(await readFile(join(lockPath, "holder.json"), "utf8")).pid).toBe(
      crashed.child.pid
    );
    const exited = new Promise<void>((resolve) => crashed.child.once("exit", () => resolve()));
    crashed.child.kill("SIGKILL");
    await exited;
    // Advance only this fixture's real lock mtime past the production stale threshold.
    const stale = new Date(Date.now() - 120_000);
    await utimes(lockPath, stale, stale);
    const retry = worker();
    await retry.wait("ready");
    retry.child.send({ type: "start", config, scope });
    const result = await retry.wait("resolved");
    expect(result.result?.canvas.packageStorageIdentity).toBeTruthy();
    await completeFiles(paths);
    expect(await Promise.all(paths.slice(0, stage).map((path) => readFile(path, "utf8")))).toEqual(
      prior
    );
    expect(await readFile(orphan, "utf8")).toBe(orphanBytes);
    expect((await readdir(dirname(orphan))).filter((name) => name.includes(".tmp-"))).toEqual([
      orphan.split(/[\\/]/).at(-1)
    ]);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it.each([
    "metadata-json",
    "metadata-id",
    "metadata-root",
    "metadata-source",
    "graph-json",
    "graph-schema",
    "graph-identity",
    "final-symlink",
    "directory-symlink"
  ])("rejects %s without replacing stored bytes", async (kind) => {
    const { resolver, scope, root, paths } = await setup();
    await resolver.resolve(scope);
    let target = paths[0];
    if (kind.startsWith("graph")) target = paths[1];
    if (kind.endsWith("json")) await writeFile(target, "{corrupt");
    else if (kind === "metadata-id" || kind === "metadata-source" || kind === "metadata-root") {
      const metadata = JSON.parse(await readFile(target, "utf8"));
      if (kind === "metadata-id") metadata.id = "wrong-project";
      else if (kind === "metadata-root") metadata.rootPath = root;
      else metadata.sourceRoot = root;
      await writeFile(target, JSON.stringify(metadata));
    } else if (kind.startsWith("graph")) {
      const graph = JSON.parse(await readFile(target, "utf8"));
      if (kind === "graph-schema") graph.version = "invalid";
      else graph.canvases[0].title = "wrong-canvas";
      await writeFile(target, JSON.stringify(graph));
    } else {
      const outside = join(root, "outside");
      if (kind === "final-symlink") {
        await writeFile(outside, "outside untouched");
        await rm(target);
        await symlink(outside, target);
      } else {
        const fs = await import("node:fs/promises");
        await fs.mkdir(outside);
        target = dirname(paths[3]);
        await rm(paths[3]);
        await fs.rmdir(target);
        await symlink(outside, target, "junction");
      }
    }
    const snapshot =
      kind === "directory-symlink"
        ? await readdir(join(root, "outside"))
        : await readFile(target, "utf8");
    await expect(resolver.resolve(scope)).rejects.toThrow(
      kind === "metadata-json"
        ? "malformed JSON"
        : kind.endsWith("symlink")
          ? "runtime_project_escape"
          : "runtime_project_identity_mismatch"
    );
    expect(
      kind === "directory-symlink"
        ? await readdir(join(root, "outside"))
        : await readFile(target, "utf8")
    ).toEqual(snapshot);
  });
});
