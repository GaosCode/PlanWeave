export type SchemaTopicName = "manifest" | "project" | "state" | "layout";

export type SchemaDocument = {
  name: SchemaTopicName;
  summary: string;
  path: string;
  ownership: string;
  validation: string[];
  schema: Record<string, unknown>;
  notes: string[];
};
