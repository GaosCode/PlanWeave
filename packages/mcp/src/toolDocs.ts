export const authoringRules = [
  "Use get_planweave_guide when you need PlanWeave concepts, storage layout, or tool-selection guidance.",
  "Use get_project_tree when you need the local PlanWeave project/canvas/task/block structure before writing a plan.",
  "Use projectId and optional canvasId from get_project_tree, list_projects, or open_project; MCP tools do not accept arbitrary server absolute paths.",
  "Create a new isolated task canvas with create_canvas before writing a plan that should not modify an existing demo canvas.",
  "Create and update graph structure through create_task, create_block, add_dependency, and related write tools.",
  "Use update_task_acceptance, update_block_dependencies, update_block_planning, update_review_pipeline, and project graph dependency tools for plan metadata that is not prompt text.",
  "Use update_canvas_execution_policy for canvas-level execution.defaultExecutor and execution.parallel settings; use update_block_planning for per-block parallel safety and locks.",
  "Keep the graph acyclic. Use get_project_graph before large dependency changes.",
  "Write task and block prompt markdown through update_task and update_block, then run refresh_prompts and validate_project.",
  "Use implementation blocks for work and review blocks for review gates; review blocks should depend on the implementation blocks they inspect.",
  "Import packages only from structured file lists, and validate before relying on the imported project."
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
        "A DAG branch only describes dependency shape. Actual parallel eligibility also requires the canvas manifest execution.parallel.enabled/maxConcurrent policy plus per-implementation-block parallel.safe and non-conflicting locks."
    },
    {
      name: "Prompt surfaces",
      description:
        "Task and block prompts are source markdown in the Plan Package. Rendered prompts are derived surfaces and should be read with get_prompt/read_prompt instead of edited directly."
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
    "Use get_project_tree to inspect the local project/canvas/task/block tree before authoring a plan into an existing project.",
    "Use list_projects for a lightweight project list when task/block details are unnecessary.",
    "Use create_canvas when the plan should live in a new isolated canvas.",
    "Use create_task, create_block, update_task_acceptance, update_block_dependencies, update_canvas_execution_policy, update_block_planning, update_review_pipeline, add_dependency, and project graph dependency tools to author structure.",
    "For parallel plans, first set the selected canvas execution.parallel policy with update_canvas_execution_policy, then mark only truly independent implementation blocks with update_block_planning parallelSafe/parallelLocks.",
    "Use update_task and update_block to update promptMarkdown, titles, or executors.",
    "Run refresh_prompts and validate_project after meaningful authoring changes."
  ],
  toolSelection: [
    { need: "Understand PlanWeave concepts and storage layout", tool: "get_planweave_guide" },
    { need: "Find local projects, canvases, tasks, and blocks", tool: "get_project_tree" },
    { need: "List registered projects only", tool: "list_projects" },
    { need: "Inspect one canvas DAG", tool: "get_project_graph" },
    { need: "Read task/block/project prompt markdown", tool: "read_prompt" },
    { need: "Read a rendered execution prompt", tool: "get_prompt" },
    { need: "Create or update plan structure", tool: "create_task/create_block/update_* tools" },
    { need: "Enable or tune canvas-level parallel execution", tool: "update_canvas_execution_policy" },
    { need: "Mark individual implementation blocks as parallel-safe or set locks", tool: "update_block_planning" },
    { need: "Validate authored plans", tool: "validate_project or explain_validation_errors" }
  ],
  nonGoals: [
    "MCP tools do not infer the currently selected PlanWeave Desktop project.",
    "MCP tools do not execute code implementation work by themselves.",
    "MCP tools do not accept arbitrary server absolute paths for project-scoped operations."
  ]
} as const;

export const exampleFiles = [
  {
    path: "manifest.json",
    encoding: "utf8" as const,
    content: JSON.stringify(
      {
        version: "plan-package/v1",
        project: { title: "Example PlanWeave Project", description: "A minimal PlanWeave package example." },
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
                parallel: { safe: false, locks: [] }
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
] as const;
