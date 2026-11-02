import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "build";
if (mode === "prepare") {
  if (process.argv[3] !== "@planweave-ai/collaboration-protocol")
    throw new Error("Build command arguments were not preserved");
  await fs.writeFile(
    join(process.env.TEST_BUILD_ROOT, `prepared-${process.env.TEST_BUILD_ACTOR}`),
    process.argv[3]
  );
} else if (mode === "owner") {
  const { withAdvisoryDirectoryLock } = await import(process.env.TEST_LOCK_MODULE);
  process.on("message", () => {});
  await withAdvisoryDirectoryLock(
    { lockPath: join(process.env.TEST_BUILD_ROOT, "lock"), operation: "external-writer" },
    (scope) =>
      scope.runManagedCommand({
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), "leader"]
      })
  );
} else if (mode === "leader") {
  const writer = spawn(process.execPath, [fileURLToPath(import.meta.url), "writer"], {
    stdio: "ignore",
    env: process.env
  });
  writer.unref();
} else {
  const root = process.env.TEST_BUILD_ROOT;
  const actor = process.env.TEST_BUILD_ACTOR ?? "writer";
  const control = createConnection({
    host: "127.0.0.1",
    port: Number(process.env.TEST_CONTROL_PORT)
  });
  await new Promise((resolve, reject) => {
    control.once("connect", resolve);
    control.once("error", reject);
  });
  function send(event, extra = {}) {
    control.write(`${JSON.stringify({ event, actor, pid: process.pid, ...extra })}\n`);
  }
  let buffer = "";
  const commands = new Set();
  const waiters = new Map();
  control.setEncoding("utf8");
  control.on("data", (chunk) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const command = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");
      if (waiters.has(command)) {
        waiters.get(command)();
        waiters.delete(command);
      } else commands.add(command);
    }
  });
  function wait(command) {
    if (commands.delete(command)) return Promise.resolve();
    return new Promise((resolve) => waiters.set(command, resolve));
  }
  if (mode === "writer") {
    send("writer-ready");
    await wait("write");
    await fs.writeFile(join(root, "written.tmp"), "writer survived owner");
    await fs.rename(join(root, "written.tmp"), join(root, "written"));
    send("written");
  } else {
    if (
      (await fs.readFile(join(root, `prepared-${actor}`), "utf8")) !==
      "@planweave-ai/collaboration-protocol"
    )
      throw new Error("Build preparation did not complete");
    const sentinel = join(root, "build-occupied");
    await (await fs.open(sentinel, "wx")).close();
    await fs.appendFile(
      join(root, "build-trace.jsonl"),
      `${JSON.stringify({ event: "enter", actor, pid: process.pid })}\n`
    );
    send("build-entered", { store: process.env.PLANWEAVE_BUILD_STORE_DIR });
    await wait("release");
    const file = join(root, "registry.json");
    let registry = [];
    try {
      registry = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    registry.push(actor);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(registry));
    await fs.rename(`${file}.tmp`, file);
    await fs.appendFile(
      join(root, "build-trace.jsonl"),
      `${JSON.stringify({ event: "exit", actor, pid: process.pid })}\n`
    );
    await fs.unlink(sentinel);
    send("build-left");
  }
  control.end();
}
