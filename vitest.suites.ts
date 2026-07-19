import suiteManifest from "./vitest.suites.json";

export type TestSuiteName = "unit" | "integration" | "platform" | "performance";

export function testFilesFor(suite: TestSuiteName): string[] {
  return suiteManifest.groups.flatMap((group) =>
    group[suite].map((fileName) => `${group.root}/${fileName}`)
  );
}

export function testFilesForRoots(suite: TestSuiteName, roots: string[]): string[] {
  const selectedRoots = new Set(roots);
  return suiteManifest.groups.flatMap((group) => {
    if (!selectedRoots.has(group.root)) return [];
    return group[suite].map((fileName) => `${group.root}/${fileName}`);
  });
}
