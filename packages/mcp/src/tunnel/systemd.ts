export type SystemdTemplateInput = {
  serviceName: string;
  workingDirectory: string;
  planweaveHome: string;
  envFile: string;
  planweaveBin: string;
  user?: string | null;
};

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error(`${field} must not contain newlines.`);
  }
  return trimmed;
}

function quoteSystemd(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderSystemdService(input: SystemdTemplateInput): string {
  const serviceName = requireNonEmpty(input.serviceName, "serviceName");
  const workingDirectory = requireNonEmpty(input.workingDirectory, "workingDirectory");
  const envFile = requireNonEmpty(input.envFile, "envFile");
  const planweaveBin = requireNonEmpty(input.planweaveBin, "planweaveBin");
  const user = input.user?.trim() || null;
  const lines = [
    "[Unit]",
    `Description=PlanWeave MCP Tunnel (${serviceName})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    ...(user ? [`User=${user}`] : []),
    `WorkingDirectory=${quoteSystemd(workingDirectory)}`,
    `EnvironmentFile=${quoteSystemd(envFile)}`,
    `ExecStart=${quoteSystemd(planweaveBin)} mcp tunnel run --serve`,
    "Restart=always",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=multi-user.target"
  ];
  return `${lines.join("\n")}\n`;
}

export function renderSystemdEnvFile(input: { planweaveHome: string }): string {
  const planweaveHome = requireNonEmpty(input.planweaveHome, "planweaveHome");
  return [
    "# Store this file with mode 0600.",
    `PLANWEAVE_HOME=${planweaveHome}`,
    "OPENAI_RUNTIME_API_KEY=replace-with-openai-runtime-api-key",
    ""
  ].join("\n");
}

export function renderSystemdTemplates(input: SystemdTemplateInput): string {
  return [
    `# ${input.serviceName}.service`,
    renderSystemdService(input).trimEnd(),
    "",
    `# ${input.envFile}`,
    renderSystemdEnvFile({ planweaveHome: input.planweaveHome }).trimEnd(),
    ""
  ].join("\n");
}
