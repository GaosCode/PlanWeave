import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const eventSchema = z.object({
  event: z.string(),
  origin: z.string().optional(),
  processId: z.number().optional(),
  digest: z.string().optional(),
  message: z.string().optional()
});
type ChildEvent = z.infer<typeof eventSchema>;
export class AttachmentProcessHarness {
  private readonly child: ChildProcess;
  private readonly events: ChildEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly exited: Promise<void>;
  private output = "";
  private stopped = false;
  private originValue: string | undefined;

  constructor(input: {
    directory: string;
    now: string;
    mode: "normal" | "hold-gc" | "hold-gc-entry" | "hold-publish";
  }) {
    const path = fileURLToPath(new URL("./commentAttachmentLifecycleChild.ts", import.meta.url));
    this.child = spawn(process.execPath, ["--import", "tsx", path, JSON.stringify(input)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    this.child.stdout?.on("data", (bytes: Buffer) => {
      this.output += bytes.toString();
    });
    this.child.stderr?.on("data", (bytes: Buffer) => {
      this.output += bytes.toString();
    });
    this.child.on("message", (message: unknown) => {
      this.events.push(eventSchema.parse(message));
      for (const wake of this.waiters) wake();
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => {
        this.stopped = true;
        for (const wake of this.waiters) wake();
        resolve();
      });
    });
  }
  async ready(): Promise<string> {
    const event = await this.waitFor("ready");
    this.originValue = z.string().url().parse(event.origin);
    return this.originValue;
  }
  async waitFor(eventName: string): Promise<ChildEvent> {
    const deadline = performance.now() + 8000;
    while (true) {
      const event = this.events.find((event) => event.event === eventName);
      if (event) return event;
      if (this.stopped)
        throw new Error(`Attachment child exited waiting for ${eventName}: ${this.output}`);
      await new Promise<void>((resolve, reject) => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          reject(new Error(`Attachment child timed out waiting for ${eventName}: ${this.output}`));
          return;
        }
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error(`Attachment child timed out waiting for ${eventName}: ${this.output}`));
        }, remaining);
        this.waiters.add(wake);
      });
    }
  }
  bind(pendingUploadId: string): void {
    this.child.send({ command: "bind", pendingUploadId });
  }
  release(): void {
    this.child.send({ command: "release" });
  }
  async crash(): Promise<void> {
    if (!this.stopped) this.child.kill("SIGKILL");
    await this.exited;
  }
  async dispose(): Promise<void> {
    if (!this.stopped) this.child.send({ command: "stop" });
    await this.exited;
  }
}
