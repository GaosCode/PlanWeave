import { watch } from "node:fs";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runFixedArgv } from "../background/processRunner.js";

it("ends the real status subprocess before returning a timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "planweave-query-process-"));
  try {
    const pidPath = join(root, "pid");
    const script =
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 500);";
    await expect(
      runFixedArgv(process.execPath, ["-e", script, pidPath], { budgetMs: 150 })
    ).rejects.toThrow("agent_host_background_query_timeout");
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("cancels a started real child and removes its abort listener after process close", async () => {
  const root = await mkdtemp(join(tmpdir(), "planweave-query-cancel-"));
  const controller = new AbortController();
  const pidPath = join(root, "pid");
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    const started = new Promise<void>((resolve, reject) => {
      watcher = watch(root, { persistent: false }, (_event, file) => {
        if (file === "pid") {
          void readFile(pidPath, "utf8").then((value) => {
            if (Number(value) > 0) resolve();
          }, reject);
        }
      });
      watcher.once("error", reject);
    });
    const result = runFixedArgv(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);",
        pidPath
      ],
      { budgetMs: 5_000, signal: controller.signal }
    );
    const cancelled = expect(result).rejects.toThrow("agent_host_background_query_cancelled");
    await Promise.race([
      started,
      result.then(() => {
        throw new Error("query process exited before readiness");
      })
    ]);
    watcher?.close();
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await cancelled;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    controller.abort();
    watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  "pre-aborted",
  "expired-deadline"
])("does not spawn a command with a %s owner", async (reason) => {
  const root = await mkdtemp(join(tmpdir(), "planweave-query-no-spawn-"));
  try {
    const marker = join(root, "spawned");
    const controller = new AbortController();
    if (reason === "pre-aborted") controller.abort();
    await expect(
      runFixedArgv(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync(process.argv[1], 'spawned');", marker],
        {
          signal: controller.signal,
          ...(reason === "expired-deadline" ? { deadline: Date.now() - 1 } : {})
        }
      )
    ).rejects.toThrow(
      reason === "pre-aborted"
        ? "agent_host_background_query_cancelled"
        : "agent_host_background_query_timeout"
    );
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("releases its listener after normal completion and preserves fixed argv and environment", async () => {
  const controller = new AbortController();
  const value = "literal $() argument with spaces";
  const result = await runFixedArgv(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify([process.argv[1], process.env.PLANWEAVE_QUERY_TEST]));",
      value
    ],
    { budgetMs: 1_000, signal: controller.signal, environment: { PLANWEAVE_QUERY_TEST: "marker" } }
  );
  expect(JSON.parse(result.stdout)).toEqual([value, "marker"]);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  controller.abort();
});
