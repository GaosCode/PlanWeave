import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AdvisoryLockClock,
  type AdvisoryLockFs,
  withAdvisoryDirectoryLock
} from "../fs/advisoryDirectoryLock.js";
import { DEFAULT_CANVAS_LOCK_OPERATION, withCanvasLock } from "../fs/withCanvasLock.js";
import { optionalStat } from "../fs/optionalFile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function tempLockRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "planweave-advisory-lock-"));
  tempDirs.push(dir);
  return dir;
}

function nodeFileError(code: string, message = `${code} failure`): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createMemoryFs(seed: Map<string, string | "dir"> = new Map()): {
  store: Map<string, string | "dir">;
  fs: AdvisoryLockFs;
  failWriteHolder: boolean;
  failCleanup: boolean;
  writeHolderCalls: number;
  mkdirCalls: string[];
  rmCalls: string[];
} {
  const store = new Map(seed);
  const state = {
    store,
    failWriteHolder: false,
    failCleanup: false,
    writeHolderCalls: 0,
    mkdirCalls: [] as string[],
    rmCalls: [] as string[],
    fs: null as unknown as AdvisoryLockFs
  };

  state.fs = {
    async mkdir(path) {
      state.mkdirCalls.push(path);
      if (store.has(path)) {
        throw nodeFileError("EEXIST");
      }
      store.set(path, "dir");
    },
    async writeFile(path, data) {
      if (path.endsWith("/holder.json") || path.endsWith("\\holder.json")) {
        state.writeHolderCalls += 1;
        if (state.failWriteHolder) {
          throw new Error("injected holder write failure");
        }
      }
      const parent = path.replace(/[/\\][^/\\]+$/, "");
      if (!store.has(parent) || store.get(parent) !== "dir") {
        throw nodeFileError("ENOENT", `parent missing for ${path}`);
      }
      store.set(path, data);
    },
    async readFile(path) {
      const value = store.get(path);
      if (value === undefined || value === "dir") {
        throw nodeFileError("ENOENT");
      }
      return value;
    },
    async rename(from, to) {
      if (!store.has(from) || store.has(to))
        throw nodeFileError(store.has(to) ? "EEXIST" : "ENOENT");
      const moved = [...store.entries()].filter(
        ([key]) => key === from || key.startsWith(`${from}/`) || key.startsWith(`${from}\\`)
      );
      for (const [key] of moved) store.delete(key);
      for (const [key, value] of moved) store.set(`${to}${key.slice(from.length)}`, value);
    },
    async rm(path) {
      state.rmCalls.push(path);
      if (state.failCleanup) {
        throw new Error("injected cleanup failure");
      }
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}\\`)) {
          store.delete(key);
        }
      }
    },
    async optionalStat(path) {
      if (!store.has(path)) {
        return null;
      }
      return { mtimeMs: Date.now() };
    }
  };

  return state;
}

function fastClock(overrides: Partial<AdvisoryLockClock> = {}): AdvisoryLockClock {
  let perf = 0;
  const wall = 1_000_000;
  return {
    nowMs: () => wall,
    performanceNow: () => {
      perf += 5;
      return perf;
    },
    delay: async () => {
      perf += 20;
    },
    ...overrides
  };
}

describe("advisory directory lock", () => {
  it("rolls back the lock directory when holder write fails after mkdir", async () => {
    const root = await tempLockRoot();
    const lockPath = join(root, ".planweave.lock");
    let writeCount = 0;

    const fsAdapter: AdvisoryLockFs = {
      mkdir: async (path) => {
        await mkdir(path);
      },
      writeFile: async (path, data, encoding) => {
        if (path.endsWith("holder.json")) {
          writeCount += 1;
          throw new Error("injected holder write failure");
        }
        await writeFile(path, data, encoding);
      },
      readFile: async (path, encoding) => readFile(path, encoding),
      rename: async (from, to) => {
        const { rename } = await import("node:fs/promises");
        await rename(from, to);
      },
      rm: async (path, options) => {
        await rm(path, options);
      },
      optionalStat
    };

    await expect(
      withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "test-holder-write-fail",
          timeoutMs: 100,
          retryDelayMs: 1,
          fs: fsAdapter,
          clock: fastClock()
        },
        async () => "should-not-run"
      )
    ).rejects.toThrow("injected holder write failure");

    expect(writeCount).toBe(1);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves both holder write failure and cleanup failure as AggregateError", async () => {
    const mem = createMemoryFs();
    mem.failWriteHolder = true;
    mem.failCleanup = true;
    const lockPath = "/virtual/.planweave.lock";

    let error: unknown;
    try {
      await withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "test-double-failure",
          timeoutMs: 50,
          retryDelayMs: 1,
          fs: mem.fs,
          clock: fastClock()
        },
        async () => "should-not-run"
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toContain("cleanup of newly created lock also failed");
    expect(aggregate.errors).toHaveLength(2);
    expect(String(aggregate.errors[0])).toContain("injected holder write failure");
    expect(String(aggregate.errors[1])).toContain("injected cleanup failure");
    // Lock directory remains because cleanup failed — evidence for operators.
    expect(mem.store.has(lockPath)).toBe(true);
  });

  it("records non-empty operation on holder and uses canvas default when omitted", async () => {
    const root = await tempLockRoot();
    let holderRaw = "";

    await withCanvasLock(root, async () => {
      holderRaw = await readFile(join(root, ".planweave.lock", "holder.json"), "utf8");
    });

    const holder = JSON.parse(holderRaw) as {
      pid: number;
      acquiredAt: string;
      operation: string;
    };
    expect(holder.pid).toBe(process.pid);
    expect(typeof holder.acquiredAt).toBe("string");
    expect(holder.operation).toBe(DEFAULT_CANVAS_LOCK_OPERATION);

    await withCanvasLock(
      root,
      async () => {
        holderRaw = await readFile(join(root, ".planweave.lock", "holder.json"), "utf8");
      },
      { operation: "claim-next" }
    );
    expect(JSON.parse(holderRaw).operation).toBe("claim-next");

    await withCanvasLock(
      root,
      async () => {
        holderRaw = await readFile(join(root, ".planweave.lock", "holder.json"), "utf8");
      },
      { operation: "   " }
    );
    expect(JSON.parse(holderRaw).operation).toBe(DEFAULT_CANVAS_LOCK_OPERATION);
  });

  it("rejects empty operation on the primitive", async () => {
    await expect(
      withAdvisoryDirectoryLock(
        { lockPath: "/virtual/lock", operation: "  " },
        async () => undefined
      )
    ).rejects.toThrow(/non-empty string/);
  });

  it("does not reclaim a fresh lock held by a live pid", async () => {
    const lockPath = "/virtual/.planweave.lock";
    const holder = {
      pid: 4242,
      acquiredAt: new Date(1_000_000).toISOString(),
      operation: "holder-work"
    };
    const mem = createMemoryFs(
      new Map([
        [lockPath, "dir"],
        [join(lockPath, "holder.json"), `${JSON.stringify(holder, null, 2)}\n`]
      ])
    );

    let perf = 0;
    const clock: AdvisoryLockClock = {
      nowMs: () => 1_000_000 + 1_000,
      performanceNow: () => {
        const value = perf;
        perf += 30;
        return value;
      },
      delay: async () => {
        perf += 30;
      }
    };

    await expect(
      withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "waiter",
          timeoutMs: 90,
          staleMs: 60_000,
          retryDelayMs: 1,
          pid: 99,
          isPidAlive: (pid) => pid === 4242,
          fs: mem.fs,
          clock
        },
        async () => "should-not-run"
      )
    ).rejects.toThrow(/Timed out acquiring directory lock/);

    // Active holder lock was not reclaimed.
    expect(mem.store.has(lockPath)).toBe(true);
    expect(mem.rmCalls).toHaveLength(0);
  });

  it("reclaims a stale lock when holder pid is dead", async () => {
    const lockPath = "/virtual/.planweave.lock";
    const holder = {
      pid: 7777,
      acquiredAt: new Date(1_000_000).toISOString(),
      operation: "dead-holder"
    };
    const mem = createMemoryFs(
      new Map([
        [lockPath, "dir"],
        [join(lockPath, "holder.json"), `${JSON.stringify(holder, null, 2)}\n`]
      ])
    );
    mem.fs.optionalStat = async () => ({ mtimeMs: 1_000_000 });

    let wall = 1_000_000 + 120_000;
    const order: string[] = [];

    await withAdvisoryDirectoryLock(
      {
        lockPath,
        operation: "reclaimer",
        timeoutMs: 200,
        staleMs: 60_000,
        retryDelayMs: 1,
        pid: 11,
        isPidAlive: () => false,
        fs: mem.fs,
        clock: {
          nowMs: () => wall,
          performanceNow: () => wall,
          delay: async () => {
            wall += 1;
          }
        }
      },
      async () => {
        order.push("critical");
        return "ok";
      }
    );

    expect(order).toEqual(["critical"]);
    expect(mem.rmCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("reclaims a stale lock when holder is unreadable", async () => {
    const lockPath = "/virtual/.planweave.lock";
    const mem = createMemoryFs(new Map([[lockPath, "dir"]]));
    // No holder.json at all.
    mem.fs.optionalStat = async () => ({ mtimeMs: 1_000_000 });
    let wall = 1_000_000 + 120_000;

    await expect(
      withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "reclaim-missing-holder",
          timeoutMs: 200,
          staleMs: 60_000,
          retryDelayMs: 1,
          fs: mem.fs,
          clock: {
            nowMs: () => wall,
            performanceNow: () => wall,
            delay: async () => {
              wall += 1;
            }
          }
        },
        async () => "reclaimed"
      )
    ).resolves.toBe("reclaimed");
  });

  it("includes holder diagnostics in timeout errors", async () => {
    const lockPath = "/virtual/.planweave.lock";
    const acquiredAt = new Date(1_000_000).toISOString();
    const holder = {
      pid: 5555,
      acquiredAt,
      operation: "long-running-mutation"
    };
    const mem = createMemoryFs(
      new Map([
        [lockPath, "dir"],
        [join(lockPath, "holder.json"), `${JSON.stringify(holder, null, 2)}\n`]
      ])
    );
    mem.fs.optionalStat = async () => ({ mtimeMs: 1_000_000 });

    let perf = 0;
    await expect(
      withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "status-read",
          timeoutMs: 80,
          staleMs: 60_000,
          retryDelayMs: 1,
          isPidAlive: (pid) => pid === 5555,
          fs: mem.fs,
          clock: {
            nowMs: () => 1_000_000 + 5_000,
            performanceNow: () => {
              const value = perf;
              perf += 40;
              return value;
            },
            delay: async () => {
              perf += 40;
            }
          }
        },
        async () => undefined
      )
    ).rejects.toThrow(
      /Timed out acquiring directory lock at \/virtual\/\.planweave\.lock; after \d+ms; requested operation=status-read; holder pid=5555; holder operation=long-running-mutation; holder acquiredAt=.*; holder age=5000ms; holder pidAlive=true; lock age=5000ms/
    );
  });

  it("states clearly when timeout cannot read holder", async () => {
    const lockPath = "/virtual/.planweave.lock";
    const mem = createMemoryFs(new Map([[lockPath, "dir"]]));
    mem.fs.optionalStat = async () => ({ mtimeMs: 1_000_000 });
    // Corrupt holder content.
    mem.store.set(join(lockPath, "holder.json"), "{not-json");

    let perf = 0;
    let message = "";
    try {
      await withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "diagnose",
          timeoutMs: 60,
          staleMs: 60_000,
          retryDelayMs: 1,
          fs: mem.fs,
          clock: {
            nowMs: () => 1_000_000 + 2_000,
            performanceNow: () => {
              const value = perf;
              perf += 40;
              return value;
            },
            delay: async () => {
              perf += 40;
            }
          }
        },
        async () => undefined
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("requested operation=diagnose");
    expect(message).toContain("holder unreadable");
    expect(message).toMatch(/invalid|JSON/i);
    expect(message).toContain("lock age=2000ms");
  });

  it("allows nested reentry in the same async context", async () => {
    const root = await tempLockRoot();
    const order: string[] = [];

    await withCanvasLock(root, async () => {
      order.push("outer-enter");
      await withCanvasLock(root, async () => {
        order.push("inner");
      });
      order.push("outer-exit");
    });

    expect(order).toEqual(["outer-enter", "inner", "outer-exit"]);
  });

  it("serializes same-process waiters for one lock path", async () => {
    const root = await tempLockRoot();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withCanvasLock(root, async () => {
      order.push("first-enter");
      await firstGate;
      order.push("first-exit");
      return 1;
    });

    // Wait until first holds the lock, then queue second waiter.
    await vi.waitFor(() => {
      expect(order).toContain("first-enter");
    });

    const second = withCanvasLock(root, async () => {
      order.push("second");
      return 2;
    });

    // Second must not have entered while first still holds.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-enter"]);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first-enter", "first-exit", "second"]);
  });

  it("does not let a non-owner mkdir failure clean up an existing lock", async () => {
    const lockPath = "/virtual/.planweave.lock";
    const holder = {
      pid: 9,
      acquiredAt: new Date().toISOString(),
      operation: "owner"
    };
    const mem = createMemoryFs(
      new Map([
        [lockPath, "dir"],
        [join(lockPath, "holder.json"), `${JSON.stringify(holder, null, 2)}\n`]
      ])
    );

    let perf = 0;
    await expect(
      withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "contender",
          timeoutMs: 50,
          staleMs: 60_000,
          retryDelayMs: 1,
          isPidAlive: () => true,
          fs: mem.fs,
          clock: {
            nowMs: () => Date.now(),
            performanceNow: () => {
              const value = perf;
              perf += 30;
              return value;
            },
            delay: async () => {
              perf += 30;
            }
          }
        },
        async () => undefined
      )
    ).rejects.toThrow(/Timed out/);

    // Contender never created the dir; must not have removed the owner's lock.
    expect(mem.store.has(lockPath)).toBe(true);
    expect(mem.rmCalls).toHaveLength(0);
  });

  it("does not delete a replacement owner after a stale-lock ABA", async () => {
    const lockPath = "/virtual/.planweave.lock";
    const holderPath = join(lockPath, "holder.json");
    const staleHolder = {
      pid: 7,
      acquiredAt: new Date(1_000_000).toISOString(),
      operation: "stale-owner",
      ownerToken: "stale-token"
    };
    const replacementHolder = {
      pid: 8,
      acquiredAt: new Date(1_120_000).toISOString(),
      operation: "replacement-owner",
      ownerToken: "replacement-token"
    };
    const mem = createMemoryFs(
      new Map([
        [lockPath, "dir"],
        [holderPath, `${JSON.stringify(staleHolder)}\n`]
      ])
    );
    mem.fs.optionalStat = async () => ({ mtimeMs: 1_000_000 });
    const originalRename = mem.fs.rename;
    let replacedBeforeFence = false;
    mem.fs.rename = async (from, to) => {
      if (from === lockPath && !replacedBeforeFence) {
        replacedBeforeFence = true;
        mem.store.set(holderPath, `${JSON.stringify(replacementHolder)}\n`);
      }
      await originalRename(from, to);
    };

    let perf = 0;
    await expect(
      withAdvisoryDirectoryLock(
        {
          lockPath,
          operation: "stale-reclaimer",
          timeoutMs: 80,
          staleMs: 60_000,
          retryDelayMs: 1,
          isPidAlive: () => false,
          fs: mem.fs,
          clock: {
            nowMs: () => 1_120_000,
            performanceNow: () => (perf += 30),
            delay: async () => {
              perf += 30;
            }
          }
        },
        async () => undefined
      )
    ).rejects.toThrow(/Timed out/);

    expect(JSON.parse(mem.store.get(holderPath) as string)).toMatchObject({
      ownerToken: "replacement-token"
    });
    expect(replacedBeforeFence).toBe(true);
    expect(mem.rmCalls).toHaveLength(0);
  });
});
