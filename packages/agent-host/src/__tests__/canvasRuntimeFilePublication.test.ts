import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyState, projectGraphPath } from "@planweave-ai/runtime";
import { parseAgentHostConfig } from "../config/schema.js";
import { ConfiguredCanvasRuntimeResolver } from "../runtime/canvasRuntimeResolver.js";

const hooks = vi.hoisted(() => ({
  handles: new Map<string, { fd: number }>(),
  wrote: undefined as undefined | ((path: string) => Promise<void>),
  publish: undefined as undefined | ((from: string, to: string) => Promise<void>)
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      await hooks.wrote?.(String(args[0]));
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      hooks.handles.set(String(args[0]), handle);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        await write(...writeArgs);
        await hooks.wrote?.(String(args[0]));
      };
      return handle;
    },
    link: async (from: string, to: string) => {
      await hooks.publish?.(from, to);
      await fs.link(from, to);
    }
  };
});

const directories: string[] = [];
afterEach(async () => {
  hooks.wrote = undefined;
  hooks.publish = undefined;
  hooks.handles.clear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "planweave-runtime-publish-")));
  directories.push(root);
  await mkdir(join(root, "workspaces"));
  const config = parseAgentHostConfig({
    version: "agent-host-config/v1",
    coordinator: { url: "https://coordinator.example.com" },
    dataDirectory: join(root, "data"),
    workspaceRoot: join(root, "workspaces"),
    host: { displayName: "Publication Host", capacity: 1, capabilities: [] },
    workspaces: [],
    agentProfiles: []
  });
  const scope = { workspaceId: "workspace-a", projectId: "project-a", canvasId: "canvas-a" };
  const projectRoot = join(
    config.dataDirectory,
    "runtime-canvases",
    scope.workspaceId,
    scope.canvasId,
    "projects",
    scope.projectId
  );
  return { resolver: new ConfiguredCanvasRuntimeResolver(config), scope, projectRoot };
}

describe("managed Canvas Runtime file publication", () => {
  it("keeps each final path absent until all of its bytes are written and closed", async () => {
    const { resolver, scope, projectRoot } = await setup();
    const published = new Map<string, string>();
    hooks.wrote = async (path) => {
      if (!path.startsWith(projectRoot) || path.endsWith("holder.json")) return;
      const name = basename(path);
      const finalName = name.startsWith(".") ? name.slice(1).split(".tmp-")[0] : name;
      const finalPath = join(dirname(path), finalName);
      await expect(lstat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    };
    hooks.publish = async (from, to) => {
      expect(hooks.handles.get(from)?.fd).toBe(-1);
      const content = await readFile(from, "utf8");
      if (process.platform !== "win32") {
        expect((await lstat(from)).mode & 0o777).toBe(0o600);
      }
      expect(dirname(from)).toBe(dirname(to));
      if (to.endsWith(".json")) expect(() => JSON.parse(content)).not.toThrow();
      else expect(content).toBe("# Project Prompt\n");
      published.set(to, content);
    };
    const resolved = await resolver.resolve(scope);
    expect([...published.keys()]).toEqual([
      resolved.project.projectFile,
      projectGraphPath(resolved.project),
      resolved.canvas.stateFile,
      resolved.canvas.projectPromptFile
    ]);
    for (const [path, content] of published) {
      expect(await readFile(path, "utf8")).toBe(content);
      expect((await readdir(dirname(path))).some((name) => name.includes(".tmp-"))).toBe(false);
    }
  });

  it("preserves existing bytes, createdAt, execution state, custom prompt and storage identity on retry", async () => {
    const { resolver, scope } = await setup();
    const first = await resolver.resolve(scope);
    const state = {
      ...createEmptyState(),
      currentRefs: ["T-001#B-001"],
      blocks: { "T-001#B-001": { status: "in_progress" } }
    };
    await writeFile(first.canvas.stateFile, JSON.stringify(state));
    await writeFile(first.canvas.projectPromptFile, "# Custom project instructions\n");
    const paths = [
      first.project.projectFile,
      projectGraphPath(first.project),
      first.canvas.stateFile,
      first.canvas.projectPromptFile
    ];
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    const next = await resolver.resolve(scope);
    expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(before);
    expect(next.canvas.projectCreatedAt).toBe(first.canvas.projectCreatedAt);
    expect(next.canvas.packageStorageIdentity).toBe(first.canvas.packageStorageIdentity);
  });

  it("reports unsupported publication without creating a final file and can retry", async () => {
    const { resolver, scope, projectRoot } = await setup();
    const unsupported = Object.assign(new Error("hard links unsupported"), { code: "EOPNOTSUPP" });
    hooks.publish = async () => {
      throw unsupported;
    };
    await expect(resolver.resolve(scope)).rejects.toBe(unsupported);
    await expect(lstat(join(projectRoot, "project.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect((await readdir(projectRoot)).some((name) => name.includes(".tmp-"))).toBe(false);
    hooks.publish = undefined;
    const retried = await resolver.resolve(scope);
    expect(JSON.parse(await readFile(retried.project.projectFile, "utf8")).id).toBe(
      scope.projectId
    );
  });
});
