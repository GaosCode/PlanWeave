import { access, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAdvisoryControlServer } from "../../../runtime/src/__tests__/support/advisoryControlServer.js";
import { withAdvisoryDirectoryLock } from "../../../runtime/src/fs/advisoryDirectoryLock.js";
import {
  launchResource,
  ownedStore,
  resourceFixture
} from "./support/selfHostServerResourceHarness.js";

async function preserved(f: Awaited<ReturnType<typeof resourceFixture>>) {
  expect(await readFile(join(f.parent, "outside-marker"), "utf8")).toBe("external owner");
  expect(await readFile(join(f.stores, "planweave-deploy-store-history/keep"), "utf8")).toBe(
    "historical owner"
  );
}
it.each([
  "success",
  "deploy-failure",
  "copy-failure",
  "validation-failure"
])("removes only its own unparented deploy store after %s", async (mode) => {
  const f = await resourceFixture(mode);
  try {
    expect(await readFile(f.script)).toEqual(await readFile(f.source));
    const result = await launchResource(f).done;
    expect(result.code).toBe(mode === "success" ? 0 : 1);
    if (mode === "deploy-failure") expect(result.stderr).toContain("exit 7");
    if (mode === "copy-failure") expect(result.stderr).toContain("ENOENT");
    if (mode === "validation-failure")
      expect(result.stderr).toContain("revision marker is missing");
    await expect(access(await ownedStore(f))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(f.stores)).toEqual(["planweave-deploy-store-history"]);
    await preserved(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it.each([
  "success",
  "deploy-failure"
])("waits for a real descendant writer after deploy %s before removing its store", async (mode) => {
  const control = await createAdvisoryControlServer();
  const f = await resourceFixture(mode, true);
  f.env.TEST_CONTROL_PORT = String(control.port);
  const run = launchResource(f);
  try {
    const { store } = await run.writerReady;
    await control.wait("writer", "parent-terminal");
    await access(join(store, "owned-store"));
    control.send("writer", "release");
    await control.wait("writer", "writer-terminal");
    expect((await run.done).code).toBe(mode === "success" ? 0 : 1);
    expect(await readFile(join(f.root, "writer-terminal"), "utf8")).toBe("completed");
    await expect(access(store)).rejects.toMatchObject({ code: "ENOENT" });
    await preserved(f);
  } finally {
    control.send("writer", "release");
    await control.wait("writer", "writer-terminal");
    await run.done;
    await control.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it.each([
  "success",
  "deploy-failure"
])("leaves managed store ownership with the outer lease until the writer exits after %s", async (mode) => {
  const f = await resourceFixture(mode);
  const lockPath = join(f.root, "build-lock");
  try {
    let store = "";
    const operation = withAdvisoryDirectoryLock(
      { lockPath, operation: "resource-managed" },
      async (scope) => {
        await scope.runManagedCommand({
          command: process.execPath,
          args: [f.script],
          cwd: f.root,
          env: f.env
        });
        store = await ownedStore(f);
        await access(store);
        expect(store.startsWith(lockPath)).toBe(true);
      }
    );
    if (mode === "success") await operation;
    else await expect(operation).rejects.toThrow("exit code");
    if (mode === "deploy-failure") store = await ownedStore(f);
    await expect(access(store)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await preserved(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it.each([
  "success",
  "deploy-failure"
])("retains meaningful cleanup errors after %s", async (mode) => {
  const f = await resourceFixture(mode);
  f.env.STORE_TEST_FAULT = "cleanup";
  try {
    const result = await launchResource(f, [
      "--import",
      new URL("./support/selfHostStoreFaults.mjs", import.meta.url).href
    ]).done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("owned store cleanup EACCES");
    if (mode === "deploy-failure") {
      expect(result.stderr).toContain("build and owned deploy store cleanup failed");
      expect(result.stderr).toContain("exit 7");
    }
    await access(await ownedStore(f));
    await preserved(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("cleans its newly created store when the deploy process cannot spawn", async () => {
  const f = await resourceFixture("success");
  f.env.STORE_TEST_FAULT = "spawn";
  try {
    const result = await launchResource(f, [
      "--import",
      new URL("./support/selfHostStoreFaults.mjs", import.meta.url).href
    ]).done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ENOENT");
    expect(await readdir(f.stores)).toEqual(["planweave-deploy-store-history"]);
    await preserved(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("preserves a caller-provided store parent and its outer owner marker", async () => {
  const f = await resourceFixture("success");
  f.env.PLANWEAVE_BUILD_STORE_DIR = f.parent;
  try {
    expect((await launchResource(f).done).code).toBe(0);
    const store = await ownedStore(f);
    expect(store.startsWith(f.parent)).toBe(true);
    await access(store);
    await preserved(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it.each([
  "success",
  "deploy-failure"
])("keeps the outer managed lease until the deploy descendant terminates after %s", async (mode) => {
  const control = await createAdvisoryControlServer();
  const f = await resourceFixture(mode, true);
  f.env.TEST_CONTROL_PORT = String(control.port);
  let finished = false;
  const operation = withAdvisoryDirectoryLock(
    { lockPath: join(f.root, "build-lock"), operation: "managed-resource-writer" },
    (scope) =>
      scope.runManagedCommand({
        command: process.execPath,
        args: [f.script],
        cwd: f.root,
        env: f.env
      })
  ).then(
    () => {
      finished = true;
      return { ok: true };
    },
    (error: unknown) => {
      finished = true;
      return { ok: false, error };
    }
  );
  try {
    await control.wait("writer", "parent-terminal");
    const store = await ownedStore(f);
    await access(store);
    expect(finished).toBe(false);
    control.send("writer", "release");
    await control.wait("writer", "writer-terminal");
    const result = await operation;
    expect(result.ok).toBe(mode === "success");
    await expect(access(store)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.root, "writer-terminal"), "utf8")).toBe("completed");
    await preserved(f);
  } finally {
    if (!control.messages.some((message) => message.event === "writer-terminal"))
      control.send("writer", "release");
    await operation;
    await control.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
