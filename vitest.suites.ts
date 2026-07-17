import suiteManifest from "./vitest.suites.json";

export type TestSuiteName = "unit" | "platform";

export function testFilesFor(suite: TestSuiteName): string[] {
  return suiteManifest.groups.flatMap((group) =>
    group[suite].map((fileName) => `${group.root}/${fileName}`)
  );
}
