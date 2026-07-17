import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(repositoryRoot, "vitest.suites.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const lineBreakPattern = /\r?\n/;
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const platformOnlySourcePatterns = [
  /(?:from\s+|import\s*\()['"]node:(?:child_process|net)['"]/,
  /\bprocess\.platform\b/,
  /\btaskkill\b/,
  /\bSIG(?:TERM|KILL)\b/,
  /\b(?:chmod|symlink|rename|unlink|watch)\s*\(/
];
const requiredPlatformTests = [
  "packages/runtime/src/__tests__/managedProcessTree.test.ts",
  "packages/runtime/src/__tests__/advisoryDirectoryLock.test.ts",
  "packages/runtime/src/__tests__/blockRunIndexRecovery.test.ts",
  "packages/runtime/src/__tests__/agentRunControlEndpoint.test.ts",
  "packages/runtime/src/__tests__/agentRunControlLifecycle.test.ts",
  "packages/runtime/src/__tests__/agentRunControlServer.test.ts",
  "packages/runtime/src/__tests__/acpCrossProcessPermission.test.ts"
];

function trackedTestFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--", "packages"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  })
    .split(lineBreakPattern)
    .filter((file) => testFilePattern.test(file))
    .sort();
}

function fail(diagnostics) {
  process.stderr.write(
    `Test suite classification is invalid:\n${diagnostics.map((error) => `- ${error}`).join("\n")}\n`
  );
  process.exit(1);
}

const validationErrors = [];
if (!(manifest && Array.isArray(manifest.groups))) {
  fail(["vitest.suites.json must contain a groups array."]);
}

const assignments = new Map();
for (const group of manifest.groups) {
  if (
    typeof group.root !== "string" ||
    !Array.isArray(group.unit) ||
    !Array.isArray(group.platform)
  ) {
    validationErrors.push("Each group must define root, unit, and platform.");
  } else {
    for (const suite of ["unit", "platform"]) {
      for (const fileName of group[suite]) {
        if (typeof fileName !== "string" || fileName !== posix.basename(fileName)) {
          validationErrors.push(`${group.root}/${String(fileName)} must be a test file basename.`);
        } else {
          const file = posix.join(group.root, fileName);
          const previous = assignments.get(file);
          if (previous) {
            validationErrors.push(`${file} is assigned to both ${previous} and ${suite}.`);
          } else {
            assignments.set(file, suite);
          }
        }
      }
    }
  }
}

const tracked = trackedTestFiles();
const trackedSet = new Set(tracked);
for (const file of tracked) {
  if (!assignments.has(file)) {
    validationErrors.push(`${file} is not assigned to a suite.`);
  }
}
for (const file of assignments.keys()) {
  if (!trackedSet.has(file)) {
    validationErrors.push(`${file} is listed but is not a tracked test file.`);
  }
}
for (const file of requiredPlatformTests) {
  if (assignments.get(file) !== "platform") {
    validationErrors.push(`${file} must remain in the platform suite.`);
  }
}
for (const [file, suite] of assignments) {
  if (suite === "unit" && trackedSet.has(file)) {
    const source = readFileSync(join(repositoryRoot, file), "utf8");
    if (platformOnlySourcePatterns.some((pattern) => pattern.test(source))) {
      validationErrors.push(`${file} uses platform-only APIs but is assigned to unit.`);
    }
  }
}

if (validationErrors.length > 0) {
  fail(validationErrors);
}

const unitCount = [...assignments.values()].filter((suite) => suite === "unit").length;
const platformCount = assignments.size - unitCount;
process.stdout.write(
  `Test suite classification valid: ${unitCount} unit, ${platformCount} platform.\n`
);
