import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
const execute = promisify(execFile);
const resultSchema = z.object({
  bytes: z.number(),
  entropy: z.enum(["high", "low"]),
  compressedBytes: z.number(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  maxRssKiB: z.number(),
  exportMs: z.number(),
  elapsedMs: z.number()
});
describe("archive independent process resource baseline", () => {
  it("round-trips 128 MiB and 1 GiB at both compression extremes without linear RSS growth", async () => {
    const results: z.infer<typeof resultSchema>[] = [];
    for (const entropy of ["low", "high"] as const) {
      for (const bytes of [128 * 1024 ** 2, 1024 ** 3]) {
        const { stdout } = await execute(
          process.execPath,
          [
            "--import",
            "tsx",
            fileURLToPath(new URL("./fixtures/serverDataArchiveResourceChild.ts", import.meta.url)),
            String(bytes),
            entropy
          ],
          { timeout: 600_000, maxBuffer: 1024 * 1024 }
        );
        const result = resultSchema.parse(JSON.parse(stdout.trim()));
        results.push(result);
        process.stdout.write(`ARCHIVE_RESOURCE ${JSON.stringify(result)}\n`);
        expect(result.bytes).toBe(bytes);
        expect(result.entropy).toBe(entropy);
      }
      const [small, large] = results.filter((result) => result.entropy === entropy);
      // An eightfold payload increase must remain clearly below proportional memory growth.
      expect(large!.maxRssKiB / small!.maxRssKiB).toBeLessThan(3);
    }
  }, 1_200_000);
});
