import type { SchemaDocument } from "./types.js";

export const projectSchemaDocument: SchemaDocument = {
  name: "project",
  summary: "Project-level canvas graph schema.",
  path: "project-graph.json inside the CLI-returned workspaceRoot",
  ownership: "User/agent editable project graph source. Do not write runtime state, results, or desktop layout here.",
  validation: ["planweave validate --json", "planweave schema project"],
  schema: {
    version: "plan-project/v1",
    canvases: [
      {
        id: "canvas id string, non-empty and unique in this project graph",
        type: "canvas",
        title: "string, non-empty",
        description: "string, optional",
        packageDir: "workspaceRoot-relative package directory",
        stateFile: "workspaceRoot-relative runtime state file",
        resultsDir: "workspaceRoot-relative results directory"
      }
    ],
    edges: [{ from: "canvas id string", to: "canvas id string", type: "depends_on" }],
    crossTaskEdges: [
      {
        from: { canvasId: "canvas id string", taskId: "task id string" },
        to: { canvasId: "canvas id string", taskId: "task id string" },
        type: "depends_on"
      }
    ]
  },
  notes: [
    "Use canvas edges only when the whole downstream canvas waits for the whole upstream canvas.",
    "Use crossTaskEdges when only specific tasks have cross-canvas ordering.",
    "Use block parallel.locks for write conflicts that have no logical ordering.",
    "Edge direction matches manifest task edges: from depends_on to, so from waits for to.",
    "Desktop layout stores canvas coordinates only; canvas dependencies belong in this schema."
  ]
};
