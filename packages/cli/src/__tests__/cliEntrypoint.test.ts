import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isCliEntrypoint } from "../index.js";

describe("CLI entrypoint detection", () => {
  it("accepts npm bin symlinks that resolve to the compiled entrypoint", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "planweave-cli-entrypoint-"));
    const entrypointPath = join(tempDir, "dist-index.js");
    const symlinkPath = join(tempDir, "planweave");
    writeFileSync(entrypointPath, "#!/usr/bin/env node\n", "utf8");
    symlinkSync(entrypointPath, symlinkPath);

    expect(isCliEntrypoint(pathToFileURL(entrypointPath).href, symlinkPath)).toBe(true);
  });

  it("rejects missing argv paths", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "planweave-cli-entrypoint-"));
    const entrypointPath = join(tempDir, "dist-index.js");
    writeFileSync(entrypointPath, "#!/usr/bin/env node\n", "utf8");

    expect(isCliEntrypoint(pathToFileURL(entrypointPath).href, undefined)).toBe(false);
    expect(isCliEntrypoint(pathToFileURL(entrypointPath).href, join(tempDir, "missing"))).toBe(
      false
    );
  });
});
