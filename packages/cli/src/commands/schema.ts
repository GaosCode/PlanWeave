import type { Command } from "commander";
import { schemaDocuments, schemaTopicOrder, type SchemaDocument, type SchemaTopicName } from "../schemaDocs/index.js";

function formatSchemaDocument(document: SchemaDocument): string {
  return [
    `${document.name}: ${document.summary}`,
    "",
    `Path: ${document.path}`,
    `Ownership: ${document.ownership}`,
    "",
    "Validation:",
    ...document.validation.map((item) => `- ${item}`),
    "",
    "Schema:",
    "```json",
    JSON.stringify(document.schema, null, 2),
    "```",
    "",
    "Notes:",
    ...document.notes.map((note) => `- ${note}`)
  ].join("\n");
}

export function formatSchemaHelp(topicName?: string): string {
  if (topicName === "all") {
    return schemaTopicOrder.map((name) => formatSchemaDocument(schemaDocuments[name])).join("\n\n---\n\n");
  }
  if (topicName && topicName in schemaDocuments) {
    return formatSchemaDocument(schemaDocuments[topicName as SchemaTopicName]);
  }
  const lines = [
    "PlanWeave schema reference",
    "",
    "Use `planweave schema <topic>` for the full schema of one writable/readable structure.",
    "",
    "Topics:",
    "- manifest: package/manifest.json source graph",
    "- project: project-graph.json canvas graph",
    "- state: runtime state.json",
    "- layout: desktop/layout.json",
    "- all: print every schema topic",
    "",
    "Recommended flow:",
    "- planweave paths --json",
    "- planweave schema project",
    "- planweave schema manifest",
    "- planweave edit-task <task-id> --title <title>",
    "- planweave edit-block <block-ref> --review-required false",
    "- use schema manifest to verify fields before structural Plan Package changes",
    "- planweave validate --json"
  ];
  if (topicName) {
    lines.push("", `Unknown schema topic: ${topicName}`);
  }
  return lines.join("\n");
}

function schemaJson(topicName?: string): unknown {
  if (topicName === "all") {
    return { topics: schemaTopicOrder.map((name) => schemaDocuments[name]) };
  }
  if (topicName && topicName in schemaDocuments) {
    return schemaDocuments[topicName as SchemaTopicName];
  }
  return {
    topics: schemaTopicOrder,
    commands: ["schema manifest", "schema project", "schema state", "schema layout", "schema all"],
    selected: topicName ?? null,
    unknown: topicName && topicName !== "all" ? topicName : null
  };
}

export { schemaDocuments };

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema [topic]")
    .description("Show PlanWeave schema reference for project, manifest, state, or desktop layout")
    .option("--json", "print machine-readable output")
    .action((topicName: string | undefined, options: { json?: boolean }) => {
      if (options.json) {
        console.log(JSON.stringify(schemaJson(topicName), null, 2));
        return;
      }
      console.log(formatSchemaHelp(topicName));
    });
}
