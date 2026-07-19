import { mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "../json.js";

describe("json file helpers", () => {
  it("keeps the target JSON readable after concurrent writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-json-"));
    const path = join(dir, "state.json");

    await writeJsonFile(path, { index: 0, payload: "" });
    await Promise.all(
      Array.from({ length: 25 }, async (_item, index) => {
        await writeJsonFile(path, {
          index,
          payload: "x".repeat(5000)
        });
      })
    );

    const parsed = await readJsonFile<{ index: number; payload: string }>(path);
    expect(parsed.index).toBeGreaterThanOrEqual(0);
    expect(parsed.payload).toMatch(/^x*$/);
  });

  it("retries a transient Windows rename failure while replacing an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "planweave-json-"));
    const path = join(dir, "state.json");
    let renameAttempts = 0;

    await writeJsonFile(path, { index: 0 });
    await writeJsonFile(
      path,
      { index: 1 },
      {
        rename: async (temporaryPath, targetPath) => {
          renameAttempts += 1;
          if (renameAttempts === 1) {
            throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
          }
          await rename(temporaryPath, targetPath);
        }
      }
    );

    await expect(readJsonFile(path)).resolves.toEqual({ index: 1 });
    expect(renameAttempts).toBe(2);
  });
});
