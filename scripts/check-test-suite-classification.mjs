import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(repositoryRoot, "vitest.suites.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const lineBreakPattern = /\r?\n/;
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const staticRelativeImportPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
const dynamicRelativeImportPattern = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const typeOnlyStaticPlatformImportPattern =
  /\bimport\s+type\s+[^;]+?\s+from\s+["']node:(?:child_process|net|fs(?:\/promises)?)["'];?/g;
const typeOnlyPlatformImportPattern =
  /\btypeof\s+import\s*\(\s*["']node:(?:child_process|net|fs(?:\/promises)?)["']\s*\)/g;
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const platformOnlySourcePatterns = [
  /(?:from\s+|import\s*\()['"]node:(?:child_process|net|fs(?:\/promises)?)['"]/,
  /\bprocess\.platform\b/,
  /\btaskkill\b/,
  /\bSIG(?:TERM|KILL)\b/,
  /\b(?:chmod|chmodSync|mkdtemp|mkdtempSync|rename|renameSync|rm|rmSync|symlink|symlinkSync|tmpdir|unlink|unlinkSync|watch|watchFile)\s*\(/
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

function repositoryPath(file) {
  return relative(repositoryRoot, file).split(sep).join(posix.sep);
}

function isTestSupportFile(file) {
  const pathParts = repositoryPath(file).split(posix.sep);
  return pathParts.some(
    (part, index) => part === "__tests__" && pathParts[index + 1] === "support"
  );
}

function relativeImports(source) {
  const imports = [];
  for (const pattern of [staticRelativeImportPattern, dynamicRelativeImportPattern]) {
    for (const match of source.matchAll(pattern)) {
      imports.push(match[1]);
    }
  }
  return imports;
}

function usesPlatformOnlyApi(source) {
  const executableSource = source
    .replace(typeOnlyStaticPlatformImportPattern, "")
    .replace(typeOnlyPlatformImportPattern, "");
  return platformOnlySourcePatterns.some((pattern) => pattern.test(executableSource));
}

function importedFile(importer, specifier) {
  const target = resolve(dirname(importer), specifier);
  const extension = extname(target);
  const candidates = [target];
  if (extension) {
    const base = target.slice(0, -extension.length);
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
      candidates.push(
        ...sourceExtensions.map((candidateExtension) => `${base}${candidateExtension}`)
      );
    }
  } else {
    candidates.push(
      ...sourceExtensions.map((candidateExtension) => `${target}${candidateExtension}`)
    );
    candidates.push(
      ...sourceExtensions.map((candidateExtension) => join(target, `index${candidateExtension}`))
    );
  }
  return candidates.find(
    (candidate) =>
      existsSync(candidate) && statSync(candidate).isFile() && isTestSupportFile(candidate)
  );
}

function platformOnlyImportChain(testFile) {
  const testPath = join(repositoryRoot, testFile);
  const visited = new Set();

  function visit(file, chain) {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const currentChain = [...chain, repositoryPath(file)];
    if (usesPlatformOnlyApi(source)) {
      return currentChain;
    }
    for (const specifier of relativeImports(source)) {
      const imported = importedFile(file, specifier);
      if (imported) {
        const match = visit(imported, currentChain);
        if (match) {
          return match;
        }
      }
    }
  }

  return visit(testPath, []);
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
    const importChain = platformOnlyImportChain(file);
    if (importChain) {
      validationErrors.push(
        `${file} uses platform-only APIs via ${importChain.join(" -> ")} but is assigned to unit.`
      );
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
