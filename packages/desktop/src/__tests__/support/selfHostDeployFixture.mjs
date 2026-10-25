import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.STORE_TEST_ROOT;
const args = process.argv.slice(2);
if (args[0] === "writer") {
  const store = args[1];
  const parentPid = process.ppid;
  const control = createConnection({
    host: "127.0.0.1",
    port: Number(process.env.TEST_CONTROL_PORT)
  });
  await once(control, "connect");
  const send = (event) =>
    control.write(`${JSON.stringify({ event, actor: "writer", pid: process.pid })}\n`);
  const released = new Promise((resolve) => {
    control.on("data", (chunk) => {
      if (chunk.toString().includes("release")) resolve();
    });
  });
  process.once("disconnect", async () => {
    while (true) {
      try {
        process.kill(parentPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") break;
        throw error;
      }
      await new Promise(setImmediate);
    }
    send("parent-terminal");
  });
  send("ready");
  process.send("ready");
  await released;
  await writeFile(join(store, "last-writer-byte"), "writer completed");
  await writeFile(join(root, "writer-terminal"), "completed");
  send("writer-terminal");
  control.end();
} else if (args.includes("deploy")) {
  const store = args[args.indexOf("--store-dir") + 1];
  await writeFile(join(root, "store-path"), store);
  await writeFile(join(store, "owned-store"), "deploy bytes");
  if (process.env.STORE_TEST_WRITER === "1") {
    const writer = spawn(process.execPath, [process.argv[1], "writer", store], {
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    await once(writer, "message");
    process.stdout.write(`WRITER_READY ${JSON.stringify({ pid: writer.pid, store })}\n`);
    writer.disconnect();
  }
  if (process.env.STORE_TEST_MODE === "deploy-failure") process.exit(7);
  const app = args.at(-1);
  await mkdir(app, { recursive: true });
  for (const name of ["@agentclientprotocol/sdk", "@planweave-ai/runtime"]) {
    const dir = join(app, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name, type: "module", exports: "./index.js" })
    );
    await writeFile(join(dir, "index.js"), "export {};");
  }
  process.exit(0);
}
