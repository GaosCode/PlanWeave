import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const eventSchema = z
  .object({ event: z.string(), actor: z.string(), pid: z.number().int().positive() })
  .passthrough();
export type ActorEvent = z.infer<typeof eventSchema>;
export function observeActor(child: ChildProcess) {
  const events: ActorEvent[] = [];
  const pending = new Map<
    string,
    { resolve(value: ActorEvent): void; reject(error: Error): void }
  >();
  let stderr = "";
  let exited: Error | undefined;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (raw) => {
    const event = eventSchema.parse(raw);
    events.push(event);
    pending.get(event.event)?.resolve(event);
    pending.delete(event.event);
  });
  const done = once(child, "close").then(([code, signal]) => {
    exited = new Error(`Actor exited code=${String(code)} signal=${String(signal)}: ${stderr}`);
    for (const waiter of pending.values()) waiter.reject(exited);
    pending.clear();
    return { code, signal, stderr };
  });
  return {
    child,
    events,
    done,
    wait(event: string) {
      const known = events.find((item) => item.event === event);
      if (known) return Promise.resolve(known);
      if (exited) return Promise.reject(exited);
      return new Promise<ActorEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(event);
          reject(new Error(`Actor barrier timed out: ${event}; ${stderr}`));
        }, 5000);
        pending.set(event, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    },
    send(command: string) {
      child.send(command);
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    }
  };
}
export async function runThreeProcessRace(root: string, moduleUrl: string, legacy = false) {
  const lockPath = join(root, "lock");
  const token = randomUUID();
  const oldName = `lease-v2-2147483647-${token}`;
  await mkdir(lockPath);
  const holderPath = legacy
    ? join(lockPath, "holder.json")
    : join(lockPath, oldName, "holder.json");
  if (!legacy) await mkdir(join(lockPath, oldName));
  await writeFile(
    holderPath,
    JSON.stringify({
      ...(legacy ? {} : { version: 2 }),
      pid: 2147483647,
      ownerToken: token,
      operation: "dead-seed",
      acquiredAt: new Date().toISOString()
    })
  );
  const actors: ReturnType<typeof observeActor>[] = [];
  function launch(actor: string) {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./advisoryLockActor.mjs", import.meta.url)),
        JSON.stringify({ actor, root, lockPath, moduleUrl, oldName })
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] }
    );
    const client = observeActor(child);
    actors.push(client);
    return client;
  }
  try {
    const A = launch("A");
    assert.equal((await A.wait("before-cleanup")).observedOldOwner, true);
    const B = launch("B");
    const bEntry = await B.wait("entered");
    assert.equal(bEntry.exclusive, true);
    const identityBefore = await readFile(
      legacy
        ? join(lockPath, "holder.json")
        : join(lockPath, (await readdir(lockPath))[0], "holder.json"),
      "utf8"
    );
    A.send("resume-cleanup");
    await A.wait("after-cleanup");
    const C = launch("C");
    if (legacy) {
      assert.equal(
        (await C.wait("entered")).exclusive,
        false,
        "old version must overlap the independent occupied sentinel"
      );
    } else {
      await C.wait("contended");
      assert.equal(
        await readFile(join(lockPath, (await readdir(lockPath))[0], "holder.json"), "utf8"),
        identityBefore,
        "delayed old cleanup must preserve the current owner's actual path and bytes"
      );
    }
    A.send("finish-cleanup");
    if (!legacy) await A.wait("blocked-after-cleanup");
    B.send("release");
    assert.equal((await B.done).code, 0);
    if (!legacy) A.send("release");
    C.send("release");
    const [aResult, cResult] = await Promise.all([A.done, C.done]);
    assert.equal(cResult.code, 0);
    if (!legacy) assert.equal(aResult.code, 0);
    const trace = (await readFile(join(root, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        z
          .object({
            event: z.enum(["enter", "exit"]),
            actor: z.string(),
            pid: z.number(),
            exclusive: z.boolean().optional()
          })
          .parse(JSON.parse(line))
      );
    let active = 0,
      maximum = 0;
    for (const event of trace) {
      active += event.event === "enter" ? 1 : -1;
      maximum = Math.max(maximum, active);
      assert(active >= 0);
      if (!legacy && event.event === "enter") assert.equal(event.exclusive, true);
    }
    assert.equal(active, 0);
    assert.equal(maximum, legacy ? 2 : 1);
    assert.equal(new Set(actors.map((actor) => actor.child.pid)).size, 3);
    return {
      maximum,
      trace,
      pids: actors.map((actor) => actor.child.pid),
      aFailed: aResult.code !== 0
    };
  } finally {
    await Promise.all(actors.map((actor) => actor.stop()));
  }
}
