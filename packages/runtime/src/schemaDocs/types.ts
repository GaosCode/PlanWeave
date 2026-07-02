export const runtimeSchemaTopicOrder = ["manifest", "project", "state", "layout"] as const;

export type RuntimeSchemaTopicName = (typeof runtimeSchemaTopicOrder)[number];

export type SchemaDocument<Name extends string = RuntimeSchemaTopicName> = {
  name: Name;
  summary: string;
  path: string;
  ownership: string;
  validation: string[];
  schema: Record<string, unknown>;
  notes: string[];
};
