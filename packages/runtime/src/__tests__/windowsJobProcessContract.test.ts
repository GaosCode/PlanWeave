import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dynamicOwnedProcessFloorPattern =
  /\$ownedProcessFloor\s*=\s*if\s*\(\[PlanWeaveWindowsJob\]::CurrentProcessBelongsToJob\(\$job\)\)\s*\{\s*1\s*\}\s*else\s*\{\s*0\s*\}/u;
const activeProcessFloorPattern = /ActiveProcesses\(\$job\)\s*-gt\s*\$ownedProcessFloor/u;

describe("Windows Job process helper contract", () => {
  it("counts the keeper only when it belongs to the managed Job", async () => {
    const helperSource = await readFile(
      join(import.meta.dirname, "../process/windowsJobProcess.ps1"),
      "utf8"
    );

    expect(helperSource).toContain("private static extern bool IsProcessInJob");
    expect(helperSource).toMatch(dynamicOwnedProcessFloorPattern);
    expect(helperSource).toMatch(activeProcessFloorPattern);
  });
});
