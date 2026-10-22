import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { importManagedPackage } from "../../../../runtime/src/package/managedPackageImport.js";
import { applyPackageDraftImport } from "../../../../runtime/src/package/packageDraftImport.js";
import {
  canonicalProjectCanvasNode,
  projectGraphSchema
} from "../../../../runtime/src/projectGraph/index.js";
import { createTaskCanvas } from "../../../../runtime/src/desktop/canvasApi.js";
import { selectTaskCanvas } from "../../../../runtime/src/desktop/canvasSelectionApi.js";
import {
  basicManifest,
  writePromptFiles
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";

// Native ESM keeps the checkpoint fault at the filesystem boundary used by the runtime.
const home = process.argv[2];
if (!home) throw new Error("Expected a test-owned Home");
process.env.PLANWEAVE_HOME = home;
process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(home, "settings.json");
const source = join(home, "source");
await fs.mkdir(source);
const manifest = basicManifest();
await fs.writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
await writePromptFiles(source, manifest);
const { workspace } = await importManagedPackage({
  name: "Surviving project",
  draftRoot: source,
  overwrite: false
});
await createTaskCanvas(workspace.rootPath, { name: "Existing canvas" });
await selectTaskCanvas(workspace.rootPath, "default");
await importManagedPackage({ name: "Other project", draftRoot: source, overwrite: false });
const draft = join(home, "project-draft");
const projectGraph = projectGraphSchema.parse(
  JSON.parse(await fs.readFile(join(workspace.workspaceRoot, "project-graph.json"), "utf8"))
);
projectGraph.canvases.push(
  canonicalProjectCanvasNode({ id: "imported", title: "Imported canvas" })
);
await fs.mkdir(draft);
await fs.writeFile(join(draft, "project-graph.json"), JSON.stringify(projectGraph));
for (const canvas of projectGraph.canvases) {
  await fs.mkdir(join(draft, canvas.packageDir), { recursive: true });
  await fs.cp(source, join(draft, canvas.packageDir), { recursive: true });
}
const rename = fs.rename;
let injected = false;
fs.rename = async (...args) => {
  if (!injected && String(args[1]).endsWith("/recovery.json")) {
    const value = JSON.parse(await fs.readFile(args[0], "utf8"));
    if (value.state === "committed") {
      injected = true;
      throw Object.assign(new Error("commit checkpoint interrupted"), { code: "EIO" });
    }
  }
  return rename(...args);
};
syncBuiltinESMExports();
try {
  await assert.rejects(
    applyPackageDraftImport({ projectRoot: workspace.rootPath, draftRoot: draft }),
    /commit checkpoint interrupted/
  );
  assert.equal(injected, true);
} finally {
  fs.rename = rename;
  syncBuiltinESMExports();
}
