import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const { root, mode, moduleUrl } = JSON.parse(process.argv[2]);
const { withAdvisoryDirectoryLock } = await import(moduleUrl);
const lockPath = join(root, "lock");
try {
  await withAdvisoryDirectoryLock(
    { lockPath, operation: mode, timeoutMs: 500, retryDelayMs: 1 },
    async (scope) => {
      if (mode === "readonly") {
        await scope.runManagedCommand({
          command: process.execPath,
          args: [
            "-e",
            `const fs=require('node:fs');const path=require('node:path');const p=path.join(process.env.PLANWEAVE_BUILD_STORE_DIR,'readonly');fs.mkdirSync(p);fs.writeFileSync(path.join(p,'file'),'owned');fs.chmodSync(p,0o500);`
          ]
        });
        const owner = (await fs.readdir(lockPath))[0];
        await fs.writeFile(
          join(lockPath, owner, "writer-work", "disposable"),
          "delete before failure"
        );
      } else if (mode === "pipe") {
        await scope.runManagedCommand({
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./advisoryInheritedPipeTarget.mjs", import.meta.url)),
            "target",
            root
          ]
        });
      }
      process.send({ event: "entered", actor: mode, pid: process.pid });
    }
  );
  process.send({ event: "complete", actor: mode, pid: process.pid });
} catch (error) {
  const detail =
    error instanceof AggregateError ? error.errors.map(String).join("; ") : String(error);
  process.send({ event: "failed", actor: mode, pid: process.pid, message: detail });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
