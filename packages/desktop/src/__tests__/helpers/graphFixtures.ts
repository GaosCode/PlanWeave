import type {
  DesktopGraphViewModel,
  DesktopReviewPipeline
} from "@planweave-ai/runtime";

export const graph: DesktopGraphViewModel = {
  projectId: "P-001",
  projectTitle: "Demo project",
  graphVersion: "pgv-test",
  packageFingerprint: "pkg-test",
  executorOptions: ["codex"],
  tasks: [
    {
      taskId: "T-ALPHA",
      title: "Alpha task",
      status: "ready",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Alpha",
      promptPreview: "Alpha",
      blocks: [],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    },
    {
      taskId: "T-BETA",
      title: "Beta task",
      status: "ready",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Beta",
      promptPreview: "Beta",
      blocks: [],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    }
  ],
  edges: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

export const reviewPipeline: DesktopReviewPipeline = {
  taskId: "T-ALPHA",
  taskTitle: "Alpha task",
  packageDefaults: {
    maxFeedbackCycles: 1,
    completionPolicy: "strict"
  },
  steps: [
    {
      blockRef: "B-001",
      blockId: "B-001",
      title: "Review implementation",
      enabled: true,
      preset: "review",
      triggerCondition: "after_required_work_completed",
      inputContext: "Implementation",
      passCriteria: "Looks correct",
      feedbackFormat: "Notes",
      maxFeedbackCycles: 1,
      hook: null,
      promptMarkdown: "# Review"
    }
  ]
};
