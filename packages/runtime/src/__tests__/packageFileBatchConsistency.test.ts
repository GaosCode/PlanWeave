import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readPackageFileInventory,
  readPackageFiles,
  readSelectedPackageFiles
} from "../package/packageFiles.js";
import { withPackageFileConsistency } from "../package/packageFileConsistency.js";

import {
  spawnPackageMutation,
  holdPackageLock,
  type Actor
} from "./helpers/packageBatchProcessFixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    open: vi.fn(actual.open),
    realpath: vi.fn(actual.realpath)
  };
});
const exec = promisify(execFile);

const dist = new URL("../../dist/", import.meta.url).href;
let actual: typeof fs;
let parent: string;
let root: string;
const actors: Actor[] = [];
beforeEach(async () => {
  actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.realpath).mockReset().mockImplementation(actual.realpath);
  parent = await actual.mkdtemp(join(tmpdir(), "planweave-batch-consistency-"));
  root = join(parent, "canvas", "package");
  await writeVersion(root, "old");
});
afterEach(async () => {
  for (const actor of actors.splice(0)) {
    if (actor.child.exitCode === null) actor.child.stdin.end();
    const result = await actor.done;
    expect(result.code, result.stderr).toBe(0);
  }
  vi.restoreAllMocks();
  await actual.rm(parent, { recursive: true, force: true });
});
async function writeVersion(target: string, version: "old" | "new"): Promise<void> {
  await actual.mkdir(target, { recursive: true });
  await actual.writeFile(join(target, "a.md"), `${version}-A`);
  await actual.writeFile(join(target, "b.md"), version === "old" ? "old-B" : "new-B-long");
}
async function replaceInChild(): Promise<void> {
  await exec(process.execPath, [
    "--input-type=module",
    "-e",
    `
    const { replacePackageFiles } = await import(${JSON.stringify(`${dist}package/packageFiles.js`)});
    await replacePackageFiles(process.argv[1], [
      { path: 'a.md', content: 'new-A', encoding: 'utf8' },
      { path: 'b.md', content: 'new-B-long', encoding: 'utf8' }
    ]);
  `,
    root
  ]);
}
const readers = {
  full: () => readPackageFiles(root),
  selected: () => readSelectedPackageFiles(root, ["a.md", "b.md", "a.md"]),
  inventory: () => readPackageFileInventory(root)
};
type Intent = keyof typeof readers;
const expectedOld = {
  full: [
    { path: "a.md", content: "old-A", encoding: "utf8" },
    { path: "b.md", content: "old-B", encoding: "utf8" }
  ],
  selected: [
    { path: "a.md", content: "old-A", encoding: "utf8" },
    { path: "b.md", content: "old-B", encoding: "utf8" },
    { path: "a.md", content: "old-A", encoding: "utf8" }
  ],
  inventory: [
    { path: "a.md", contentBytes: 5, encoding: "utf8" },
    { path: "b.md", contentBytes: 5, encoding: "utf8" }
  ]
};

function startActor(kind: "replace" | "canvas-aba" | "import-aba", childTemp?: string): Actor {
  const actor = spawnPackageMutation(root, kind, childTemp);
  actors.push(actor);
  return actor;
}

function afterBodyRead(intent: Intent, callback: (path: string) => Promise<void>): void {
  if (intent !== "inventory") {
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      const result = await actual.readFile(...args);
      await callback(String(args[0]));
      return result;
    });
    return;
  }
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle);
    let invoked = false;
    vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
      const result = await read(...readArgs);
      if (!invoked && result.bytesRead > 0) {
        invoked = true;
        await callback(String(args[0]));
      }
      return result;
    });
    return handle;
  });
}
function interleave(intent: Intent, kind: "replace" | "canvas-aba" | "import-aba") {
  let actor: ReturnType<typeof startActor> | undefined;
  afterBodyRead(intent, async (path) => {
    if (!actor && path === join(root, "a.md")) {
      actor = startActor(kind);
      await actor.ready;
    } else if (actor && path === join(root, "b.md") && kind !== "replace") {
      actor.child.stdin.write("continue\n");
      if (!actor.observedHeld) expect((await actor.done).code).toBe(0);
    }
  });
  return () => actor;
}

describe("package batches and real process mutations", () => {
  it.each<Intent>([
    "full",
    "selected",
    "inventory"
  ])("keeps %s entirely old while a child replaces the package", async (intent) => {
    const actor = interleave(intent, "replace");
    expect(await readers[intent]()).toEqual(expectedOld[intent]);
    expect(actor()?.observedHeld).toBe(true);
    expect((await actor()?.done)?.code).toBe(0);
    expect(await actual.readFile(join(root, "b.md"), "utf8")).toBe("new-B-long");
  });
  it.each<Intent>([
    "full",
    "selected",
    "inventory"
  ])("keeps %s old across production canvas quarantine/replace/restore ABA", async (intent) => {
    const initial = await actual.stat(root, { bigint: true });
    const actor = interleave(intent, "canvas-aba");
    expect(await readers[intent]()).toEqual(expectedOld[intent]);
    expect((await actor()?.done)?.code).toBe(0);
    expect((await actual.stat(root, { bigint: true })).ino).toBe(initial.ino);
  });
  it.each([
    "a.md",
    "b.md"
  ])("protects selected %s path validation before the body batch", async (path) => {
    let actor: ReturnType<typeof startActor> | undefined;
    vi.mocked(fs.realpath).mockImplementation(async (...args) => {
      const result = await actual.realpath(...args);
      if (!actor && String(args[0]) === join(root, path)) {
        actor = startActor("replace");
        await actor.ready;
      }
      return result;
    });
    expect(await readers.selected()).toEqual(expectedOld.selected);
    expect((await actor?.done)?.code).toBe(0);
  });
  it("protects the complete UTF-8 inventory stream across chunks", async () => {
    const content = Buffer.concat([
      Buffer.alloc(65535, 97),
      Buffer.from("🙂中"),
      Buffer.from([255, 226, 130])
    ]);
    await actual.writeFile(join(root, "a.md"), content);
    const actor = interleave("inventory", "replace");
    expect(await readers.inventory()).toEqual([
      { path: "a.md", contentBytes: Buffer.byteLength(content.toString("utf8")), encoding: "utf8" },
      expectedOld.inventory[1]
    ]);
    expect((await actor()?.done)?.code).toBe(0);
  });
  it("protects the original package across a real import transaction and rollback", async () => {
    const actor = interleave("full", "import-aba");
    expect(await readers.full()).toEqual(expectedOld.full);
    expect((await actor()?.done)?.code).toBe(0);
    expect(await actual.readFile(join(root, "b.md"), "utf8")).toBe("old-B");
  });
  it("retains cross-process wx-lock failure, stable old reads and successful retry", async () => {
    const lockPath = join(dirname(root), ".package.replace.lock");
    const lock = await actual.open(lockPath, "wx");
    try {
      await expect(replaceInChild()).rejects.toThrow("already held or stale");
      expect(await readers.full()).toEqual(expectedOld.full);
    } finally {
      await lock.close();
      await actual.unlink(lockPath);
    }
    await replaceInChild();
    expect((await readers.full()).map((file) => file.content)).toEqual(["new-A", "new-B-long"]);
  });
  it("releases a failed reader and permits the next process replacement", async () => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error("body unavailable"), { code: "EIO" })
    );
    await expect(readers.full()).rejects.toMatchObject({ code: "EIO" });
    await replaceInChild();
    expect((await readers.selected()).map((file) => file.content)).toEqual([
      "new-A",
      "new-B-long",
      "new-A"
    ]);
  });
  it("does not reject a package because unrelated sibling canvases or temp directories change", async () => {
    afterBodyRead("full", async (path) => {
      if (path === join(root, "a.md")) {
        await writeVersion(join(parent, "sibling", "package"), "new");
        const unrelated = await actual.mkdtemp(join(tmpdir(), "planweave-unrelated-"));
        await actual.rm(unrelated, { recursive: true });
      }
    });
    expect(await readers.full()).toEqual(expectedOld.full);
  });
  it("allows a distinct canvas to finish while another canvas read is held", async () => {
    const sibling = join(parent, "sibling", "package");
    await writeVersion(sibling, "new");
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterBodyRead("full", async (path) => {
      if (path === join(root, "a.md")) {
        entered();
        await held;
      }
    });
    const first = readers.full();
    await ready;
    try {
      expect((await readPackageFiles(sibling)).map((file) => file.content)).toEqual([
        "new-A",
        "new-B-long"
      ]);
    } finally {
      release();
    }
    expect(await first).toEqual(expectedOld.full);
  });
  it("rejects uncoordinated whole-root replacement rather than returning mixed data", async () => {
    afterBodyRead("full", async (path) => {
      if (path === join(root, "a.md")) {
        await actual.rename(root, join(parent, "external-backup"));
        await writeVersion(root, "new");
      }
    });
    await expect(readers.full()).rejects.toThrow("Package read consistency");
  });
  it("deduplicates reversed multi-root lock requests and releases after an exception", async () => {
    const sibling = join(parent, "sibling", "package");
    await writeVersion(sibling, "new");
    await expect(
      withPackageFileConsistency([root, sibling, root], async () => {
        throw new Error("mutation failed");
      })
    ).rejects.toThrow("mutation failed");
    await withPackageFileConsistency([sibling, root], async () => {
      await withPackageFileConsistency([root, sibling], async () => {
        expect(await readers.full()).toEqual(expectedOld.full);
      });
    });
  });
  it("times out against a real live process holder and succeeds after its normal release", async () => {
    const holder = await holdPackageLock(root);
    try {
      await expect(readers.full()).rejects.toThrow("Timed out");
    } finally {
      holder.child.stdin.end("release\n");
      expect((await holder.done).code).toBe(0);
    }
    expect(await readers.full()).toEqual(expectedOld.full);
  }, 15_000);

  it("reclaims an aged real lock left by a terminated process without a permanent read-only state", async () => {
    const holder = await holdPackageLock(root);
    holder.child.kill("SIGKILL");
    expect((await holder.done).signal).toBe("SIGKILL");
    const key = createHash("sha256")
      .update(await actual.realpath(root))
      .digest("hex");
    const lockPath = join(userInfo().homedir, ".cache", "planweave", "package-locks", key);
    // Real disk ageing models the existing advisory lock's 60-second stale threshold.
    const aged = new Date(Date.now() - 61_000);
    await actual.utimes(lockPath, aged, aged);
    try {
      expect(await readers.full()).toEqual(expectedOld.full);
      await expect(actual.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await actual.rm(lockPath, { recursive: true, force: true });
    }
    await replaceInChild();
    expect((await readers.full()).map((file) => file.content)).toEqual(["new-A", "new-B-long"]);
  });
  it("serializes reversed multi-root requests from two real processes", async () => {
    const sibling = join(parent, "sibling", "package");
    await writeVersion(sibling, "new");
    const command = `
      import {writeFile} from 'node:fs/promises';
      import {join} from 'node:path';
      const {withPackageFileConsistency}=await import(process.argv[1]+'package/packageFileConsistency.js');
      const roots=JSON.parse(process.argv[2]);
      await withPackageFileConsistency(roots,async()=>{
        for(const root of roots)await writeFile(join(root,process.argv[3]),'committed');
      });
    `;
    await Promise.all([
      exec(process.execPath, [
        "--input-type=module",
        "-e",
        command,
        dist,
        JSON.stringify([root, sibling]),
        "first.md"
      ]),
      exec(process.execPath, [
        "--input-type=module",
        "-e",
        command,
        dist,
        JSON.stringify([sibling, root]),
        "second.md"
      ])
    ]);
    for (const target of [root, sibling])
      for (const file of ["first.md", "second.md"])
        expect(await actual.readFile(join(target, file), "utf8")).toBe("committed");
  });

  it("fails an inverse nested acquisition explicitly instead of self-deadlocking", async () => {
    const sibling = join(parent, "sibling", "package");
    await writeVersion(sibling, "new");
    const paths = await Promise.all(
      [root, sibling].map(async (path) => ({
        path,
        key: createHash("sha256")
          .update(await actual.realpath(path))
          .digest("hex")
      }))
    );
    paths.sort((left, right) => left.key.localeCompare(right.key));
    const low = paths[0],
      high = paths[1];
    if (!low || !high) throw new Error("Two real directories required");
    await withPackageFileConsistency([high.path], async () => {
      await expect(withPackageFileConsistency([low.path], async () => undefined)).rejects.toThrow(
        "lock order violation"
      );
    });
    expect(await readers.full()).toEqual(expectedOld.full);
  });
  it("shares the lock with a real writer using a different TMPDIR and configured Home", async () => {
    const alternateTemp = join(parent, "alternate-temp");
    await actual.mkdir(alternateTemp);
    let actor: Actor | undefined;
    afterBodyRead("full", async (path) => {
      if (!actor && path === join(root, "a.md")) {
        actor = startActor("replace", alternateTemp);
        await actor.ready;
      }
    });
    expect(await readers.full()).toEqual(expectedOld.full);
    expect(actor?.observedHeld).toBe(true);
    expect((await actor?.done)?.code).toBe(0);
  });
});
