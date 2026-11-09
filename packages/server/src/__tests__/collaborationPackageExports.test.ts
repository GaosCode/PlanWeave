import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCollaborationPackageExports } from "../../../../scripts/collaboration-package-exports.mjs";

const packageName = "@planweave-ai/collaboration-protocol";
const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "planweave-export-contract-"));
  temporaryRoots.push(root);
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  const manifest = {
    name: packageName,
    type: "module",
    version: "0.0.0",
    exports: {
      "./existing": { types: "./dist/base.d.ts", import: "./dist/base.js" },
      "./future/added": { types: "./dist/novel.d.ts", import: "./dist/novel.js" }
    } as Record<string, unknown>
  };
  writeFileSync(join(packageRoot, "dist/base.js"), "export const base = 1;");
  writeFileSync(join(packageRoot, "dist/base.d.ts"), "export declare const base: number;");
  const marker = join(root, "added-imported");
  writeFileSync(
    join(packageRoot, "dist/novel.js"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "visited"); export const added = 2;`
  );
  writeFileSync(join(packageRoot, "dist/novel.d.ts"), "export declare const added: number;");
  const save = () => writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest));
  const tarball = () => {
    save();
    const archive = join(root, "protocol.tgz");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n");
    const packageJson = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })
    );
    return inspectCollaborationPackageExports({
      packageJson,
      hasTarget: (target: string) => listing.includes(`package/${target}`)
    });
  };
  const consumer = () => {
    save();
    const consumerDir = join(root, "consumer");
    const installedRoot = join(consumerDir, "node_modules", packageName);
    mkdirSync(join(consumerDir, "node_modules/@planweave-ai"), { recursive: true });
    cpSync(packageRoot, installedRoot, { recursive: true });
    return inspectCollaborationPackageExports({
      packageJson: JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")),
      hasTarget: (target: string) => {
        const path = join(installedRoot, target);
        return existsSync(path) && statSync(path).isFile();
      },
      consumerDir
    });
  };
  return { manifest, packageRoot, marker, tarball, consumer };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collaboration package exports smoke owner", () => {
  it("discovers a newly packed subpath and imports its mapped target from a consumer", () => {
    const pkg = fixture();
    const expected = [
      { specifier: `${packageName}/existing`, types: "./dist/base.d.ts", import: "./dist/base.js" },
      {
        specifier: `${packageName}/future/added`,
        types: "./dist/novel.d.ts",
        import: "./dist/novel.js"
      }
    ];
    expect(pkg.tarball()).toEqual(expected);
    expect(pkg.consumer()).toEqual(expected);
    expect(readFileSync(pkg.marker, "utf8")).toBe("visited");
  });

  it.each([
    ["novel.js", "import", "./dist/novel.js"],
    ["novel.d.ts", "types", "./dist/novel.d.ts"]
  ])("rejects a newly exported missing %s in both package boundaries", (file, condition, target) => {
    const pkg = fixture();
    rmSync(join(pkg.packageRoot, "dist", file));
    const error = `package_export_target_missing:${packageName}/future/added:${condition}:${target}`;
    expect(() => pkg.tarball()).toThrow(error);
    expect(() => pkg.consumer()).toThrow(error);
  });

  it.each([
    ["../escaped.js", "invalid"],
    ["/absolute.js", "invalid"],
    ["./dist/../base.js", "invalid"],
    ["./node_modules/other.js", "invalid"],
    ["./dist/%2e%2e/base.js", "invalid"],
    ["./dist/absent.js", "missing"]
  ])("rejects an invalid or nonexistent export mapping %s", (target, kind) => {
    const pkg = fixture();
    pkg.manifest.exports["./future/added"] = { types: "./dist/novel.d.ts", import: target };
    expect(() => pkg.tarball()).toThrow(
      `package_export_target_${kind}:${packageName}/future/added:import:${target}`
    );
  });

  it.each([
    [
      "./future/*",
      { types: "./dist/novel.d.ts", import: "./dist/novel.js" },
      "explicit_subpath_required"
    ],
    [
      "./future/added",
      { types: "./dist/novel.d.ts", import: { node: "./dist/novel.js" } },
      "string_required"
    ],
    [
      "./future/added",
      { types: "./dist/novel.d.ts", import: "./dist/novel.js", default: "./dist/novel.js" },
      "condition=default"
    ]
  ])("fails explicitly for an unsupported exports shape %s", (subpath, conditions, reason) => {
    const pkg = fixture();
    delete pkg.manifest.exports["./future/added"];
    pkg.manifest.exports[subpath] = conditions;
    expect(() => pkg.tarball()).toThrow(reason);
    expect(() => pkg.consumer()).toThrow(reason);
  });

  it("keeps root export denial independent of discovered subpaths", () => {
    const pkg = fixture();
    pkg.manifest.exports["."] = { types: "./dist/base.d.ts", import: "./dist/base.js" };
    expect(() => pkg.tarball()).toThrow("collaboration_protocol_root_export_available");
    expect(() => pkg.consumer()).toThrow("collaboration_protocol_root_export_available");
  });

  it("reports the newly exported specifier when its JavaScript cannot import", () => {
    const pkg = fixture();
    writeFileSync(join(pkg.packageRoot, "dist/novel.js"), 'import "fixture-missing-dependency";');
    expect(() => pkg.consumer()).toThrow(
      `package_export_import_failed:${packageName}/future/added:ERR_MODULE_NOT_FOUND`
    );
  });

  it("resolves declarations and their dependencies in the consumer", () => {
    const pkg = fixture();
    writeFileSync(
      join(pkg.packageRoot, "dist/novel.d.ts"),
      'export { Missing } from "fixture-missing-type-dependency";'
    );
    expect(() => pkg.consumer()).toThrow(/consumer_types_failed:.*novel\.d\.ts:TS2307:/);
  });
});
