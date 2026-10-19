import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const controlDir = process.argv[2];
const releasePath = join(controlDir, "release-exit");
process.stdin.resume();
process.stdin.once("end", () => {
  writeFileSync(join(controlDir, "eof"), "observed\n");
  const deadline = Date.now() + 5_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) process.exit(124);
    Atomics.wait(wait, 0, 0, 1);
  }
  process.exit(0);
});
writeFileSync(join(controlDir, "ready"), "ready\n");
