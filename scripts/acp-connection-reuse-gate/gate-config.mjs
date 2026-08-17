export const thresholds = Object.freeze({
  workloadConcurrency: 4,
  minimumRounds: 3,
  processReductionPercent: 50,
  startupInitializeOrPeakRssReductionPercent: 20,
  maximumOtherMetricRegressionPercent: 15,
  mockStressIterations: 100,
  realMinimumSessionsPerConnection: 2
});

export const profiles = Object.freeze({
  "codex-acp": { command: "codex-acp", args: [] },
  "claude-code-acp": { command: "claude-agent-acp", args: [] },
  "opencode-acp": { command: "opencode", args: ["acp"] },
  "pi-acp": { command: "pi-acp", args: [] },
  "grok-acp": { command: "grok", args: ["--no-auto-update", "agent", "stdio"] }
});

export function parseArguments(argv) {
  const options = { mode: "all", profiles: [], rounds: 3, stress: 100, output: false };
  const valueAfter = (index, flag) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mock-only") options.mode = "mock";
    else if (argument === "--real-only") options.mode = "real";
    else if (argument === "--profile") options.profiles.push(valueAfter(index++, argument));
    else if (argument === "--rounds") {
      options.rounds = Number.parseInt(valueAfter(index++, argument), 10);
    } else if (argument === "--stress") {
      options.stress = Number.parseInt(valueAfter(index++, argument), 10);
    } else if (argument === "--output") options.output = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(options.rounds) || options.rounds < thresholds.minimumRounds) {
    throw new Error(`--rounds must be at least ${thresholds.minimumRounds}.`);
  }
  if (!Number.isSafeInteger(options.stress) || options.stress < thresholds.mockStressIterations) {
    throw new Error(`--stress must be at least ${thresholds.mockStressIterations}.`);
  }
  for (const profile of options.profiles) {
    if (!(profile in profiles)) throw new Error(`Unknown ACP profile: ${profile}`);
  }
  return options;
}
