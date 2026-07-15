import { describe, expect, it } from "vitest";
import {
  layoutSchemaDocument as runtimeLayoutSchemaDocument,
  manifestSchemaDocument as runtimeManifestSchemaDocument,
  projectSchemaDocument as runtimeProjectSchemaDocument,
  runtimeSchemaDocuments,
  runtimeSchemaTopicOrder,
  stateSchemaDocument as runtimeStateSchemaDocument
} from "@planweave-ai/runtime";
import { formatCliHelp, planweaveHelpTopics } from "../commands/help.js";
import { formatSchemaHelp, schemaDocuments } from "../commands/schema.js";

describe("planweave CLI help and schema output", () => {
  it("prints PlanWeave-specific help topics for agent CLI workflows", () => {
    expect(planweaveHelpTopics.map((topic) => topic.name)).toEqual([
      "setup",
      "schema",
      "plan",
      "work",
      "submit",
      "explain",
      "recovery",
      "autorun"
    ]);
    expect(formatCliHelp()).toContain("Common agent loop:");
    expect(formatCliHelp("schema")).toContain("planweave schema project");
    expect(formatCliHelp("schema")).toContain("planweave schema manifest");
    expect(formatCliHelp("schema")).toContain(
      "Use schema project before writing formal multi-canvas project-graph.json."
    );
    expect(formatCliHelp("schema")).toContain(
      "Do not hand-author project graph, manifest, state, or layout from memory."
    );
    expect(formatCliHelp("work")).toContain("planweave claim-next --parallel --dry-run");
    expect(formatCliHelp("work")).toContain("planweave status --json --canvas <canvasId>");
    expect(formatCliHelp("work")).toContain("CLI commands target the current or first canvas");
    expect(formatCliHelp("submit")).toContain(
      "planweave submit-review <review-block-ref> --result <review-result.json>"
    );
    expect(formatCliHelp("submit")).toContain(
      "planweave submit-result --canvas <canvasId> <block-ref> --report <report.md>"
    );
    expect(formatCliHelp("autorun")).toContain(
      "planweave run --reset --force --reason <reason> --json"
    );
    expect(formatCliHelp("autorun")).toContain(
      "planweave run --scope task --task <task-id> --once --json"
    );
    expect(formatCliHelp("autorun")).toContain(
      "planweave run --scope block --block <block-ref> --once --json"
    );
    expect(formatCliHelp("autorun")).toContain("planweave reset --force --reason <reason> --json");
    expect(formatCliHelp("autorun")).toContain("planweave run-sessions --json");
    expect(formatCliHelp("autorun")).toContain("planweave run-session <session-id> --json");
    expect(formatCliHelp("autorun")).toContain("CLI and ACP are alternative transports");
    expect(formatCliHelp("autorun")).toContain("tmux monitoring is CLI-only");
    expect(formatCliHelp("autorun")).toContain("does not collect a separate ACP provider API key");
    expect(formatCliHelp("autorun")).toContain("Headless ACP runs never auto-approve");
    expect(formatCliHelp("autorun")).toContain("run-status --follow --json");
    expect(formatCliHelp("autorun")).toContain("init --reset-package resets package source files");
    expect(formatCliHelp("recovery")).toContain("planweave doctor --repair");
    expect(formatCliHelp("recovery")).toContain(
      "planweave retry-review <review-block-ref> --max-feedback-cycles 3"
    );
    expect(formatCliHelp("plan")).toContain(
      "planweave edit-block <block-ref> --review-required false"
    );
    expect(formatCliHelp("plan")).toContain(
      "planweave edit-block <block-ref> --shared-resources api,db"
    );
    expect(formatCliHelp("plan")).not.toMatch(/parallel-safe|parallel-locks|exclusive/);
    expect(formatCliHelp("recovery")).toContain(
      "Doctor checks state/results consistency; it is not a general Plan Package repair tool."
    );
    expect(formatCliHelp("recovery")).toContain(
      "Fix bad dependencies, unsafe parallelization, missing prompts, or review-gate design"
    );
  });

  it("prints focused schema navigation and full schema topics", () => {
    expect(formatSchemaHelp()).toContain("Use `planweave schema <topic>`");
    expect(formatSchemaHelp()).toContain("planweave schema project");
    expect(formatSchemaHelp()).toContain("planweave schema manifest");
    expect(formatSchemaHelp()).toContain("planweave edit-task <task-id>");
    expect(formatSchemaHelp()).toContain("planweave edit-block <block-ref>");
    expect(formatSchemaHelp()).not.toContain("edit package/manifest.json");
    expect(formatSchemaHelp("project")).toContain('"plan-project/v1"');
    expect(formatSchemaHelp("project")).toContain("from waits for to");
    expect(formatSchemaHelp("manifest")).toContain('"plan-package/v1"');
    expect(formatSchemaHelp("manifest")).toContain("Only task nodes are supported");
    expect(formatSchemaHelp("manifest")).toContain(
      "Only implementation and review block types are supported."
    );
    expect(formatSchemaHelp("manifest")).toContain(
      "Agent identity and runner transport are separate."
    );
    expect(formatSchemaHelp("manifest")).toContain("does not require a PlanWeave API key");
    expect(formatSchemaHelp("manifest")).toContain(
      "explicit *-acp names, including ACP-only grok-acp, select ACP"
    );
    expect(formatSchemaHelp("manifest")).toContain(
      '\\"codex\\" | \\"opencode\\" | \\"claude-code\\" | \\"pi\\" | \\"grok\\"'
    );
    expect(formatSchemaHelp("manifest")).toContain("ACP-only grok-acp");
    expect(formatSchemaHelp("state")).toContain('"planned"');
    expect(formatSchemaHelp("state")).toContain('"implemented"');
    expect(formatSchemaHelp("layout")).toContain('"desktop-layout/v1"');
    expect(formatSchemaHelp("layout")).toContain("legacy_layout_schema");
    expect(formatSchemaHelp("all")).toContain("manifest: Plan Package source graph schema.");
    expect(formatSchemaHelp("all")).toContain("project: Project-level canvas graph schema.");
    expect(schemaDocuments.manifest.schema).toHaveProperty("nodes");
    expect(schemaDocuments.project.schema).toHaveProperty("canvases");
    expect(schemaDocuments.state.schema).toHaveProperty("tasks");
    expect(schemaDocuments.layout.schema).toHaveProperty("nodes");
    expect(schemaDocuments).toBe(runtimeSchemaDocuments);
    expect(Object.keys(schemaDocuments)).toEqual([...runtimeSchemaTopicOrder]);
    expect(schemaDocuments.manifest).toBe(runtimeManifestSchemaDocument);
    expect(schemaDocuments.project).toBe(runtimeProjectSchemaDocument);
    expect(schemaDocuments.state).toBe(runtimeStateSchemaDocument);
    expect(schemaDocuments.layout).toBe(runtimeLayoutSchemaDocument);
  });
});
