import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(process.argv[2] ?? process.cwd());
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8"
  }
)
  .split("\0")
  .filter((file) => sourceExtensions.includes(extname(file)));
const directoryEntries = new Map();

function actualCase(path) {
  const parts = relative(root, path).split(sep);
  if (parts[0] === "..") return null;
  let current = root;
  for (const part of parts) {
    let entries = directoryEntries.get(current);
    if (!entries) {
      try {
        entries = readdirSync(current);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      }
      directoryEntries.set(current, entries);
    }
    const match =
      entries.find((entry) => entry === part) ??
      entries.find((entry) => entry.toLowerCase() === part.toLowerCase());
    if (!match) return null;
    current = join(current, match);
  }
  return current;
}

function candidates(path) {
  const extension = extname(path);
  if (extension === ".js") return [path.slice(0, -3) + ".ts", path.slice(0, -3) + ".tsx", path];
  if (extension === ".mjs") return [path.slice(0, -4) + ".mts", path];
  if (extension === ".cjs") return [path.slice(0, -4) + ".cts", path];
  if (extension) return [path];
  return sourceExtensions.flatMap((ext) => [path + ext, join(path, "index" + ext)]);
}

const errors = [];
for (const file of new Set(files)) {
  const path = join(root, file);
  const ast = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      specifier = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      specifier = node.argument.literal;
    if (specifier && ts.isStringLiteralLike(specifier) && /^\.{1,2}\//.test(specifier.text)) {
      const paths = candidates(resolve(dirname(path), specifier.text));
      const matches = paths.map((candidate) => ({ candidate, actual: actualCase(candidate) }));
      // Missing generated outputs are checked by build/typecheck; this guard owns casing.
      if (!matches.some(({ candidate, actual }) => candidate === actual)) {
        const mismatch = matches.find(({ actual }) => actual !== null);
        if (mismatch)
          errors.push(
            `${file}: import path casing mismatch: ${specifier.text} -> ${relative(root, mismatch.actual)}`
          );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`Source import casing checked (${new Set(files).size} files).`);
