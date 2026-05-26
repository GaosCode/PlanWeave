import type { SchemaDocument } from "./types.js";

export const layoutSchemaDocument: SchemaDocument = {
  name: "layout",
  summary: "Desktop graph layout schema.",
  path: "desktop/layout.json under the PlanWeave workspace, outside package/manifest.json",
  ownership: "Desktop/runtime owned. Importers should not hand-author it unless a dedicated layout command or desktop API is used.",
  validation: ["planweave validate --json reports stale layout references"],
  schema: {
    version: "desktop-layout/v1",
    projectId: "PlanWeave project id string",
    nodes: [{ nodeId: "task node id string; must reference a manifest task node", x: "number", y: "number" }],
    updatedAt: "ISO timestamp string"
  },
  notes: [
    "Layout stores only desktop positions for task nodes.",
    "Missing layout is valid; desktop/runtime can return an empty default layout.",
    "Layout node references that no longer exist in manifest are ignored by the desktop API and reported as validation warnings.",
    "Do not put layout data into package/manifest.json."
  ]
};
