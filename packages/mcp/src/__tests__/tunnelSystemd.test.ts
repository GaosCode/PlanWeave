import { describe, expect, it } from "vitest";
import {
  renderSystemdEnvFile,
  renderSystemdService,
  renderSystemdTemplates
} from "../tunnel/systemd.js";

describe("MCP tunnel systemd renderer", () => {
  it("renders a deterministic service template", () => {
    const service = renderSystemdService({
      serviceName: "planweave-mcp-tunnel",
      workingDirectory: "/srv/planweave",
      planweaveHome: "/srv/planweave",
      envFile: "/etc/planweave/mcp-tunnel.env",
      planweaveBin: "/usr/local/bin/planweave",
      user: "planweave"
    });

    expect(service).toContain("User=planweave");
    expect(service).toContain('EnvironmentFile="/etc/planweave/mcp-tunnel.env"');
    expect(service).toContain('ExecStart="/usr/local/bin/planweave" mcp tunnel run --serve');
    expect(service).toContain("Restart=always");
  });

  it("renders an env file template without a real Runtime API key", () => {
    const envFile = renderSystemdEnvFile({ planweaveHome: "/srv/planweave" });

    expect(envFile).toContain("PLANWEAVE_HOME=/srv/planweave");
    expect(envFile).toContain("OPENAI_RUNTIME_API_KEY=replace-with-openai-runtime-api-key");
    expect(envFile).not.toContain("sk-");
  });

  it("combines service and env templates", () => {
    const output = renderSystemdTemplates({
      serviceName: "planweave-mcp-tunnel",
      workingDirectory: "/srv/planweave",
      planweaveHome: "/srv/planweave",
      envFile: "/etc/planweave/mcp-tunnel.env",
      planweaveBin: "/usr/local/bin/planweave"
    });

    expect(output).toContain("# planweave-mcp-tunnel.service");
    expect(output).toContain("# /etc/planweave/mcp-tunnel.env");
  });
});
