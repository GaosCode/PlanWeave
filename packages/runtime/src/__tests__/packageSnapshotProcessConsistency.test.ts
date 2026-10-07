import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { spawnPackageMutation } from "./helpers/packageBatchProcessFixture.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
const roots: string[] = [];
const home = process.env.PLANWEAVE_HOME;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (home === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = home;
});

it("serializes a real child replacement from another temporary directory with capture", async () => {
  const f = await createTestWorkspace();
  roots.push(f.root, f.home);
  const before = (await capturePackageSnapshot({ projectRoot: f.init.workspace })).snapshot;
  const files = before.files.map((file) => ({
    path: file.path,
    encoding: "utf8" as const,
    content: file.path === "manifest.json" ? file.content : `${file.content}replacement\n`
  }));
  const childTemp = join(f.home, "child-temp");
  await fs.mkdir(childTemp);
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let actor: ReturnType<typeof spawnPackageMutation> | undefined;
  vi.mocked(fs.stat).mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
    const result = await Reflect.apply(actual.stat, actual, args);
    if (!actor && args[0] === join(f.init.workspace.packageDir, "manifest.json")) {
      actor = spawnPackageMutation(f.init.workspace.packageDir, "replace", childTemp, files);
      await actor.ready;
    }
    return result;
  });
  const during = (await capturePackageSnapshot({ projectRoot: f.init.workspace })).snapshot;
  expect(during).toEqual(before);
  expect(actor).toBeDefined();
  expect(actor!.observedHeld).toBe(true);
  expect(await actor!.done).toEqual({ code: 0, stderr: "" });
  const after = (await capturePackageSnapshot({ projectRoot: f.init.workspace })).snapshot;
  expect(after.files.map(({ path, content }) => ({ path, content }))).toEqual(
    files.map(({ path, content }) => ({ path, content }))
  );
  expect(after.sourceRevision).not.toBe(before.sourceRevision);
  for (const file of after.files) {
    expect(file.digestSha256).toBe(createHash("sha256").update(file.content).digest("hex"));
    expect(file.sizeBytes).toBe(Buffer.byteLength(file.content));
  }
});
