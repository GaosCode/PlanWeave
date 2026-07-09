export const toolGroups = [
  {
    name: "authoring_start",
    purpose: "Start a PlanWeave authoring workflow with lightweight guidance.",
    recommendedTools: [
      "list_tool_groups",
      "get_planweave_guide",
      "get_authoring_rules",
      "create_project",
      "get_plan_package_examples"
    ]
  },
  {
    name: "graph_read",
    purpose: "Inspect canvas graphs without returning prompt bodies or Desktop-only DTOs.",
    recommendedTools: [
      "get_graph_summary",
      "list_tasks",
      "get_graph_slice",
      "validate_graph_quality"
    ]
  },
  {
    name: "package_draft_import",
    purpose: "Validate, preview, and transactionally import package-shaped drafts.",
    recommendedTools: ["validate_package_draft", "preview_package_import", "import_package_draft"]
  },
  {
    name: "content_debug",
    purpose: "Read package files, prompt sources, or one rendered prompt by explicit selector.",
    recommendedTools: [
      "list_package_files",
      "read_package_file",
      "read_prompt_source",
      "get_rendered_prompt",
      "get_prompt_sources"
    ]
  },
  {
    name: "precision_edit",
    purpose: "Make local graph edits with semantic dependency parameters.",
    recommendedTools: [
      "add_task_dependency",
      "remove_task_dependency",
      "set_task_dependencies",
      "set_block_dependencies",
      "bulk_create_tasks",
      "bulk_create_blocks",
      "bulk_update_tasks",
      "bulk_update_blocks",
      "bulk_remove_graph_items",
      "bulk_add_task_dependencies",
      "bulk_set_task_dependencies",
      "bulk_set_block_dependencies",
      "bulk_apply_review_pipeline",
      "bulk_update_parallel_policy",
      "apply_canvas_lane_layout"
    ]
  },
  {
    name: "legacy_aliases",
    purpose:
      "Compat-only tools kept for existing clients. They are hidden from default discovery; set PLANWEAVE_MCP_TOOL_DISCOVERY=compat to expose them through tools/list.",
    recommendedTools: [
      "list_projects",
      "get_project_graph",
      "get_block_detail",
      "add_dependency",
      "remove_dependency",
      "refresh_prompts",
      "export_plan_package"
    ]
  }
] as const;

export const defaultToolGroups = toolGroups.filter((group) => group.name !== "legacy_aliases");
export const compatOnlyToolGroups = toolGroups.filter((group) => group.name === "legacy_aliases");
