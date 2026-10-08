import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export type SnapshotChildInput = {
  file: string;
  data: string;
  canvas: string;
  id: string;
  location: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    projectRoot: string;
    packageDir: string;
  };
  mode: "cleanup" | "hold-cleanup" | "hold-restore";
};
const eventSchema = z.object({
  event: z.string(),
  result: z.unknown().optional(),
  message: z.string().optional()
});
export class SnapshotProcessHarness {
  private readonly child: ChildProcess;
  private readonly events: z.infer<typeof eventSchema>[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly exited: Promise<void>;
  private stopped = false;
  private output = "";
  constructor(input: SnapshotChildInput) {
    const path = fileURLToPath(new URL("./packageSnapshotCleanupChild.ts", import.meta.url));
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
    this.exited = new Promise((resolve) =>
      this.child.once("exit", () => {
        this.stopped = true;
        for (const wake of this.waiters) wake();
        resolve();
      })
    );
  }
  async waitFor(name: string) {
    const deadline = performance.now() + 15_000;
    while (true) {
      const failure = this.events.find((event) => event.event === "error");
      if (failure) throw new Error(failure.message);
      const event = this.events.find((event) => event.event === name);
      if (event) return event;
      if (this.stopped)
        throw new Error(`Snapshot child exited waiting for ${name}: ${this.output}`);
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(
          () => {
            this.waiters.delete(wake);
            reject(new Error(`Snapshot child timed out waiting for ${name}: ${this.output}`));
          },
          Math.max(1, deadline - performance.now())
        );
        this.waiters.add(wake);
      });
    }
  }
  release() {
    this.child.send({ command: "release" });
  }
  async dispose() {
    if (!this.stopped) this.child.kill("SIGTERM");
    await this.exited;
  }
}
