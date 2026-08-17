import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CAPTURE_LIMIT_BYTES = 1_048_576;
const CLEANUP_RESERVE_MS = 1_000;
const credentialShapePattern =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|password)["'\s]*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/i;

export function resolveExecutable(command, pathValue = process.env.PATH ?? "") {
  if (isAbsolute(command)) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue looking in the remaining explicit PATH entries.
    }
  }
  return null;
}

export class AcpGateProtocolClient {
  constructor({
    command,
    args = [],
    cwd,
    env,
    onMessage,
    onTerminal,
    onOutgoingRequest,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    deadlineAt = null,
    maxCaptureBytes = DEFAULT_CAPTURE_LIMIT_BYTES
  }) {
    this.spawnStartedAt = performance.now();
    this.process = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    this.processGroupId = process.platform === "win32" ? null : (this.process.pid ?? null);
    this.onMessage = onMessage;
    this.onTerminal = onTerminal;
    this.onOutgoingRequest = onOutgoingRequest;
    this.timeoutMs = timeoutMs;
    this.deadlineAt = deadlineAt;
    this.maxCaptureBytes = maxCaptureBytes;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.stdoutBuffer = "";
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.captureLimitExceeded = false;
    this.credentialShapeDetected = false;
    this.terminalError = null;
    this.terminalNotified = false;
    this.requestCounts = new Map();
    this.lastProcessGroupCleanupConfirmed = false;
    this.closed = new Promise((resolve) => {
      this.process.once("exit", (code, signal) => {
        const error = new Error(
          `ACP gate process exited (code=${String(code)}, signal=${String(signal)}).`
        );
        this.terminalError ??= error;
        this.settlePending(this.terminalError);
        this.notifyTerminal(this.terminalError);
        resolve({ code, signal });
      });
      this.process.once("error", (cause) => {
        const error = new Error("ACP gate process failed to start.", { cause });
        this.terminalError ??= error;
        this.settlePending(error);
        this.notifyTerminal(error);
        resolve({ code: null, signal: null });
      });
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => this.consumeStderr(chunk));
  }

  get processId() {
    return this.process.pid ?? null;
  }

  get pendingCount() {
    return this.pending.size;
  }

  get outputSafety() {
    return {
      stdoutBytesCaptured: Math.min(this.stdoutBytes, this.maxCaptureBytes),
      stderrBytesCaptured: Math.min(this.stderrBytes, this.maxCaptureBytes),
      captureLimitExceeded: this.captureLimitExceeded,
      credentialShapeDetected: this.credentialShapeDetected,
      contentEmitted: false
    };
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const boundedTimeout = this.operationTimeout(timeoutMs);
    if (boundedTimeout <= 0) {
      return Promise.reject(new Error("ACP gate profile deadline expired."));
    }
    const id = this.nextRequestId++;
    this.requestCounts.set(method, (this.requestCounts.get(method) ?? 0) + 1);
    this.onOutgoingRequest?.(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP gate ${method} timed out.`));
      }, boundedTimeout);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    if (this.terminalError) throw this.terminalError;
    if (this.operationTimeout(this.timeoutMs) <= 0) {
      throw new Error("ACP gate profile deadline expired.");
    }
    this.requestCounts.set(method, (this.requestCounts.get(method) ?? 0) + 1);
    this.onOutgoingRequest?.(method);
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async dispose(timeoutMs = 1_000) {
    const cleanupDeadline = this.deadlineAt ?? Date.now() + timeoutMs;
    if (!this.process.stdin.writableEnded) this.process.stdin.end();
    if (!(await this.waitForExit(Math.min(timeoutMs, this.remaining(cleanupDeadline))))) {
      this.killProcessTree("SIGTERM");
    }
    if (!(await this.waitForExit(Math.min(250, this.remaining(cleanupDeadline))))) {
      this.killProcessTree("SIGKILL");
      await this.waitForExit(Math.min(250, this.remaining(cleanupDeadline)));
    }
    this.lastProcessGroupCleanupConfirmed = await this.confirmProcessGroupReaped(cleanupDeadline);
    return { processGroupCleanupConfirmed: this.lastProcessGroupCleanupConfirmed };
  }

  async terminateForFault() {
    this.killProcessTree("SIGKILL");
    await this.closed;
  }

  write(message) {
    if (this.process.stdin.writableEnded || this.process.stdin.destroyed) {
      throw this.terminalError ?? new Error("ACP gate process input is closed.");
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  consumeStdout(chunk) {
    this.stdoutBytes += Buffer.byteLength(chunk);
    this.scanCredentialShape(chunk);
    if (this.stdoutBytes > this.maxCaptureBytes) {
      this.failCaptureLimit();
      return;
    }
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("ACP gate received malformed JSON."));
        continue;
      }
      if (message.id !== undefined && message.method === undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`ACP gate ${pending.method} failed.`));
        else pending.resolve(message.result);
        continue;
      }
      Promise.resolve(this.onMessage?.(message, this)).catch(() => {
        if (message.id !== undefined) {
          this.respondError(message.id, -32603, "ACP client handler failed");
        }
      });
    }
  }

  consumeStderr(chunk) {
    this.stderrBytes += Buffer.byteLength(chunk);
    this.scanCredentialShape(chunk);
    if (this.stderrBytes > this.maxCaptureBytes) this.failCaptureLimit();
  }

  scanCredentialShape(chunk) {
    if (credentialShapePattern.test(chunk)) this.credentialShapeDetected = true;
  }

  failCaptureLimit() {
    this.captureLimitExceeded = true;
    this.fail(new Error("ACP gate output exceeded the bounded capture limit."));
  }

  fail(error) {
    this.terminalError ??= error;
    this.settlePending(this.terminalError);
    this.notifyTerminal(this.terminalError);
    this.killProcessTree("SIGKILL");
  }

  notifyTerminal(error) {
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    this.onTerminal?.(error);
  }

  settlePending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  operationTimeout(requestedMs) {
    if (this.deadlineAt == null) return requestedMs;
    return Math.min(requestedMs, this.deadlineAt - CLEANUP_RESERVE_MS - Date.now());
  }

  remaining(deadlineAt) {
    return Math.max(0, deadlineAt - Date.now());
  }

  killProcessTree(signal) {
    try {
      if (this.processGroupId != null) process.kill(-this.processGroupId, signal);
      else if (this.process.pid != null) this.process.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  processGroupExists() {
    if (this.processGroupId == null) return this.process.exitCode === null;
    try {
      process.kill(-this.processGroupId, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      return true;
    }
  }

  async confirmProcessGroupReaped(deadlineAt) {
    if (process.platform === "win32") return false;
    while (this.processGroupExists() && Date.now() < deadlineAt) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return !this.processGroupExists();
  }

  async waitForExit(timeoutMs) {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return true;
    if (timeoutMs <= 0) return false;
    return Promise.race([
      this.closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ]);
  }
}
