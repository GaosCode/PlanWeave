import { projectGraphEdgeTypes, supportedProjectGraphVersion } from "../projectGraph/types.js";
import type { SchemaDocument } from "./types.js";

export const projectSchemaDocument: SchemaDocument<"project"> = {
  name: "project",
  summary: "Project-level canvas graph schema.",
  path: "project-graph.json inside the CLI-returned workspaceRoot",
  ownership:
    "User/agent editable project graph source. Do not write runtime state, results, or desktop layout here.",
  validation: ["planweave validate --json", "planweave schema project"],
  schema: {
    version: supportedProjectGraphVersion,
    canvases: [
      {
        id: "CLI-safe canvas id, unique; start with letter/number, then letters/numbers/dot/underscore/hyphen",
        type: "canvas",
        title: "string, non-empty",
        description: "string, optional",
        packageDir:
          "workspaceRoot-relative package directory; default canvas uses canvases/default/package",
        stateFile:
          "workspaceRoot-relative runtime state file; default canvas uses canvases/default/state.json",
        resultsDir:
          "workspaceRoot-relative results directory; default canvas uses canvases/default/results"
      }
    ],
    edges: [
      { from: "CLI-safe canvas id", to: "CLI-safe canvas id", type: projectGraphEdgeTypes[0] }
    ],
    crossTaskEdges: [
      {
        from: { canvasId: "CLI-safe canvas id", taskId: "task id string" },
        to: { canvasId: "CLI-safe canvas id", taskId: "task id string" },
        type: projectGraphEdgeTypes[0]
      }
    ]
  },
  notes: [
    "PlanWeave stores project metadata, project graph, policy, cache, and desktop files under workspaceRoot; each canvas points to its own package, state, and results paths.",
    "The default canvas canonical paths are packageDir=canvases/default/package, stateFile=canvases/default/state.json, and resultsDir=canvases/default/results.",
    "External projects use the source directory as rootPath; managed projects can bind an optional sourceRoot while keeping plan files under workspaceRoot.",
    "Canvas ids must be CLI-safe because generated agent commands pass them to --canvas without shell quoting.",
    "Use canvas edges only when the whole downstream canvas waits for the whole upstream canvas.",
    "Use crossTaskEdges when only specific tasks have cross-canvas ordering.",
    "Use block parallel.locks for write conflicts that have no logical ordering.",
    "Edge direction matches manifest task edges: from depends_on to, so from waits for to.",
    "Desktop layout stores canvas coordinates only; canvas dependencies belong in this schema."
  ]
};
