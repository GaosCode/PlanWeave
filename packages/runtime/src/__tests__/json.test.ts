import { mkdtemp } from "node:fs/promises";
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
});
