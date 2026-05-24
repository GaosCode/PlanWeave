export function tmuxRunnerSource(configPath: string): string {
  return `import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const config = JSON.parse(await readFile(${JSON.stringify(configPath)}, "utf8"));
const stdoutLog = createWriteStream(config.stdoutPath, { flags: "a" });
const stderrLog = createWriteStream(config.stderrPath, { flags: "a" });
let timedOut = false;
let done = false;

function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function finish(exitCode, errorMessage) {
  if (done) return;
  done = true;
  if (errorMessage) {
    stderrLog.write(String(errorMessage) + "\\n");
    process.stderr.write(String(errorMessage) + "\\n");
  }
  await Promise.all([endStream(stdoutLog), endStream(stderrLog)]);
  await writeFile(config.donePath, JSON.stringify({
    exitCode,
    timedOut,
    finishedAt: new Date().toISOString()
  }), "utf8");
  process.exit(exitCode);
}

const child = spawn(config.command, config.args, {
  cwd: config.cwd,
  env: { ...process.env, ...(config.env ?? {}) },
  stdio: ["pipe", "pipe", "pipe"]
});

let timeout;
if (config.timeoutMs) {
  timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }, config.timeoutMs);
}

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  stdoutLog.write(chunk);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  stderrLog.write(chunk);
});
child.on("error", (error) => {
  if (timeout) clearTimeout(timeout);
  void finish(1, error instanceof Error ? error.message : String(error));
});
child.on("close", (code) => {
  if (timeout) clearTimeout(timeout);
  void finish(timedOut ? 124 : code ?? 1);
});

createReadStream(config.stdinPath).on("error", (error) => {
  child.stdin.destroy(error);
}).pipe(child.stdin);
`;
}
