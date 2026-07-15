import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const runtimeEntry = process.env.PLANWEAVE_BROWSER_BOUNDARY_RUNTIME_ENTRY
  ? resolve(process.env.PLANWEAVE_BROWSER_BOUNDARY_RUNTIME_ENTRY)
  : resolve(repoRoot, "packages", "runtime", "src", "browser.ts");
const rendererSrc = process.env.PLANWEAVE_BROWSER_BOUNDARY_RENDERER_SRC
  ? resolve(process.env.PLANWEAVE_BROWSER_BOUNDARY_RENDERER_SRC)
  : resolve(repoRoot, "packages", "desktop", "src", "renderer");
const browserSafePackages = new Set(["zod"]);

function toDisplayPath(path) {
  return relative(repoRoot, path).split(sep).join("/") || path;
}

function isRuntimeImport(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return bindings !== undefined;
    return bindings.elements.some((element) => !element.isTypeOnly);
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return false;
    return (
      node.exportClause === undefined ||
      !ts.isNamedExports(node.exportClause) ||
      node.exportClause.elements.some((element) => !element.isTypeOnly)
    );
  }
  return false;
}

function runtimeSpecifiers(path, source) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const specifiers = sourceFile.statements.flatMap((node) => {
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      return [
        {
          specifier: node.moduleReference.expression.text,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
        }
      ];
    }
    if (
      (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) ||
      !node.moduleSpecifier ||
      !isRuntimeImport(node)
    ) {
      return [];
    }
    return [
      {
        specifier: node.moduleSpecifier.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      }
    ];
  });
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push({
        specifier: node.arguments[0].text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      });
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

async function resolveSourceImport(parentPath, specifier) {
  const candidate = resolve(
    parentPath,
    "..",
    specifier.replace(/\.js$/u, ".ts").replace(/\.jsx$/u, ".tsx")
  );
  try {
    await readFile(candidate);
    return candidate;
  } catch {
    const indexCandidate = resolve(candidate.replace(/\.tsx?$/u, ""), "index.ts");
    await readFile(indexCandidate);
    return indexCandidate;
  }
}

async function collectBrowserBoundaryViolations(entryPath) {
  const pending = [entryPath];
  const visited = new Set();
  const violations = [];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    for (const imported of runtimeSpecifiers(path, source)) {
      if (imported.specifier.startsWith("node:")) {
        violations.push({ path, ...imported, reason: "imports Node builtin" });
      } else if (imported.specifier.startsWith(".")) {
        pending.push(await resolveSourceImport(path, imported.specifier));
      } else if (!browserSafePackages.has(imported.specifier)) {
        violations.push({
          path,
          ...imported,
          reason: "imports a runtime package outside the browser-safe allowlist"
        });
      }
    }
  }
  return { violations, visitedCount: visited.size };
}

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(path)));
    else if (entry.isFile() && [".ts", ".tsx"].includes(extname(path))) files.push(path);
  }
  return files;
}

async function collectRendererRootImports(dir) {
  const violations = [];
  for (const path of await collectSourceFiles(dir)) {
    if (path.includes(`${sep}__tests__${sep}`)) continue;
    const source = await readFile(path, "utf8");
    for (const imported of runtimeSpecifiers(path, source)) {
      if (
        imported.specifier.startsWith("@planweave-ai/runtime") &&
        imported.specifier !== "@planweave-ai/runtime/browser"
      ) {
        violations.push({ path, ...imported });
      }
    }
  }
  return violations;
}

const runtime = await collectBrowserBoundaryViolations(runtimeEntry);
const rendererViolations = await collectRendererRootImports(rendererSrc);
const violations = [
  ...runtime.violations.map(
    (violation) =>
      `${toDisplayPath(violation.path)}:${violation.line} ${violation.reason}: ${violation.specifier}`
  ),
  ...rendererViolations.map(
    (violation) =>
      `${toDisplayPath(violation.path)}:${violation.line} uses runtime value import ${violation.specifier}`
  )
];

if (violations.length > 0) {
  console.error("Runtime browser boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `Runtime browser boundary check passed (${runtime.visitedCount} runtime modules scanned).`
);
