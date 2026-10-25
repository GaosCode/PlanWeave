import * as fs from "node:fs/promises";
import { join } from "node:path";
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
        const writer = `const fs=require('node:fs');const path=require('node:path');const store=process.env.PLANWEAVE_BUILD_STORE_DIR;fs.writeFileSync(path.join(store,'pipe-live'),'owned');fs.writeFileSync(${JSON.stringify(join(root, "writer-ready"))},String(process.pid));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, "release"))})){clearInterval(t);fs.writeFileSync(path.join(store,'last-byte'),'writer completed');fs.writeFileSync(${JSON.stringify(join(root, "writer-terminal"))},'done');}},10);process.send('ready');`;
        const target = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:['ignore','inherit','inherit','ipc']});c.once('message',()=>{c.disconnect();c.unref();console.log('PIPE_STDOUT_BEFORE_EXIT');console.error('PIPE_STDERR_BEFORE_EXIT');process.exit(7);});`;
        await scope.runManagedCommand({ command: process.execPath, args: ["-e", target] });
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
