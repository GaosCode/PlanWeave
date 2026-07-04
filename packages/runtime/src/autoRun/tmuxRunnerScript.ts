export function tmuxRunnerSource(configPath: string): string {
  return `import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const config = JSON.parse(await readFile(${JSON.stringify(configPath)}, "utf8"));
const stdoutLog = createWriteStream(config.stdoutPath, { flags: "a" });
const stderrLog = createWriteStream(config.stderrPath, { flags: "a" });
let timedOut = false;
let done = false;
let limitExceeded = null;
let stdoutBytes = 0;
let stderrBytes = 0;
let forceKillTimeout;
let child;
let fatalInProgress = false;
const failedLogs = new Set();
const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 5000;
const heartbeatState = {
  status: "running",
  pid: null,
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
  lastStdoutAt: null,
  lastStderrAt: null,
  finishedAt: null,
  exitCode: null,
  timedOut: null,
  error: null
};
let heartbeatTimer;
let heartbeatWriteChain = Promise.resolve();

function writeHeartbeat(patch = {}) {
  if (!config.heartbeatPath) return Promise.resolve();
  Object.assign(heartbeatState, patch);
  heartbeatWriteChain = heartbeatWriteChain
    .catch(() => undefined)
    .then(() => writeFile(config.heartbeatPath, JSON.stringify(heartbeatState, null, 2), "utf8"));
  return heartbeatWriteChain;
}

function markOutputHeartbeat(streamName) {
  const now = new Date().toISOString();
  if (streamName === "stdout") {
    void writeHeartbeat({ lastHeartbeatAt: now, lastStdoutAt: now });
    return;
  }
  void writeHeartbeat({ lastHeartbeatAt: now, lastStderrAt: now });
}

function outputMarker(stream, limitBytes) {
  return Buffer.from("\\n[planweave: " + stream + " output truncated after " + limitBytes + " bytes; executor terminated]\\n");
}

function terminateChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let resolved = false;
    const finishTermination = () => {
      if (resolved) return;
      resolved = true;
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
      resolve();
    };
    child.once("close", finishTermination);
    child.kill("SIGTERM");
    if (!forceKillTimeout) {
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 500);
      forceKillTimeout.unref();
    }
  });
}

function fatal(message) {
  if (done || fatalInProgress) return;
  fatalInProgress = true;
  void (async () => {
    await terminateChild();
    await finish(1, message);
  })();
}

stdoutLog.on("error", (error) => {
  failedLogs.add("stdout");
  fatal("stdout log stream failed: " + (error instanceof Error ? error.message : String(error)));
});
stderrLog.on("error", (error) => {
  failedLogs.add("stderr");
  fatal("stderr log stream failed: " + (error instanceof Error ? error.message : String(error)));
});

function writeLog(log, streamName, chunk) {
  if (!failedLogs.has(streamName)) {
    log.write(chunk);
    markOutputHeartbeat(streamName);
  }
}

function writeBoundedOutput(streamName, chunk) {
  if (limitExceeded) return;
  const isStdout = streamName === "stdout";
  const limitBytes = isStdout ? config.maxStdoutBytes : config.maxStderrBytes;
  const currentBytes = isStdout ? stdoutBytes : stderrBytes;
  const log = isStdout ? stdoutLog : stderrLog;
  const terminal = isStdout ? process.stdout : process.stderr;
  if (!limitBytes) {
    terminal.write(chunk);
    writeLog(log, streamName, chunk);
    return;
  }
  const remainingBytes = limitBytes - currentBytes;
  const allowedChunk = remainingBytes > 0 ? chunk.subarray(0, remainingBytes) : Buffer.alloc(0);
  if (allowedChunk.length > 0) {
    terminal.write(allowedChunk);
    writeLog(log, streamName, allowedChunk);
    if (isStdout) {
      stdoutBytes += allowedChunk.length;
    } else {
      stderrBytes += allowedChunk.length;
    }
  }
  if (currentBytes + chunk.length <= limitBytes) {
    return;
  }
  const marker = outputMarker(streamName, limitBytes);
  terminal.write(marker);
  writeLog(log, streamName, marker);
  limitExceeded = { stream: streamName, limitBytes };
  void terminateChild();
}

function endStream(stream, streamName) {
  return new Promise((resolve, reject) => {
    if (failedLogs.has(streamName) || stream.destroyed) {
      resolve();
      return;
    }
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function finish(exitCode, errorMessage) {
  if (done) return;
  done = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (errorMessage) {
    writeLog(stderrLog, "stderr", String(errorMessage) + "\\n");
    process.stderr.write(String(errorMessage) + "\\n");
  }
  await Promise.all([endStream(stdoutLog, "stdout"), endStream(stderrLog, "stderr")]);
  const doneState = {
    exitCode: limitExceeded ? 1 : exitCode,
    timedOut,
    limitExceeded,
    finishedAt: new Date().toISOString()
  };
  if (errorMessage) {
    doneState.error = String(errorMessage);
  }
  await writeHeartbeat({
    status: errorMessage ? "failed" : "finished",
    lastHeartbeatAt: new Date().toISOString(),
    finishedAt: doneState.finishedAt,
    exitCode: doneState.exitCode,
    timedOut,
    error: errorMessage ? String(errorMessage) : null
  });
  await writeFile(config.donePath, JSON.stringify(doneState), "utf8");
  process.exit(limitExceeded ? 1 : exitCode);
}

child = spawn(config.command, config.args, {
  cwd: config.cwd,
  env: { ...process.env, ...(config.env ?? {}) },
  stdio: ["pipe", "pipe", "pipe"]
});
void writeHeartbeat({ pid: child.pid ?? null });
if (heartbeatIntervalMs > 0) {
  heartbeatTimer = setInterval(() => {
    void writeHeartbeat({ lastHeartbeatAt: new Date().toISOString() });
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
}

let timeout;
if (config.timeoutMs) {
  timeout = setTimeout(() => {
    timedOut = true;
    void terminateChild();
  }, config.timeoutMs);
}

child.stdout.on("data", (chunk) => {
  writeBoundedOutput("stdout", chunk);
});
child.stderr.on("data", (chunk) => {
  writeBoundedOutput("stderr", chunk);
});
child.on("error", (error) => {
  if (timeout) clearTimeout(timeout);
  if (forceKillTimeout) clearTimeout(forceKillTimeout);
  void finish(1, error instanceof Error ? error.message : String(error));
});
child.on("close", (code) => {
  if (timeout) clearTimeout(timeout);
  if (forceKillTimeout) clearTimeout(forceKillTimeout);
  if (fatalInProgress) return;
  void finish(limitExceeded ? 1 : timedOut ? 124 : code ?? 1);
});

createReadStream(config.stdinPath).on("error", (error) => {
  child.stdin.destroy(error);
}).pipe(child.stdin);
`;
}
