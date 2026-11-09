import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export function inspectCollaborationPackageExports({ packageJson, hasTarget, consumerDir }) {
  const packageName = "@planweave-ai/collaboration-protocol";
  const exports = packageJson.exports;
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (packageJson.name !== packageName) throw new Error("collaboration_protocol_name_mismatch");
  if (!isObject(exports) || Object.keys(exports).length === 0) {
    throw new Error(`package_exports_unsupported:${packageName}:expected_explicit_subpaths`);
  }
  const entries = [];
  for (const [subpath, conditions] of Object.entries(exports)) {
    const specifier = subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
    if (subpath === ".") throw new Error("collaboration_protocol_root_export_available");
    if (!/^\.\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(subpath)) {
      throw new Error(
        `package_exports_unsupported:${packageName}:${subpath}:explicit_subpath_required`
      );
    }
    if (!isObject(conditions)) {
      throw new Error(`package_exports_unsupported:${specifier}:types_import_conditions_required`);
    }
    for (const condition of Object.keys(conditions)) {
      if (condition !== "types" && condition !== "import") {
        throw new Error(`package_exports_unsupported:${specifier}:condition=${condition}`);
      }
    }
    for (const condition of ["types", "import"]) {
      const target = conditions[condition];
      if (typeof target !== "string") {
        throw new Error(`package_export_target_invalid:${specifier}:${condition}:string_required`);
      }
      const segments = target.startsWith("./") ? target.slice(2).split("/") : [];
      if (
        segments.length === 0 ||
        segments.some(
          (segment) =>
            !/^[a-zA-Z0-9_.-]+$/.test(segment) ||
            segment === "." ||
            segment === ".." ||
            segment.toLowerCase() === "node_modules"
        ) ||
        !(condition === "types" ? target.endsWith(".d.ts") : target.endsWith(".js"))
      ) {
        throw new Error(`package_export_target_invalid:${specifier}:${condition}:${target}`);
      }
      if (!hasTarget(target.slice(2))) {
        throw new Error(`package_export_target_missing:${specifier}:${condition}:${target}`);
      }
    }
    if (Object.keys(conditions)[0] !== "types") {
      throw new Error(
        `package_exports_unsupported:${specifier}:types_condition_must_precede_import`
      );
    }
    entries.push({ specifier, types: conditions.types, import: conditions.import });
  }
  if (consumerDir) {
    const importScript = join(consumerDir, "collaboration-import-smoke.mjs");
    writeFileSync(
      importScript,
      [
        `const specifiers = ${JSON.stringify(entries.map((entry) => entry.specifier))};`,
        "for (const specifier of specifiers) {",
        "  try { await import(specifier); } catch (error) {",
        "    throw new Error(`package_export_import_failed:${specifier}:${error.code ?? error.message}`);",
        "  }",
        "}",
        "try {",
        `  await import(${JSON.stringify(packageName)});`,
        '  throw new Error("collaboration_protocol_root_export_available");',
        "} catch (error) {",
        '  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;',
        "}"
      ].join("\n")
    );
    try {
      execFileSync(process.execPath, [importScript], {
        cwd: consumerDir,
        encoding: "utf8",
        stdio: "pipe"
      });
    } catch (error) {
      throw new Error(`collaboration_protocol_consumer_import_failed:${error.stderr?.toString()}`, {
        cause: error
      });
    }
    const ts = createRequire(import.meta.url)("typescript");
    const typeScript = join(consumerDir, "collaboration-types-smoke.mts");
    writeFileSync(
      typeScript,
      entries
        .map(
          (entry, index) =>
            `export type Entry${index} = typeof import(${JSON.stringify(entry.specifier)});`
        )
        .join("\n")
    );
    const options = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      types: []
    };
    for (const entry of entries) {
      const resolved = ts.resolveModuleName(
        entry.specifier,
        typeScript,
        options,
        ts.sys
      ).resolvedModule;
      const expected = join(consumerDir, "node_modules", packageName, entry.types);
      if (!resolved || realpathSync(resolved.resolvedFileName) !== realpathSync(expected)) {
        throw new Error(`package_export_types_resolution_failed:${entry.specifier}:${entry.types}`);
      }
    }
    const program = ts.createProgram([typeScript], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      const details = diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.file?.fileName ?? "consumer"}:TS${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`
        )
        .join("\n");
      throw new Error(`collaboration_protocol_consumer_types_failed:${details}`);
    }
  }
  return entries;
}
