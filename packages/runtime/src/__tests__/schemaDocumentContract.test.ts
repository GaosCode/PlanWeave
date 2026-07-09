import { describe, expect, it } from "vitest";
import {
  edgeTypes,
  executorAdapters,
  reviewTriggerConditions,
  supportedManifestVersion
} from "../types.js";
import { manifestSchemaTopLevelFields } from "../schema/manifest.js";
import { projectGraphEdgeTypes, supportedProjectGraphVersion } from "../projectGraph/types.js";
import { projectGraphManifestSchemaTopLevelFields } from "../projectGraph/schema.js";
import {
  layoutSchemaDocument,
  manifestSchemaDocument,
  projectSchemaDocument,
  runtimeSchemaDocuments,
  runtimeSchemaTopicOrder,
  stateSchemaDocument
} from "../schemaDocs/index.js";

describe("runtime schema documents", () => {
  it("exposes the complete runtime schema topic registry in one order", () => {
    expect(runtimeSchemaTopicOrder).toEqual(["manifest", "project", "state", "layout"]);
    expect(Object.keys(runtimeSchemaDocuments)).toEqual([...runtimeSchemaTopicOrder]);
  });

  it("keeps manifest document top-level fields aligned with the Zod schema shape", () => {
    expect(Object.keys(manifestSchemaDocument.schema).sort()).toEqual(
      [...manifestSchemaTopLevelFields].sort()
    );
  });

  it("keeps project document top-level fields aligned with the Zod schema shape", () => {
    expect(Object.keys(projectSchemaDocument.schema).sort()).toEqual(
      [...projectGraphManifestSchemaTopLevelFields].sort()
    );
  });

  it("documents manifest version and key enums from runtime constants", () => {
    const documentText = JSON.stringify(manifestSchemaDocument.schema);
    for (const value of [
      supportedManifestVersion,
      ...edgeTypes,
      ...executorAdapters,
      ...reviewTriggerConditions
    ]) {
      expect(documentText).toContain(value);
    }
  });

  it("documents project graph version and edge types from runtime constants", () => {
    const documentText = JSON.stringify(projectSchemaDocument.schema);
    for (const value of [supportedProjectGraphVersion, ...projectGraphEdgeTypes]) {
      expect(documentText).toContain(value);
    }
  });

  it("documents runtime state and desktop layout topics", () => {
    expect(stateSchemaDocument.name).toBe("state");
    expect(stateSchemaDocument.schema).toHaveProperty("tasks");
    expect(stateSchemaDocument.schema).toHaveProperty("blocks");
    expect(stateSchemaDocument.schema).toHaveProperty("feedback");
    expect(layoutSchemaDocument.name).toBe("layout");
    expect(layoutSchemaDocument.schema).toHaveProperty("version", "desktop-layout/v1");
    expect(layoutSchemaDocument.schema).toHaveProperty("nodes");
  });
});
