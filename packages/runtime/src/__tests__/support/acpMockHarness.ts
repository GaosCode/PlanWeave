import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ACP_PROTOCOL_AUTHORITY = {
  packageName: "@agentclientprotocol/sdk",
  version: "1.2.1",
  stable: [
    "initialize",
    "authenticate",
    "session/new",
    "session/prompt",
    "session/cancel",
    "session/update",
    "session/request_permission"
  ],
  experimental: ["elicitation/create"]
} as const;

export const ACP_MOCK_OPERATION_TIMEOUT_MS = 2_000;

export type AcpMockScenario =
  | "success"
  | "streaming"
  | "permission"
  | "elicitation"
  | "auth-required"
  | "delayed"
  | "late-update"
  | "malformed"
  | "duplicate-response"
  | "unknown-id"
  | "protocol-error"
  | "stubborn-pending"
  | "stderr"
  | "early-exit";

type JsonRpcId = number | string;
type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
};

export class AcpMockHarness {
  readonly process: ChildProcessWithoutNullStreams;
  readonly traffic: JsonRpcMessage[] = [];
  readonly sent: JsonRpcMessage[] = [];
  readonly stderr: string[] = [];
  readonly malformed: string[] = [];
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly scenario: AcpMockScenario;

  constructor(scenario: AcpMockScenario) {
    this.scenario = scenario;
    const fixture = fileURLToPath(new URL("./acpMockAgent.mjs", import.meta.url));
    this.process = spawn(process.execPath, [fixture, scenario], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    this.process.stderr.on("data", (chunk: string) => this.consumeStderr(chunk));
    this.exited = new Promise((resolve) => {
      this.process.once("exit", (code, signal) => resolve({ code, signal }));
      this.process.once("error", () => resolve({ code: null, signal: null }));
    });
    this.process.once("exit", (code, signal) => {
      const error = new Error(
        `Mock ACP process exited (code=${String(code)}, signal=${String(signal)})`
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    this.process.once("error", (cause) => {
      const error = new Error("Mock ACP process failed", { cause });
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }

  request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<JsonRpcMessage> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: this.scenario === "elicitation" ? { elicitation: { form: {} } } : {},
      clientInfo: { name: "planweave-test-client", version: "1.0.0" }
    });
  }

  async newSession(cwd = process.cwd()): Promise<string> {
    const response = await this.request("session/new", { cwd, mcpServers: [] });
    const result = response.result as { sessionId?: unknown } | undefined;
    if (typeof result?.sessionId !== "string") throw new Error("Mock ACP returned no session id");
    return result.sessionId;
  }

  prompt(sessionId: string, text = "test prompt"): Promise<JsonRpcMessage> {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }]
    });
  }

  close(): void {
    if (!this.process.stdin.writableEnded) this.process.stdin.end();
  }

  async dispose(timeoutMs = 100): Promise<void> {
    this.close();
    if (await this.waitForExitWithin(timeoutMs)) return;
    this.process.kill("SIGTERM");
    if (await this.waitForExitWithin(timeoutMs)) return;
    this.process.kill("SIGKILL");
    if (await this.waitForExitWithin(timeoutMs)) return;
    throw new Error(`Mock ACP process ${String(this.process.pid)} did not exit after SIGKILL`);
  }

  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exited;
  }

  private write(message: JsonRpcMessage): void {
    this.sent.push(message);
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async waitForExitWithin(timeoutMs: number): Promise<boolean> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return true;
    return Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ]);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.malformed.push(line);
        continue;
      }
      this.traffic.push(message);
      if (message.method && message.id !== undefined) this.respondToAgentRequest(message);
      if (message.id !== undefined && !message.method) {
        const request = this.pending.get(message.id);
        if (request) {
          this.pending.delete(message.id);
          request.resolve(message);
        }
      }
    }
  }

  private respondToAgentRequest(message: JsonRpcMessage): void {
    if (message.method === "session/request_permission") {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "selected", optionId: "allow" } }
      });
    } else if (message.method === "elicitation/create") {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: { action: "accept", content: { value: "mock" } }
      });
    } else if (message.method === "mock/pending") {
      return;
    } else {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" }
      });
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = lines.pop() ?? "";
    this.stderr.push(...lines.filter(Boolean));
  }
}
