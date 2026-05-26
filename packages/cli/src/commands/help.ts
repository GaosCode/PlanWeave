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
    commands: ["paths --json", "init --json", "validate --json"],
    notes: ["Use the CLI-returned package directory as the writable Plan Package location.", "Run validate after editing manifest or prompt sources."]
  },
  {
    name: "schema",
    summary: "Navigate PlanWeave manifest, state, and desktop layout schemas.",
    commands: ["schema", "schema manifest", "schema state", "schema layout", "schema all"],
    notes: [
      "help schema is a short navigation topic; use planweave schema <topic> for the full schema.",
      "Do not hand-author manifest, state, or layout from memory.",
      "Manifest and prompt sources are editable; state and layout are runtime/desktop owned."
    ]
  },
  {
    name: "plan",
    summary: "Inspect and refresh plan prompt surfaces without changing source prompts.",
    commands: ["refresh-prompt <block-ref>", "refresh-prompts", "prompt <block-ref>"],
    notes: ["Rendered prompts are derived output.", "Edit global/project/task/block source prompts, not rendered prompt output."]
  },
  {
    name: "work",
    summary: "Claim executable work for an agent loop.",
    commands: [
      "current",
      "status --json",
      "claim-next --dry-run",
      "claim-next --parallel --dry-run",
      "claim <ref>",
      "claim-task <taskId>",
      "claim --type review"
    ],
    notes: ["Use dry-run before automatic scheduling when the next step is unclear.", "Review gates are sequential work, not parallel implementation blocks."]
  },
  {
    name: "submit",
    summary: "Submit block, review, and feedback results.",
    commands: [
      "submit-result <block-ref> --report <report.md>",
      "submit-review <review-block-ref> --result <review-result.json>",
      "submit-feedback --report <feedback-report.md>"
    ],
    notes: ["submit-result is for implementation blocks.", "submit-review verdicts are passed or needs_changes.", "Feedback is runtime state; do not create feedback blocks in the package."]
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
      "resolve-divergence <ref> --reason <reason>"
    ],
    notes: [
      "Doctor checks state/results consistency; it is not a general Plan Package repair tool.",
      "Use doctor --repair only for narrow, evidence-backed runtime drift.",
      "Fix bad dependencies, unsafe parallelization, missing prompts, or review-gate design by manually updating the Plan Package."
    ]
  },
  {
    name: "autorun",
    summary: "Inspect executors and run automated execution steps.",
    commands: ["executors list", "executors test <name>", "run --once --executor <name> --json", "run-status --json"],
    notes: ["Use --once for controlled agent loops.", "The manual executor claims work and writes prompt paths without auto-submitting results."]
  }
];

function formatTopic(topic: HelpTopic): string {
  return [`${topic.name}: ${topic.summary}`, "", "Commands:", ...topic.commands.map((command) => `- planweave ${command}`), "", "Notes:", ...topic.notes.map((note) => `- ${note}`)].join("\n");
}

export function formatPlanweaveHelp(topicName?: string): string {
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
      console.log(formatPlanweaveHelp(topicName));
    });
}
