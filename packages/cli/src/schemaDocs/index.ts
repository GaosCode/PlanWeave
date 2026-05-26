import { layoutSchemaDocument } from "./layout.js";
import { manifestSchemaDocument } from "./manifest.js";
import { stateSchemaDocument } from "./state.js";
import type { SchemaDocument, SchemaTopicName } from "./types.js";

export const schemaTopicOrder: SchemaTopicName[] = ["manifest", "state", "layout"];

export const schemaDocuments: Record<SchemaTopicName, SchemaDocument> = {
  manifest: manifestSchemaDocument,
  state: stateSchemaDocument,
  layout: layoutSchemaDocument
};

export type { SchemaDocument, SchemaTopicName } from "./types.js";
