import {
  authoringRules,
  exampleFiles,
  exampleTemplates,
  getPackageExampleFiles,
  planweaveGuide
} from "../toolDocs.js";
import { compatOnlyToolGroups, defaultToolGroups } from "../toolGroups.js";
import {
  jsonToolResult,
  optionalNonEmptyString,
  parseGetSchemaArgs,
  readObjectArgs
} from "../toolHelpers.js";
import type { PlanweavePartialToolHandlerRegistry } from "../toolDispatcher.js";

export const authoringToolHandlers = {
  list_tool_groups: async () =>
    jsonToolResult({ groups: defaultToolGroups, compatOnlyGroups: compatOnlyToolGroups }),
  get_schema: async (args, gateway) => {
    const { topic } = parseGetSchemaArgs(args);
    const documents = gateway.getSchemaDocuments();
    if (!topic) {
      return jsonToolResult({
        topic: null,
        topics: Object.values(documents).map(({ name, summary, path, ownership }) => ({
          name,
          summary,
          path,
          ownership
        })),
        documents: {}
      });
    }
    return jsonToolResult({ topic, documents: { [topic]: documents[topic] } });
  },
  get_planweave_guide: async () => jsonToolResult({ guide: planweaveGuide }),
  get_authoring_rules: async () => jsonToolResult({ rules: [...authoringRules] }),
  get_plan_package_examples: async (args) => {
    const record = args === undefined || args === null ? {} : readObjectArgs(args);
    const template = optionalNonEmptyString(record.template, "template");
    const files = template ? getPackageExampleFiles(template) : undefined;
    if (template && !files) {
      throw new Error(`Unknown package example template '${template}'.`);
    }
    return jsonToolResult({
      examples: exampleTemplates,
      files,
      notes: template
        ? [
            "Write these files to a draft root, then use validate_package_draft, validate_graph_quality, preview_package_import, import_package_draft, and apply_canvas_lane_layout."
          ]
        : [
            'Pass template: "basic" or template: "large_dag_with_review_loop" to return a selected file set.'
          ]
    });
  },
  get_plan_package_example: async () =>
    jsonToolResult({
      files: exampleFiles,
      notes: [
        "Write these files to a draft root, then use validate_package_draft and preview_package_import before import_package_draft."
      ]
    })
} satisfies PlanweavePartialToolHandlerRegistry;
