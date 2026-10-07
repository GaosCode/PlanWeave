import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixture"), root: z.string() }),
  z.object({
    kind: z.literal("pending"),
    canvasOperation: z.string(),
    packageOperation: z.string()
  }),
  z.object({
    kind: z.literal("completed"),
    mode: z.string(),
    status: z.string(),
    pairedContentPreserved: z.boolean()
  })
]);

describe("authoritative materialization and captured state lock order", () => {
  it.each([
    "claim",
    "prepare",
    "submit",
    "rollback"
  ])("settles actual materialization and snapshot %s without losing state/content pairing", async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "pw-authority-state-lock-"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./support/authoritativeSnapshotStateLockChild.mts", import.meta.url))
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PW_AUTHORITY_LOCK_TEST_HOME: home,
          PW_AUTHORITY_LOCK_TEST_MODE: mode
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let root: string | undefined;
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const outcome = await new Promise<z.infer<typeof eventSchema>>((resolve, reject) => {
        let buffer = "";
        child.stdout.on("data", (chunk: Buffer) => {
          try {
            buffer += chunk.toString("utf8");
            while (buffer.includes("\n")) {
              const end = buffer.indexOf("\n");
              const event = eventSchema.parse(JSON.parse(buffer.slice(0, end)));
              buffer = buffer.slice(end + 1);
              if (event.kind === "fixture") root = event.root;
              else resolve(event);
            }
          } catch (error) {
            reject(error);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Child exited ${code}: ${stderr}`)));
        timer = setTimeout(() => reject(new Error(`Child deadline: ${stderr}`)), 10000);
      });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        kind: "completed",
        mode,
        pairedContentPreserved: true
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(killTimer);
      if (root) {
        expect(dirname(root)).toBe(tmpdir());
        expect(root.split(/[\\/]/).at(-1)).toMatch(/^planweave-project-/);
        await rm(root, { recursive: true, force: true });
      }
      await rm(home, { recursive: true, force: true });
    }
  }, 15000);
});
