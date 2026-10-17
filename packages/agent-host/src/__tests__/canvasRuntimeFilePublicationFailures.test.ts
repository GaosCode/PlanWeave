import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedCanvasInitializationFixture } from "./support/managedCanvasInitializationFixture.js";

const hooks = vi.hoisted(() => ({
  write: undefined as undefined | ((path: string) => Promise<void>),
  writeName: undefined as undefined | string,
  close: undefined as undefined | (() => Promise<void>),
  publish: undefined as undefined | ((from: string, to: string) => Promise<void>),
  cleanup: undefined as undefined | ((path: string) => Promise<void>),
  uuid: undefined as undefined | (() => string),
  opened: undefined as undefined | ((path: string) => Promise<void>),
  opens: 0
}));
vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, randomUUID: () => hooks.uuid?.() ?? crypto.randomUUID() };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).includes(".tmp-")) hooks.opens++;
      await hooks.opened?.(String(args[0]));
      const handle = await fs.open(...args);
      const write = handle.writeFile.bind(handle);
      const close = handle.close.bind(handle);
      handle.writeFile = async (...values: Parameters<typeof handle.writeFile>) => {
        if (
          hooks.write &&
          (!hooks.writeName || basename(String(args[0])).startsWith(`.${hooks.writeName}.tmp-`))
        ) {
          await write("partial", "utf8");
          await hooks.write(String(args[0]));
        } else await write(...values);
      };
      handle.close = async () => {
        await close();
        await hooks.close?.();
      };
      return handle;
    },
    link: async (from: string, to: string) => {
      await hooks.publish?.(from, to);
      await fs.link(from, to);
    },
    unlink: async (path: string) => {
      await hooks.cleanup?.(path);
      await fs.unlink(path);
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  hooks.write = hooks.close = hooks.publish = hooks.cleanup = hooks.uuid = undefined;
  hooks.opened = undefined;
  hooks.writeName = undefined;
  hooks.opens = 0;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const fixture = await managedCanvasInitializationFixture();
  roots.push(fixture.root);
  return fixture;
}
const failure = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

describe("managed runtime publication failures on real files", () => {
  it("returns non-collision open errors without attempting cleanup or publishing", async () => {
    const { resolver, scope, paths } = await setup();
    const error = failure("EACCES");
    hooks.opened = async () => {
      throw error;
    };
    hooks.cleanup = async () => {
      throw new Error("must not clean an unowned path");
    };
    await expect(resolver.resolve(scope)).rejects.toBe(error);
    expect(hooks.opens).toBe(1);
    await expect(lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(
    [0, 1, 2, 3].flatMap((index) =>
      (["write", "close", "publish"] as const).map((stage) => ({ index, stage }))
    )
  )("keeps final absent after file $index $stage fails and retries", async ({ index, stage }) => {
    const { resolver, scope, paths } = await setup();
    const error = failure("EIO");
    if (stage === "close") {
      let closes = 0;
      hooks.close = async () => {
        if (closes++ === index) throw error;
      };
    } else {
      if (stage === "write") hooks.writeName = basename(paths[index]);
      hooks[stage] = async (from) => {
        if (basename(from).startsWith(`.${basename(paths[index])}.tmp-`)) throw error;
      };
    }
    await expect(resolver.resolve(scope)).rejects.toBe(error);
    await expect(lstat(paths[index])).rejects.toMatchObject({ code: "ENOENT" });
    const prior = await Promise.all(paths.slice(0, index).map((path) => readFile(path, "utf8")));
    expect((await readdir(dirname(paths[index]))).filter((name) => name.includes(".tmp-"))).toEqual(
      []
    );
    hooks[stage] = undefined;
    const next = await resolver.resolve(scope);
    expect(JSON.parse(await readFile(paths[0], "utf8")).id).toBe(scope.projectId);
    expect(next.canvas.packageStorageIdentity).toBeTruthy();
    expect(await Promise.all(paths.slice(0, index).map((path) => readFile(path, "utf8")))).toEqual(
      prior
    );
  });

  it("retains write, close and cleanup failures in order without publishing partial bytes", async () => {
    const { resolver, scope, projectRoot, paths } = await setup();
    const errors = [failure("EIO"), failure("EBADF"), failure("EPERM")];
    hooks.write = async () => {
      throw errors[0];
    };
    hooks.close = async () => {
      throw errors[1];
    };
    hooks.cleanup = async () => {
      throw errors[2];
    };
    await expect(resolver.resolve(scope)).rejects.toMatchObject({ errors });
    await expect(lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
    const leftovers = (await readdir(projectRoot)).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toHaveLength(1);
    expect(await readFile(join(projectRoot, leftovers[0]), "utf8")).toBe("partial");
    hooks.write = hooks.close = hooks.cleanup = undefined;
    await resolver.resolve(scope);
    expect(await readFile(join(projectRoot, leftovers[0]), "utf8")).toBe("partial");
  });

  it("reports cleanup failure after complete publication and preserves the winner on retry", async () => {
    const { resolver, scope, paths } = await setup();
    const error = failure("EPERM");
    hooks.cleanup = async () => {
      throw error;
    };
    await expect(resolver.resolve(scope)).rejects.toBe(error);
    const bytes = await readFile(paths[0], "utf8");
    expect(JSON.parse(bytes).id).toBe(scope.projectId);
    hooks.cleanup = undefined;
    await resolver.resolve(scope);
    expect(await readFile(paths[0], "utf8")).toBe(bytes);
  });

  it.each([
    "EPERM",
    "EXDEV"
  ])("surfaces %s publication failure without a weaker fallback", async (code) => {
    const { resolver, scope, paths } = await setup();
    const error = failure(code);
    hooks.publish = async () => {
      throw error;
    };
    await expect(resolver.resolve(scope)).rejects.toBe(error);
    await expect(lstat(paths[0])).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(dirname(paths[0]))).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it.each([
    { index: 1, kind: "valid" },
    { index: 1, kind: "bad-json" },
    { index: 1, kind: "bad-identity" },
    { index: 2, kind: "custom-state" },
    { index: 3, kind: "custom-prompt" }
  ])("preserves and validates an EEXIST file $index $kind winner", async ({ index, kind }) => {
    const { resolver, scope, paths } = await setup();
    let winner = "";
    hooks.publish = async (from, to) => {
      if (to !== paths[index]) return;
      winner = await readFile(from, "utf8");
      if (kind === "bad-json") winner = "{broken";
      if (kind === "bad-identity") {
        const graph = JSON.parse(winner);
        graph.canvases[0].title = "other";
        winner = JSON.stringify(graph);
      }
      if (kind === "custom-state") {
        const state = JSON.parse(winner);
        state.currentRefs = ["T-001#B-001"];
        state.blocks = { "T-001#B-001": { status: "in_progress" } };
        winner = JSON.stringify(state);
      }
      if (kind === "custom-prompt") winner = "# Winner's custom policy\n";
      await writeFile(to, winner, { flag: "wx" });
    };
    if (kind.startsWith("bad")) {
      await expect(resolver.resolve(scope)).rejects.toThrow("runtime_project_identity_mismatch");
    } else await resolver.resolve(scope);
    expect(await readFile(paths[index], "utf8")).toBe(winner);
    expect((await readdir(dirname(paths[index]))).some((name) => name.includes(".tmp-"))).toBe(
      false
    );
  });

  it.each([
    "valid",
    "bad-json",
    "bad-identity",
    "symlink"
  ])("validates an EEXIST %s winner instead of overwriting it", async (kind) => {
    const { resolver, scope, root, paths } = await setup();
    let winner = "";
    hooks.publish = async (from, to) => {
      if (to !== paths[0]) return;
      const value = JSON.parse(await readFile(from, "utf8"));
      value.createdAt = "2020-01-02T03:04:05.000Z";
      if (kind === "bad-identity") value.id = "other-project";
      winner = kind === "bad-json" ? "{broken" : `${JSON.stringify(value)}\n`;
      if (kind === "symlink") {
        const { symlink } =
          await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const outside = join(root, "outside.json");
        await writeFile(outside, winner);
        await symlink(outside, to);
      } else await writeFile(to, winner, { flag: "wx" });
    };
    if (kind === "valid") {
      expect((await resolver.resolve(scope)).canvas.projectCreatedAt).toBe(
        "2020-01-02T03:04:05.000Z"
      );
    } else
      await expect(resolver.resolve(scope)).rejects.toThrow(
        kind === "symlink"
          ? "runtime_project_escape"
          : kind === "bad-json"
            ? "malformed JSON"
            : "runtime_project_identity_mismatch"
      );
    expect(await readFile(paths[0], "utf8")).toBe(winner);
    expect((await readdir(dirname(paths[0]))).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("retries a colliding temporary name without removing another owner's bytes", async () => {
    const { resolver, scope, projectRoot, paths } = await setup();
    hooks.uuid = () => (hooks.opens === 0 ? "collision" : `fresh-${hooks.opens}`);
    // The resolver creates the directory before the publisher attempts its first open.
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await fs.mkdir(projectRoot, { recursive: true });
    const other = join(projectRoot, `.${basename(paths[0])}.tmp-collision`);
    await writeFile(other, "owned by another publisher");
    await resolver.resolve(scope);
    expect(await readFile(other, "utf8")).toBe("owned by another publisher");
    expect(JSON.parse(await readFile(paths[0], "utf8")).id).toBe(scope.projectId);
  });

  it("bounds repeated temporary-name collisions and returns EEXIST without cleanup", async () => {
    const { resolver, scope, projectRoot, paths } = await setup();
    hooks.uuid = () => "collision";
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await fs.mkdir(projectRoot, { recursive: true });
    const other = join(projectRoot, `.${basename(paths[0])}.tmp-collision`);
    await writeFile(other, "owned by another publisher");
    await expect(resolver.resolve(scope)).rejects.toMatchObject({ code: "EEXIST" });
    expect(hooks.opens).toBeGreaterThan(1);
    expect(hooks.opens).toBeLessThanOrEqual(5);
    expect(await readFile(other, "utf8")).toBe("owned by another publisher");
  });
});
