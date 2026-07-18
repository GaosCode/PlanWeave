import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  agentRunControlEndpointDescriptorSchema,
  type AgentRunControlEndpointDescriptor
} from "../../autoRun/agentRunControlContract.js";
import type { RunnerSessionActionIdentity } from "../../autoRun/runnerContractSchemas.js";

const workerPath = fileURLToPath(new URL("./agentRunControlOwnerWorker.ts", import.meta.url));
const defaultTimeoutMs = 4000;

const ownerWorkerMessageSchema = z.object({ kind: z.string().min(1) }).passthrough();
export type OwnerWorkerMessage = z.infer<typeof ownerWorkerMessageSchema>;

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = defaultTimeoutMs
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class AgentRunControlOwnerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly messages: OwnerWorkerMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private stderr = "";
  private stdoutBuffer = "";

  private constructor(runDir: string, identity: RunnerSessionActionIdentity) {
    this.child = spawn(
      process.execPath,
      ["--import", "tsx", workerPath, runDir, JSON.stringify(identity)],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
  }

  static async start(
    runDir: string,
    identity: RunnerSessionActionIdentity,
    readyTimeoutMs = defaultTimeoutMs
  ): Promise<{
    owner: AgentRunControlOwnerProcess;
    descriptor: AgentRunControlEndpointDescriptor;
  }> {
    const owner = new AgentRunControlOwnerProcess(runDir, identity);
    try {
      const ready = await owner.waitFor(
        (message) => message.kind === "ready",
        "owner ready",
        readyTimeoutMs
      );
      return {
        owner,
        descriptor: agentRunControlEndpointDescriptorSchema.parse(ready.descriptor)
      };
    } catch (error) {
      await owner.terminate();
      throw error;
    }
  }

  send(message: Record<string, unknown>): void {
    if (!this.child.stdin.writable) throw new Error("Owner worker stdin is not writable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(
    predicate: (message: OwnerWorkerMessage) => boolean,
    label: string,
    timeoutMs = defaultTimeoutMs
  ): Promise<OwnerWorkerMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise<OwnerWorkerMessage>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        this.child.off("exit", check);
      };
      const check = (): void => {
        const match = this.messages.find(predicate);
        if (match) {
          cleanup();
          resolve(match);
          return;
        }
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
          cleanup();
          reject(
            new Error(
              `Owner worker exited before ${label}: code=${String(this.child.exitCode)} signal=${String(this.child.signalCode)} stderr=${this.stderr}`
            )
          );
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${label}.`));
      }, timeoutMs);
      this.waiters.add(check);
      this.child.once("exit", check);
      check();
    });
  }

  matching(predicate: (message: OwnerWorkerMessage) => boolean): OwnerWorkerMessage[] {
    return this.messages.filter(predicate);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.send({ kind: "stop" });
    await this.waitFor((message) => message.kind === "stopped", "owner stop");
    await this.waitForExit("owner process exit");
  }

  async terminate(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    try {
      await this.waitForExit("owner process termination");
    } catch {
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill("SIGKILL");
      await this.waitForExit("forced owner process termination");
    }
  }

  private waitForExit(label: string): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return withTimeout(
      new Promise<void>((resolve, reject) => {
        this.child.once("error", reject);
        this.child.once("exit", () => resolve());
      }),
      label
    );
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = ownerWorkerMessageSchema.parse(JSON.parse(line) as unknown);
      this.messages.push(parsed);
    }
    for (const waiter of [...this.waiters]) waiter();
  }
}
