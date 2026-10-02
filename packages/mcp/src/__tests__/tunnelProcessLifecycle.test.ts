import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTunnelClientBinaryStartTarget, TunnelClientProcessManager } from "../tunnel.js";

const roots: string[] = [];
const managers: TunnelClientProcessManager[] = [];
const starts: Promise<unknown>[] = [];
const boundary = vi.hoisted(() => ({
  beforeHealthDirectory: null as Promise<void> | null,
  release: null as (() => void) | null,
  directoryEntered: false
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      if (prefix.includes("planweave-tunnel-health-") && boundary.beforeHealthDirectory) {
        boundary.directoryEntered = true;
        await boundary.beforeHealthDirectory;
      }
      return actual.mkdtemp(prefix);
    }
  };
});

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Fixture observation timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(
  options: {
    holdInit?: boolean;
    holdReady?: boolean;
    holdHealthUrl?: boolean;
    failInitOnce?: boolean;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "pw-tunnel-lifecycle-"));
  roots.push(root);
  await writeFile(join(root, "options.json"), JSON.stringify(options));
  const path = join(root, "tunnel-client");
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const root = __dirname;
const mode = process.argv[2];
if (mode === "--version") { console.log("fixture tunnel-client"); process.exit(0); }
const options = JSON.parse(fs.readFileSync(path.join(root,"options.json"),"utf8"));
fs.appendFileSync(path.join(root,"events"), JSON.stringify({mode,pid:process.pid})+"\\n");
process.on("SIGTERM",()=>process.exit(0));
if (mode === "init") {
  if (options.failInitOnce && !fs.existsSync(path.join(root,"failed"))) {
    fs.writeFileSync(path.join(root,"failed"),"failed");process.exit(2);
  }
  if (!options.holdInit) process.exit(0);
  setInterval(()=>{if(fs.existsSync(path.join(root,"release")))process.exit(0);},10);
} else if (mode === "run") {
  const server=http.createServer((req,res)=>{
    fs.appendFileSync(path.join(root,"requests"),req.url+"\\n");
    if (!options.holdReady) res.end("ok");
  });
  server.listen(0,"127.0.0.1",()=>{
    const index=process.argv.indexOf("--health.url-file");
    if (!options.holdHealthUrl) fs.writeFileSync(process.argv[index+1],"http://127.0.0.1:"+server.address().port);
  });
} else process.exit(2);
`
  );
  await chmod(path, 0o700);
  const binary = await resolveTunnelClientBinaryStartTarget(path);
  const manager = new TunnelClientProcessManager({ readyTimeoutMs: 500 });
  managers.push(manager);
  const events = async (): Promise<{ mode: string; pid: number }[]> => {
    try {
      return (await readFile(join(root, "events"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  };
  const start = () => {
    const pending = manager.start({
      binary,
      localMcpEndpoint: "http://127.0.0.1:8787/mcp",
      input: { tunnelId: "fixture-tunnel", runtimeApiKey: "fixture-key" }
    });
    starts.push(pending);
    return pending;
  };
  return { root, manager, events, start };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

afterEach(async () => {
  boundary.release?.();
  boundary.release = null;
  boundary.beforeHealthDirectory = null;
  boundary.directoryEntered = false;
  // Release only this suite's disposable children if a pre-fix assertion fails.
  await Promise.all(roots.map((root) => writeFile(join(root, "release"), "release")));
  for (const root of roots) {
    let events = "";
    try {
      events = await readFile(join(root, "events"), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const line of events.trim().split("\n").filter(Boolean)) {
      const event: { pid: number } = JSON.parse(line);
      if (alive(event.pid)) process.kill(event.pid, "SIGTERM");
    }
  }
  await Promise.all(managers.map((manager) => manager.stop()));
  await Promise.allSettled(starts.splice(0));
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.mocked(spawn).mockClear();
});

describe("Tunnel process start cancellation with real children", () => {
  it("cancels and drains init before stop returns without launching run", async () => {
    const f = await fixture({ holdInit: true });
    const pending = f.start();
    await eventually(async () => (await f.events()).some((event) => event.mode === "init"));
    const init = (await f.events()).find((event) => event.mode === "init");
    expect(init).toBeDefined();
    await f.manager.stop();
    expect(alive(init!.pid)).toBe(false);
    expect((await pending).phase).toBe("stopped");
    expect((await f.events()).filter((event) => event.mode === "run")).toEqual([]);
    expect(f.manager.getStatus().phase).toBe("stopped");
  });

  it("reuses a pending start and creates one init and one run", async () => {
    const f = await fixture({ holdInit: true });
    const first = f.start();
    const second = f.start();
    await eventually(async () => (await f.events()).some((event) => event.mode === "init"));
    await writeFile(join(f.root, "release"), "release");
    expect((await first).phase).toBe("running");
    expect((await second).phase).toBe("running");
    expect((await f.events()).filter((event) => event.mode === "init")).toHaveLength(1);
    expect((await f.events()).filter((event) => event.mode === "run")).toHaveLength(1);
    await f.manager.stop();
  });

  it("aborts an in-flight real readiness HTTP request and drains its child", async () => {
    const f = await fixture({ holdReady: true });
    const pending = f.start();
    await eventually(async () => {
      try {
        return (await readFile(join(f.root, "requests"), "utf8")).includes("/readyz");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    });
    const child = (await f.events()).find((event) => event.mode === "run");
    expect(child).toBeDefined();
    await f.manager.stop();
    expect((await pending).phase).toBe("stopped");
    expect(alive(child!.pid)).toBe(false);
    expect(f.manager.getStatus().phase).toBe("stopped");
  });

  it("drains pre-spawn filesystem work and does not launch run after cancellation", async () => {
    const f = await fixture();
    let release!: () => void;
    boundary.beforeHealthDirectory = new Promise<void>((resolve) => {
      release = resolve;
    });
    boundary.release = release;
    const starting = f.start();
    await eventually(async () => (await f.events()).some((event) => event.mode === "init"));
    await vi.waitFor(() => expect(boundary.directoryEntered).toBe(true));
    let stopped = false;
    const stopping = f.manager.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect((await starting).phase).toBe("stopped");
    expect((await f.events()).filter((event) => event.mode === "run")).toEqual([]);
  });

  it("cancels health URL polling and has no child or delayed status after stop", async () => {
    const f = await fixture({ holdHealthUrl: true });
    const starting = f.start();
    await eventually(async () => (await f.events()).some((event) => event.mode === "run"));
    const child = (await f.events()).find((event) => event.mode === "run");
    await f.manager.stop();
    expect((await starting).phase).toBe("stopped");
    expect(alive(child!.pid)).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.manager.getStatus().phase).toBe("stopped");
  });

  it("queues a new generation behind repeated stop and ignores retired child signals", async () => {
    const f = await fixture();
    const first = await f.start();
    expect(first.phase).toBe("running");
    const old = vi.mocked(spawn).mock.results.at(-1)?.value;
    expect(old).toBeDefined();
    const stopping = f.manager.stop();
    const duplicate = f.manager.stop();
    const restart = f.start();
    await Promise.all([stopping, duplicate]);
    expect(alive(first.pid!)).toBe(false);
    const next = await restart;
    expect(next.phase).toBe("running");
    expect(next.pid).not.toBe(first.pid);
    old!.emit("exit", 2, null);
    old!.emit("error", new Error("retired-child-error"));
    expect(f.manager.getStatus()).toEqual(next);
    await f.manager.stop();
    expect(alive(next.pid!)).toBe(false);
  });

  it("retries after a failed init without retaining its child", async () => {
    const f = await fixture({ failInitOnce: true });
    const failed = await f.start();
    expect(failed.phase).toBe("error");
    expect(failed.pid).toBeNull();
    const init = (await f.events()).find((event) => event.mode === "init");
    expect(alive(init!.pid)).toBe(false);
    expect((await f.start()).phase).toBe("running");
    expect((await f.events()).filter((event) => event.mode === "init")).toHaveLength(2);
    await f.manager.stop();
  });

  it("publishes an actual current child exit and observes current errors", async () => {
    const f = await fixture();
    const running = await f.start();
    const child = vi.mocked(spawn).mock.results.at(-1)?.value;
    child!.emit("error", new Error("current-child-error"));
    expect(f.manager.getStatus().phase).toBe("error");
    expect(f.manager.getStatus().error).toBe("current-child-error");
    await f.manager.stop();
    expect(alive(running.pid!)).toBe(false);
    const restarted = await f.start();
    process.kill(restarted.pid!, "SIGTERM");
    await eventually(async () => f.manager.getStatus().pid === null);
    expect(f.manager.getStatus().phase).toBe("stopped");
    expect(alive(restarted.pid!)).toBe(false);
  });
});
