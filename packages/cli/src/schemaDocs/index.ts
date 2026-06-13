import { layoutSchemaDocument } from "./layout.js";
import { manifestSchemaDocument } from "./manifest.js";
import { projectSchemaDocument } from "./project.js";
import { stateSchemaDocument } from "./state.js";
import type { SchemaDocument, SchemaTopicName } from "./types.js";

export const schemaTopicOrder: SchemaTopicName[] = ["manifest", "project", "state", "layout"];

export const schemaDocuments: Record<SchemaTopicName, SchemaDocument> = {
  manifest: manifestSchemaDocument,
  project: projectSchemaDocument,
  state: stateSchemaDocument,
  layout: layoutSchemaDocument
};

export type { SchemaDocument, SchemaTopicName } from "./types.js";
