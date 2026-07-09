import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeRoot = join(import.meta.dirname, "..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("runtime architecture boundaries", () => {
  it("keeps task manager independent from desktop modules", async () => {
    const taskManagerFiles = await sourceFiles(join(runtimeRoot, "taskManager"));
    const imports = await Promise.all(
      taskManagerFiles.map(async (file) => [file, await readFile(file, "utf8")] as const)
    );

    expect(
      imports
        .filter(([, content]) => /from\s+["']\.\.\/desktop\//.test(content))
        .map(([file]) => file)
    ).toEqual([]);
  });
});
