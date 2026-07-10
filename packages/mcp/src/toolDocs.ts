export const authoringRules = [
  "Use get_planweave_guide when you need PlanWeave concepts, storage layout, or tool-selection guidance.",
  "Use list_tool_groups first so default discovery follows the lightweight graph, diagnostics, content, and package-draft paths.",
  "Use list_projects_summary, open_project_summary, and list_canvases to choose targets without returning full task trees.",
  "Use create_project to create or open a managed project by name; init_project is a compatibility alias.",
  "Use projectId and optional canvasId from summary/list tools; MCP tools do not accept arbitrary server absolute paths.",
  "Create a new isolated task canvas with create_canvas before writing a plan that should not modify an existing demo canvas.",
  "Prefer package-shaped drafts for large plans: validate_package_draft, validate_graph_quality, preview_package_import, then import_package_draft with apply: true.",
  "After importing a large DAG, use apply_canvas_lane_layout to materialize the recommended canvas lane layout.",
  "Create and update graph structure through create_task, create_block, add_task_dependency, remove_task_dependency, set_task_dependencies, and related semantic write tools.",
  "Use update_task_acceptance, set_block_dependencies, update_block_planning, set_review_pipeline, and project graph dependency tools for plan metadata that is not prompt text.",
  "Use update_canvas_execution_policy for canvas-level execution.defaultExecutor and execution.parallel settings; use update_block_planning for per-block exclusive lock / locks.",
  "Keep the graph acyclic. Use get_graph_summary, get_graph_slice, and validate_graph_quality before and after large dependency changes.",
  "Write task and block prompt markdown through write_prompt_source, update_task, or update_block, then run refresh_prompts_summary, validate_project, and validate_graph_quality.",
  "Use implementation blocks for work and review blocks for review gates; review blocks should depend on the implementation blocks they inspect.",
  "Read large content only through list_package_files, read_package_file, read_prompt_source, get_rendered_prompt, export_plan_package_files, or explicit full-debug tools."
] as const;

export const planweaveGuide = {
  summary:
    "PlanWeave is a local plan-graph authoring and execution system. MCP tools are for discovering registered projects and authoring Plan Packages; they do not read the PlanWeave Desktop UI selection or execute implementation work.",
  concepts: [
    {
      name: "Project",
      description:
        "A registered PlanWeave workspace under the local PlanWeave home. Tools address projects by projectId, not by absolute local paths."
    },
    {
      name: "Task canvas",
      description:
        "A canvas is a Plan Package DAG inside a project. A project can have a default canvas and additional canvases."
    },
    {
      name: "Task",
      description:
        "A task is a user-facing plan node with a task prompt, acceptance criteria, and ordered blocks."
    },
    {
      name: "Block",
      description:
        "A block is the atomic implementation or review unit. Implementation blocks describe work; review blocks inspect work and can depend on implementation blocks."
    },
    {
      name: "Parallel execution policy",
      description:
        "Dependency edges answer when a block can start; locks answer which ready blocks can run at the same time. Parallel eligibility = canvas execution.parallel policy + non-conflicting locks. Reserved lock exclusive conflicts with everything. parallel.safe is deprecated."
    },
    {
      name: "Prompt surfaces",
      description:
        "Task and block prompts are source markdown in the Plan Package. Rendered prompts are derived surfaces and should be read with get_rendered_prompt instead of edited directly."
    },
    {
      name: "Package draft",
      description:
        "A draft root is a temporary package-shaped directory. Validate and preview it before transactionally importing it into an active project or canvas."
    }
  ],
  workspaceLayout: [
    "~/.planweave/projects/<projectId>/project.json stores project metadata.",
    "~/.planweave/projects/<projectId>/project-graph.json stores canvas nodes and project-level canvas/task dependencies.",
    "~/.planweave/projects/<projectId>/policy/project-prompt.md stores the project-level prompt policy.",
    "The default canvas uses canvases/default/package, canvases/default/state.json, and canvases/default/results.",
    "Additional canvases use canvases/<canvasId>/package, canvases/<canvasId>/state.json, and canvases/<canvasId>/results.",
    "Older single-canvas projects may still contain root package/, state.json, or results/ during migration; those paths are legacy default canvas data, not project-level package data."
  ],
  mcpWorkflow: [
    "Use get_planweave_guide when you need the product model or directory layout.",
    "Use list_tool_groups to discover the recommended lightweight path for the current job.",
    "Use list_projects_summary, open_project_summary, and list_canvases to select targets without returning full prompt or graph content.",
    "Use create_project when you need a new managed project or want to open one by name.",
    "Use create_canvas when the plan should live in a new isolated canvas.",
    "For large plans, write a package-shaped draft root outside the active project, then use validate_package_draft, validate_graph_quality, preview_package_import, import_package_draft with apply: true, and apply_canvas_lane_layout.",
    "Use create_task, create_block, update_task_acceptance, set_block_dependencies, update_canvas_execution_policy, update_block_planning, set_review_pipeline, add_task_dependency, set_task_dependencies, and project graph dependency tools for direct edits.",
    "For parallel plans, first set the selected canvas execution.parallel policy with update_canvas_execution_policy, then set non-conflicting locks (or exclusive) via update_block_planning exclusive/parallelLocks. Isolated blocks with no locks are parallel-eligible by default.",
    "Use write_prompt_source, update_task, and update_block to update promptMarkdown, titles, or executors.",
    "Run refresh_prompts_summary, validate_project, validate_graph_quality, and validate_execution_readiness after meaningful authoring changes."
  ],
  toolSelection: [
    { need: "Understand PlanWeave concepts and storage layout", tool: "get_planweave_guide" },
    { need: "Create or open a managed project", tool: "create_project" },
    { need: "Find local projects", tool: "list_projects_summary" },
    { need: "List canvases in a project", tool: "list_canvases" },
    { need: "Inspect one canvas DAG", tool: "get_graph_summary or get_graph_slice" },
    { need: "Read task/block/project prompt markdown", tool: "read_prompt_source" },
    { need: "Read a rendered execution prompt", tool: "get_rendered_prompt" },
    {
      need: "Create or update plan structure",
      tool: "create_task/create_block/semantic dependency tools"
    },
    { need: "Validate a package draft before import", tool: "validate_package_draft" },
    {
      need: "Preview and apply a package draft",
      tool: "preview_package_import then import_package_draft"
    },
    { need: "Lay out an imported DAG into dependency lanes", tool: "apply_canvas_lane_layout" },
    {
      need: "Enable or tune canvas-level parallel execution",
      tool: "update_canvas_execution_policy"
    },
    {
      need: "Set exclusive lock or resource locks on implementation blocks",
      tool: "update_block_planning"
    },
    {
      need: "Validate authored plans",
      tool: "validate_project, validate_graph_quality, validate_execution_readiness, or explain_validation_errors"
    }
  ],
  nonGoals: [
    "MCP tools do not infer the currently selected PlanWeave Desktop project.",
    "MCP tools do not execute code implementation work by themselves.",
    "MCP tools do not accept arbitrary server absolute paths for project-scoped operations."
  ]
} as const;

export const exampleTemplates = [
  {
    template: "basic",
    title: "Basic single-canvas package",
    description: "One implementation block and one review block with explicit review dependency.",
    fileCount: 4
  },
  {
    template: "large_dag_with_review_loop",
    title: "Large DAG with review loop",
    description:
      "Six task nodes with branching dependencies, review gates, and parallel-safe implementation blocks.",
    fileCount: 19
  }
] as const;

type PackageExampleFile = {
  path: string;
  encoding: "utf8";
  content: string;
};

const basicExampleFiles = [
  {
    path: "manifest.json",
    encoding: "utf8" as const,
    content: JSON.stringify(
      {
        version: "plan-package/v1",
        project: {
          title: "Example PlanWeave Project",
          description: "A minimal PlanWeave package example."
        },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        review: { maxFeedbackCycles: 2, completionPolicy: "strict" },
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Build the feature",
            prompt: "nodes/T-001/prompt.md",
            acceptance: ["Feature behavior is implemented and validated."],
            blocks: [
              {
                id: "B-001",
                type: "implementation",
                title: "Implement feature",
                prompt: "nodes/T-001/blocks/B-001.prompt.md",
                depends_on: [],
                parallel: { locks: [] }
              },
              {
                id: "R-001",
                type: "review",
                title: "Review feature",
                prompt: "nodes/T-001/blocks/R-001.prompt.md",
                depends_on: ["B-001"],
                review: { required: true, maxFeedbackCycles: 2, hook: null }
              }
            ]
          }
        ],
        edges: []
      },
      null,
      2
    )
  },
  {
    path: "nodes/T-001/prompt.md",
    encoding: "utf8" as const,
    content: "# Build the feature\n\nDescribe the user-visible outcome and acceptance criteria.\n"
  },
  {
    path: "nodes/T-001/blocks/B-001.prompt.md",
    encoding: "utf8" as const,
    content: "# Implement feature\n\nMake the smallest code change that satisfies the task.\n"
  },
  {
    path: "nodes/T-001/blocks/R-001.prompt.md",
    encoding: "utf8" as const,
    content: "# Review feature\n\nCheck correctness, regressions, and test coverage.\n"
  }
] as const satisfies readonly PackageExampleFile[];

const largeDagTasks = [
  [
    "T-001",
    "Define target architecture",
    "Document the desired architecture, boundaries, and acceptance criteria."
  ],
  [
    "T-002",
    "Implement runtime contracts",
    "Implement runtime behavior and tests for the shared contract."
  ],
  [
    "T-003",
    "Implement MCP contract",
    "Expose the runtime behavior through MCP tools and contract tests."
  ],
  [
    "T-004",
    "Implement CLI contract",
    "Expose the runtime behavior through CLI commands and contract tests."
  ],
  [
    "T-005",
    "Connect desktop diagnostics",
    "Render the shared diagnostics in the desktop bridge and UI."
  ],
  [
    "T-006",
    "Finalize docs and verification",
    "Update user-facing docs and run the verification suite."
  ]
] as const;

const largeDagEdges = [
  ["T-002", "T-001"],
  ["T-003", "T-001"],
  ["T-004", "T-002"],
  ["T-004", "T-003"],
  ["T-005", "T-003"],
  ["T-006", "T-004"],
  ["T-006", "T-005"]
] as const;

function largeDagManifest(): string {
  return JSON.stringify(
    {
      version: "plan-package/v1",
      project: {
        title: "Large PlanWeave DAG Example",
        description:
          "A package-shaped draft for large plans with review loops and parallel execution hints."
      },
      execution: {
        defaultExecutor: "codex-auto",
        parallel: { enabled: true, maxConcurrent: 3 }
      },
      review: { maxFeedbackCycles: 2, completionPolicy: "strict" },
      nodes: largeDagTasks.map(([id, title]) => ({
        id,
        type: "task",
        title,
        prompt: `nodes/${id}/prompt.md`,
        acceptance: [`${title} is complete, tested, and documented where relevant.`],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: `Implement ${title.toLowerCase()}`,
            prompt: `nodes/${id}/blocks/B-001.prompt.md`,
            depends_on: [],
            parallel: {
              locks: id === "T-001" ? ["exclusive"] : id === "T-005" ? ["desktop-ui"] : []
            }
          },
          {
            id: "R-001",
            type: "review",
            title: `Review ${title.toLowerCase()}`,
            prompt: `nodes/${id}/blocks/R-001.prompt.md`,
            depends_on: ["B-001"],
            review: { required: true, maxFeedbackCycles: 2, hook: null }
          }
        ]
      })),
      edges: largeDagEdges.map(([from, to]) => ({ from, to, type: "depends_on" }))
    },
    null,
    2
  );
}

const largeDagExampleFiles = [
  {
    path: "manifest.json",
    encoding: "utf8" as const,
    content: largeDagManifest()
  },
  ...largeDagTasks.flatMap(([id, title, detail]) => [
    {
      path: `nodes/${id}/prompt.md`,
      encoding: "utf8" as const,
      content: `# ${title}\n\n${detail}\n\nAcceptance should be verified before the review block passes.\n`
    },
    {
      path: `nodes/${id}/blocks/B-001.prompt.md`,
      encoding: "utf8" as const,
      content: `# Implement ${title.toLowerCase()}\n\nMake the focused implementation change for ${id}. Preserve existing contracts unless this task explicitly changes them.\n`
    },
    {
      path: `nodes/${id}/blocks/R-001.prompt.md`,
      encoding: "utf8" as const,
      content: `# Review ${title.toLowerCase()}\n\nCheck correctness, regression risk, tests, and whether the implementation satisfies the task acceptance criteria.\n`
    }
  ])
] as const satisfies readonly PackageExampleFile[];

export const exampleFiles = basicExampleFiles;

export function getPackageExampleFiles(
  template: string
): readonly PackageExampleFile[] | undefined {
  if (template === "basic") {
    return basicExampleFiles;
  }
  if (template === "large_dag_with_review_loop") {
    return largeDagExampleFiles;
  }
  return undefined;
}
