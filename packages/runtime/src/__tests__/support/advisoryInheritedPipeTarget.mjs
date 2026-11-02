import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, root] = process.argv.slice(2);
if (mode === "writer") {
  const store = process.env.PLANWEAVE_BUILD_STORE_DIR;
  writeFileSync(join(store, "pipe-live"), "owned");
  writeFileSync(join(root, "writer-ready"), String(process.pid));
  const timer = setInterval(() => {
    if (existsSync(join(root, "release"))) {
      clearInterval(timer);
      writeFileSync(join(store, "last-byte"), "writer completed");
      writeFileSync(join(root, "writer-terminal"), "done");
    }
  }, 10);
  process.send("ready");
} else if (mode === "target") {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "writer", root], {
    stdio: ["ignore", "inherit", "inherit", "ipc"]
  });
  child.once("message", () => {
    child.disconnect();
    child.unref();
    console.log("PIPE_STDOUT_BEFORE_EXIT");
    console.error("PIPE_STDERR_BEFORE_EXIT");
    process.exit(7);
  });
} else {
  throw new Error(`Unknown inherited pipe target mode: ${mode}`);
}
