import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const classifierPath = join(repositoryRoot, "scripts/check-test-suite-classification.mjs");
const fixtureRoots: string[] = [];
const requiredPlatformTests = [
  "packages/desktop/src/__tests__/runtimeStateWatch.test.ts",
  "packages/mcp/src/__tests__/oauth.test.ts",
  "packages/mcp/src/__tests__/oauthRefresh.test.ts",
  "packages/mcp/src/__tests__/requestGuards.test.ts",
  "packages/mcp/src/__tests__/server.test.ts",
  "packages/runtime/src/__tests__/managedProcessTree.test.ts",
  "packages/runtime/src/__tests__/agentRunControlServer.test.ts",
  "packages/runtime/src/__tests__/agentRunControlTwoProcess.test.ts",
  "packages/runtime/src/__tests__/blockRunIndexConcurrency.test.ts",
  "packages/runtime/src/__tests__/stateConcurrency.test.ts"
];
const suiteRoots = [
  "packages/cli/src/__tests__",
  "packages/desktop/src/__tests__",
  "packages/mcp/src/__tests__",
  "packages/runtime/src/__tests__"
];

interface FixtureFile {
  path: string;
  content: string;
}

async function createRepositoryFixture(files: FixtureFile[]): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "planweave-test-suite-classifier-"));
  fixtureRoots.push(fixtureRoot);
  await mkdir(join(fixtureRoot, "scripts"), { recursive: true });
  await writeFile(
    join(fixtureRoot, "scripts/check-test-suite-classification.mjs"),
    await readFile(classifierPath, "utf8")
  );
  await Promise.all(
    requiredPlatformTests.map(async (file) => {
      const target = join(fixtureRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "");
    })
  );
  await Promise.all(
    files.map(async (file) => {
      const target = join(fixtureRoot, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    })
  );
  const git = (...args: string[]) => spawnSync("git", args, { cwd: fixtureRoot, encoding: "utf8" });
  if (git("init", "--quiet").status !== 0 || git("add", ".").status !== 0) {
    throw new Error("Failed to initialize test suite classifier fixture repository.");
  }
  return fixtureRoot;
}

function runClassifier(fixtureRoot: string) {
  return spawnSync(
    process.execPath,
    [join(fixtureRoot, "scripts/check-test-suite-classification.mjs")],
    { cwd: fixtureRoot, encoding: "utf8" }
  );
}

function manifest(unit: string[], integration: string[] = [], platform: string[] = []): string {
  return JSON.stringify({
    groups: [
      { root: "packages/example/src/__tests__", unit, integration, platform },
      ...suiteRoots.map((root) => ({
        root,
        unit: [],
        integration: [],
        platform: requiredPlatformTests
          .filter((file) => dirname(file).replaceAll("\\", "/") === root)
          .map((file) => file.split("/").at(-1))
      }))
    ]
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

it("rejects a unit test whose nested support helper imports an external API", async () => {
  const fixtureRoot = await createRepositoryFixture([
    {
      path: "vitest.suites.json",
      content: manifest(["example.test.ts"])
    },
    {
      path: "packages/example/src/__tests__/example.test.ts",
      content: 'import "./support/outer.js";\n'
    },
    {
      path: "packages/example/src/__tests__/support/outer.ts",
      content: 'export * from "./nested/index.js";\n'
    },
    {
      path: "packages/example/src/__tests__/support/nested/index.ts",
      content: 'import { spawn } from "node:child_process";\nexport { spawn };\n'
    }
  ]);

  const result = runClassifier(fixtureRoot);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "packages/example/src/__tests__/example.test.ts -> " +
      "packages/example/src/__tests__/support/outer.ts -> " +
      "packages/example/src/__tests__/support/nested/index.ts"
  );
});

it("follows cross-package support imports once when helpers form a cycle", async () => {
  const fixtureRoot = await createRepositoryFixture([
    {
      path: "vitest.suites.json",
      content: manifest(["example.test.ts"])
    },
    {
      path: "packages/example/src/__tests__/example.test.ts",
      content: 'import "../../../other/src/__tests__/support/first.js";\n'
    },
    {
      path: "packages/other/src/__tests__/support/first.ts",
      content: 'export * from "./second.js";\n'
    },
    {
      path: "packages/other/src/__tests__/support/second.ts",
      content: 'import "./first.js";\nexport function move() { return rename("a", "b"); }\n'
    }
  ]);

  const result = runClassifier(fixtureRoot);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "packages/example/src/__tests__/example.test.ts -> " +
      "packages/other/src/__tests__/support/first.ts -> " +
      "packages/other/src/__tests__/support/second.ts"
  );
});

it("rejects direct real filesystem imports and temporary path operations", async () => {
  const fixtureRoot = await createRepositoryFixture([
    {
      path: "vitest.suites.json",
      content: manifest(["example.test.ts"])
    },
    {
      path: "packages/example/src/__tests__/example.test.ts",
      content:
        'import { mkdtemp } from "node:fs/promises";\n' +
        'import { symlinkSync } from "node:fs";\n' +
        'import { tmpdir } from "node:os";\n' +
        'await mkdtemp(tmpdir());\nsymlinkSync("target", "link");\n'
    }
  ]);

  const result = runClassifier(fixtureRoot);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "packages/example/src/__tests__/example.test.ts uses external APIs via " +
      "packages/example/src/__tests__/example.test.ts"
  );
});

it("accepts filesystem and child-process tests in the integration suite", async () => {
  const fixtureRoot = await createRepositoryFixture([
    {
      path: "vitest.suites.json",
      content: manifest([], ["example.test.ts"])
    },
    {
      path: "packages/example/src/__tests__/example.test.ts",
      content:
        'import { spawn } from "node:child_process";\n' +
        'import { mkdtemp } from "node:fs/promises";\n' +
        "export const externalOperations = [spawn, mkdtemp];\n"
    }
  ]);

  const result = runClassifier(fixtureRoot);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    `Test suite classification valid: 0 unit, 1 integration, ${requiredPlatformTests.length} platform.`
  );
});

it("rejects uncurated tests from the platform matrix", async () => {
  const fixtureRoot = await createRepositoryFixture([
    {
      path: "vitest.suites.json",
      content: manifest([], [], ["example.test.ts"])
    },
    {
      path: "packages/example/src/__tests__/example.test.ts",
      content: 'import { readFile } from "node:fs/promises";\nexport { readFile };\n'
    }
  ]);

  const result = runClassifier(fixtureRoot);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "packages/example/src/__tests__/example.test.ts is not curated for the platform matrix"
  );
});

it("accepts pure support helpers without traversing production modules", async () => {
  const fixtureRoot = await createRepositoryFixture([
    {
      path: "vitest.suites.json",
      content: manifest(["example.test.ts"])
    },
    {
      path: "packages/example/src/__tests__/example.test.ts",
      content: 'import "./support/pure.js";\nimport "../production.js";\n'
    },
    {
      path: "packages/example/src/__tests__/support/pure.ts",
      content:
        'import type { Stats } from "node:fs";\n' +
        "declare const vi: { importActual<T>(source: string): Promise<T> };\n" +
        'export const childProcess = vi.importActual<typeof import("node:child_process")>("node:child_process");\n' +
        "export type FileStats = Stats;\n"
    },
    {
      path: "packages/example/src/production.ts",
      content: 'import { spawn } from "node:child_process";\nexport { spawn };\n'
    }
  ]);

  const result = runClassifier(fixtureRoot);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    `Test suite classification valid: 1 unit, 0 integration, ${requiredPlatformTests.length} platform.`
  );
});

it("accepts the repository manifest with the expected suite counts", () => {
  const result = runClassifier(repositoryRoot);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "Test suite classification valid: 165 unit, 194 integration, 10 platform."
  );
});
