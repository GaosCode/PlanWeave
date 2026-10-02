import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveProjectWorkspace } from "../project.js";
import {
  readProjectPrompt,
  readProjectPromptBytes,
  readProjectPromptPolicy,
  updateProjectPrompt,
  updateProjectPromptPolicy
} from "../projectPromptPolicy.js";
import { updateGlobalPrompt } from "../globalPrompt.js";
import type { PackageWorkspaceRef } from "../types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
    mkdir: vi.fn(actual.mkdir)
  };
});
let actual: typeof fs;
let root: string;
const originalHome = process.env.PLANWEAVE_HOME;
beforeEach(async () => {
  actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.realpath).mockReset().mockImplementation(actual.realpath);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.mkdir).mockReset().mockImplementation(actual.mkdir);
  root = await fs.mkdtemp(join(tmpdir(), "planweave-prompt-home-"));
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  await actual.rm(root, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const source = join(root, "source");
  const homeA = join(root, "home-a"),
    homeB = join(root, "home-b");
  await fs.mkdir(source);
  process.env.PLANWEAVE_HOME = homeA;
  const a = await resolveProjectWorkspace(source);
  process.env.PLANWEAVE_HOME = homeB;
  const b = await resolveProjectWorkspace(source);
  const policyA = join(a.workspaceRoot, "policy", "prompt-policy.json");
  const policyB = join(b.workspaceRoot, "policy", "prompt-policy.json");
  await fs.mkdir(dirname(a.projectPromptFile), { recursive: true });
  await fs.mkdir(dirname(b.projectPromptFile), { recursive: true });
  await fs.writeFile(a.projectPromptFile, "A-policy-中🙂\n");
  await fs.writeFile(b.projectPromptFile, "B-sentinel\n");
  await fs.writeFile(policyA, '{"includeGlobalPrompt":true}\n');
  await fs.writeFile(policyB, '{"includeGlobalPrompt":false}\n');
  process.env.PLANWEAVE_HOME = homeA;
  return { source, homeA, homeB, a, b, policyA, policyB };
}
function pauseResolve() {
  const entered = deferred(),
    resume = deferred();
  vi.mocked(fs.realpath).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    return actual.realpath(...args);
  });
  return { entered, resume };
}

for (const input of ["root", "untrusted-workspace"] as const) {
  it.each([
    "write-prompt",
    "read-prompt",
    "read-bytes",
    "read-policy",
    "patch-policy"
  ] as const)(`binds ${input} %s to operation Home across actual resolution IO`, async (operation) => {
    const f = await fixture();
    const ref: PackageWorkspaceRef =
      input === "root"
        ? f.source
        : {
            ...f.a,
            planweaveHome: f.homeB,
            workspaceRoot: f.b.workspaceRoot,
            projectPromptFile: f.b.projectPromptFile
          };
    const pause = pauseResolve();
    const task =
      operation === "write-prompt"
        ? updateProjectPrompt(ref, "saved-A")
        : operation === "read-prompt"
          ? readProjectPrompt(ref)
          : operation === "read-bytes"
            ? readProjectPromptBytes(ref)
            : operation === "read-policy"
              ? readProjectPromptPolicy(ref)
              : updateProjectPromptPolicy(ref, {});
    await pause.entered.promise;
    process.env.PLANWEAVE_HOME = f.homeB;
    pause.resume.resolve();
    const result = await task;
    if (operation === "write-prompt") {
      expect(result).toBe("saved-A");
      expect(await actual.readFile(f.a.projectPromptFile, "utf8")).toBe("saved-A");
    } else if (operation === "read-prompt") expect(result).toBe("A-policy-中🙂\n");
    else if (operation === "read-bytes") expect(result).toBe(Buffer.byteLength("A-policy-中🙂\n"));
    else expect(result).toEqual({ includeGlobalPrompt: true });
    if (operation === "patch-policy") {
      expect(JSON.parse(await actual.readFile(f.policyA, "utf8"))).toEqual({
        includeGlobalPrompt: true
      });
      expect(vi.mocked(fs.rename).mock.calls.map((call) => call[1])).toEqual([f.policyA]);
    }
    expect(await actual.readFile(f.b.projectPromptFile, "utf8")).toBe("B-sentinel\n");
    expect(await actual.readFile(f.policyB, "utf8")).toBe('{"includeGlobalPrompt":false}\n');
  });
}

it("keeps policy read/patch/write failure in captured Home and preserves both committed files", async () => {
  const f = await fixture();
  const pause = pauseResolve();
  vi.mocked(fs.rename).mockRejectedValueOnce(
    Object.assign(new Error("rename failed"), { code: "EIO" })
  );
  const task = updateProjectPromptPolicy(f.source, { includeGlobalPrompt: false });
  const rejected = expect(task).rejects.toThrow("rename failed");
  await pause.entered.promise;
  process.env.PLANWEAVE_HOME = f.homeB;
  pause.resume.resolve();
  await rejected;
  expect(vi.mocked(fs.rename).mock.calls.map((call) => call[1])).toEqual([f.policyA]);
  expect(await actual.readFile(f.policyA, "utf8")).toBe('{"includeGlobalPrompt":true}\n');
  expect(await actual.readFile(f.policyB, "utf8")).toBe('{"includeGlobalPrompt":false}\n');
  expect((await actual.readdir(dirname(f.policyA))).sort()).toEqual([
    "project-prompt.md",
    "prompt-policy.json"
  ]);
});

it("does not read another Home's valid policy when captured policy is corrupt", async () => {
  const f = await fixture();
  await fs.writeFile(f.policyA, "invalid-json-A");
  const pause = pauseResolve();
  const task = updateProjectPromptPolicy(f.source, { includeGlobalPrompt: false });
  const rejected = expect(task).rejects.toThrow(SyntaxError);
  await pause.entered.promise;
  process.env.PLANWEAVE_HOME = f.homeB;
  pause.resume.resolve();
  await rejected;
  expect(await actual.readFile(f.policyA, "utf8")).toBe("invalid-json-A");
  expect(await actual.readFile(f.policyB, "utf8")).toBe('{"includeGlobalPrompt":false}\n');
  expect(fs.rename).not.toHaveBeenCalled();
});

it("retains Global Prompt's already captured Home path across directory IO", async () => {
  const f = await fixture();
  const entered = deferred(),
    resume = deferred();
  vi.mocked(fs.mkdir).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    return actual.mkdir(...args);
  });
  const task = updateGlobalPrompt("global-A");
  await entered.promise;
  process.env.PLANWEAVE_HOME = f.homeB;
  resume.resolve();
  await expect(task).resolves.toBe("global-A");
  expect(await actual.readFile(join(f.homeA, "config", "global-prompt.md"), "utf8")).toBe(
    "global-A"
  );
  await expect(actual.stat(join(f.homeB, "config", "global-prompt.md"))).rejects.toMatchObject({
    code: "ENOENT"
  });
});
