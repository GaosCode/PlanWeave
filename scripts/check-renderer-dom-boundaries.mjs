import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const desktopSrc = process.env.PLANWEAVE_DOM_BOUNDARY_DESKTOP_SRC
  ? resolve(process.env.PLANWEAVE_DOM_BOUNDARY_DESKTOP_SRC)
  : resolve(repoRoot, "packages", "desktop", "src");

const allowedFiles = new Set([
  "packages/desktop/src/main/smoke.ts",
  "packages/desktop/src/renderer/main.tsx",
  "packages/desktop/src/renderer/hooks/useAutoRunControl.ts",
  "packages/desktop/src/renderer/hooks/useAppViewHistory.ts",
  "packages/desktop/src/renderer/hooks/useDesktopSettingsEffects.ts",
  "packages/desktop/src/renderer/hooks/useElementBounds.ts",
  "packages/desktop/src/renderer/hooks/useFocusManagement.ts",
  "packages/desktop/src/renderer/hooks/useResizableSidebarLayout.ts"
]);

const bannedPatterns = [
  { name: "document.querySelector", pattern: /\bdocument\.querySelector\s*\(/ },
  { name: "document.querySelectorAll", pattern: /\bdocument\.querySelectorAll\s*\(/ },
  { name: "document.getElementById", pattern: /\bdocument\.getElementById\s*\(/ },
  { name: "innerHTML", pattern: /\binnerHTML\b/ },
  { name: "textContent", pattern: /\btextContent\b/ },
  { name: "classList", pattern: /\bclassList\b/ }
];

function toRepoPath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function isSourceFile(path) {
  return [".ts", ".tsx"].includes(extname(path));
}

function isTestPath(repoPath) {
  return (
    repoPath.includes("/__tests__/") ||
    repoPath.endsWith(".test.ts") ||
    repoPath.endsWith(".test.tsx") ||
    repoPath.endsWith(".spec.ts") ||
    repoPath.endsWith(".spec.tsx")
  );
}

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(path)));
      continue;
    }
    if (entry.isFile() && isSourceFile(path)) {
      files.push(path);
    }
  }

  return files;
}

function findViolations(repoPath, source) {
  if (allowedFiles.has(repoPath) || isTestPath(repoPath)) {
    return [];
  }

  return source.split("\n").flatMap((line, index) =>
    bannedPatterns
      .filter(({ pattern }) => pattern.test(line))
      .map(({ name }) => ({
        line: index + 1,
        name,
        repoPath
      }))
  );
}

const sourceFiles = await collectSourceFiles(desktopSrc);
const violations = [];

for (const file of sourceFiles) {
  const repoPath = toRepoPath(file);
  const source = await readFile(file, "utf8");
  violations.push(...findViolations(repoPath, source));
}

if (violations.length > 0) {
  console.error(
    "DOM boundary check failed. Move DOM access into an approved boundary file or hook:"
  );
  for (const violation of violations) {
    console.error(`- ${violation.repoPath}:${violation.line} uses ${violation.name}`);
  }
  process.exit(1);
}

console.log(`DOM boundary check passed (${sourceFiles.length} files scanned).`);
