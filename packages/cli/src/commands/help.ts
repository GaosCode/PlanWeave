import type { Command } from "commander";

type HelpTopic = {
  name: string;
  summary: string;
  commands: string[];
  notes: string[];
};

export const planweaveHelpTopics: HelpTopic[] = [
  {
    name: "setup",
    summary: "Initialize or locate the PlanWeave workspace.",
    commands: ["paths --json", "init --project-graph --json", "project-graph migrate --json", "validate --json"],
    notes: [
      "Use the CLI-returned packageDir, statePath, and resultsDir as the writable canvas package, state, and results locations.",
      "Use project-graph migrate to materialize a formal multi-canvas graph from legacy/default canvas sources.",
      "Run validate after editing manifest or prompt sources."
    ]
  },
  {
    name: "schema",
    summary: "Navigate PlanWeave project graph, manifest, state, and desktop layout schemas.",
    commands: ["schema", "schema project", "schema manifest", "schema state", "schema layout", "schema all"],
    notes: [
      "help schema is a short navigation topic; use planweave schema <topic> for the full schema.",
      "Use schema project before writing formal multi-canvas project-graph.json.",
      "Do not hand-author project graph, manifest, state, or layout from memory.",
      "Project graph, manifest, and prompt sources are editable; state and layout are runtime/desktop owned."
    ]
  },
  {
    name: "plan",
    summary: "Inspect and edit plan source surfaces.",
    commands: [
      "refresh-prompt <block-ref>",
      "refresh-prompts",
      "prompt <block-ref>",
      "edit-task <task-id> --title <title>",
      "edit-block <block-ref> --review-required false",
      "edit-block <block-ref> --parallel-safe true --parallel-locks api,db"
    ],
    notes: [
      "Rendered prompts are derived output.",
      "Use edit-task/edit-block for narrow source edits by exact id/ref instead of hand-editing large manifest sections."
    ]
  },
  {
    name: "work",
    summary: "Claim executable work for an agent loop.",
    commands: [
      "current",
      "status --json",
      "status --json --canvas <canvasId>",
      "claim-next --dry-run",
      "claim-next --dry-run --canvas <canvasId>",
      "claim-next --parallel --dry-run",
      "claim <ref>",
      "claim --canvas <canvasId> <ref>",
      "claim <ref> --dispatch",
      "claim-task <taskId>",
      "claim --type review"
    ],
    notes: [
      "Use dry-run before automatic scheduling when the next step is unclear.",
      "Use --canvas for formal multi-canvas projects; without it, CLI commands target the current or first canvas, not every project canvas.",
      "Review gates are sequential work, not parallel implementation blocks.",
      "Use --dispatch only for graph-ready, parallel-safe implementation blocks assigned to another agent."
    ]
  },
  {
    name: "submit",
    summary: "Submit block, review, and feedback results.",
    commands: [
      "submit-result <block-ref> --report <report.md>",
      "submit-result --canvas <canvasId> <block-ref> --report <report.md>",
      "submit-review <review-block-ref> --result <review-result.json>",
      "submit-review --canvas <canvasId> <review-block-ref> --result <review-result.json>",
      "submit-feedback --report <feedback-report.md>"
    ],
    notes: [
      "Use --canvas when submitting work claimed from a non-default canvas.",
      "submit-result is for implementation blocks.",
      "submit-review verdicts are passed or needs_changes.",
      "Feedback is runtime state; do not create feedback blocks in the package."
    ]
  },
  {
    name: "explain",
    summary: "Explain scheduling and claimability.",
    commands: ["explain <ref>", "why-not <ref>", "status --json"],
    notes: ["Use explain/why-not before editing state by hand.", "Compare nextClaimable, nextParallelClaimable, and nextSequentialClaimable in status output."]
  },
  {
    name: "recovery",
    summary: "Diagnose recovery issues and repair narrow runtime state/results drift.",
    commands: [
      "doctor",
      "doctor --repair",
      "mark-blocked <ref> --reason <reason>",
      "unblock <ref> --reason <reason>",
      "mark-diverged <ref> --reason <reason>",
      "resolve-divergence <ref> --reason <reason>",
      "retry-review <review-block-ref> --max-feedback-cycles 3"
    ],
    notes: [
      "Doctor checks state/results consistency; it is not a general Plan Package repair tool.",
      "Use doctor --repair only for narrow, evidence-backed runtime drift.",
      "retry-review edits one exact review block and resets max-cycle completion state for another attempt.",
      "Fix bad dependencies, unsafe parallelization, missing prompts, or review-gate design through exact Plan Package edits."
    ]
  },
  {
    name: "autorun",
    summary: "Inspect executors and run automated execution steps.",
    commands: [
      "executors list",
      "executors test <name>",
      "run --once --executor <name> --json",
      "run --reset --force --reason <reason> --json",
      "reset --force --reason <reason> --json",
      "run-sessions --json",
      "run-session <session-id> --json",
      "run-status --json"
    ],
    notes: [
      "Use --canvas for canvas-scoped Auto Run; without it, Auto Run targets the current or first canvas.",
      "Use run --reset to clear runtime state before a run session; use reset when you only want to clear runtime state.",
      "init --reset-package resets package source files during workspace initialization; it is separate from runtime reset.",
      "Use --once for controlled agent loops.",
      "The manual executor claims work and writes prompt paths without auto-submitting results."
    ]
  }
];

function formatTopic(topic: HelpTopic): string {
  return [`${topic.name}: ${topic.summary}`, "", "Commands:", ...topic.commands.map((command) => `- planweave ${command}`), "", "Notes:", ...topic.notes.map((note) => `- ${note}`)].join("\n");
}

export function formatCliHelp(topicName?: string): string {
  const topic = topicName ? planweaveHelpTopics.find((item) => item.name === topicName) : null;
  if (topic) {
    return formatTopic(topic);
  }
  const lines = ["PlanWeave CLI help", "", "Use `planweave help <topic>` for focused command groups.", "", "Topics:"];
  for (const item of planweaveHelpTopics) {
    lines.push(`- ${item.name}: ${item.summary}`);
  }
  lines.push("", "Common agent loop:", "- planweave current", "- planweave claim-next --dry-run", "- planweave prompt <block-ref>", "- planweave submit-result <block-ref> --report <report.md>");
  if (topicName) {
    lines.push("", `Unknown topic: ${topicName}`);
  }
  return lines.join("\n");
}

export function registerHelpCommand(program: Command): void {
  program
    .command("help [topic]")
    .description("Show PlanWeave-specific CLI help")
    .option("--json", "print machine-readable output")
    .action((topicName: string | undefined, options: { json?: boolean }) => {
      if (options.json) {
        console.log(JSON.stringify({ topics: planweaveHelpTopics, selected: topicName ?? null }, null, 2));
        return;
      }
      const command = topicName ? program.commands.find((item) => item.name() === topicName) : null;
      if (command && !planweaveHelpTopics.some((topic) => topic.name === topicName)) {
        console.log(command.helpInformation());
        return;
      }
      console.log(formatCliHelp(topicName));
    });
}
