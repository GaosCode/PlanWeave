import { layoutSchemaDocument } from "./layout.js";
import { manifestSchemaDocument } from "./manifest.js";
import { projectSchemaDocument } from "./project.js";
import { stateSchemaDocument } from "./state.js";
import type { RuntimeSchemaTopicName, SchemaDocument } from "./types.js";

export const runtimeSchemaDocuments: Record<RuntimeSchemaTopicName, SchemaDocument> = {
  manifest: manifestSchemaDocument,
  project: projectSchemaDocument,
  state: stateSchemaDocument,
  layout: layoutSchemaDocument
};

export { layoutSchemaDocument } from "./layout.js";
export { manifestSchemaDocument } from "./manifest.js";
export { projectSchemaDocument } from "./project.js";
export { stateSchemaDocument } from "./state.js";
export { runtimeSchemaTopicOrder } from "./types.js";
export type { RuntimeSchemaTopicName, SchemaDocument } from "./types.js";
