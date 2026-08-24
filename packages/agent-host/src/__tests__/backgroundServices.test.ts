import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostBackgroundSetupError } from "../background/backgroundService.js";
import { LinuxUserSystemdService, linuxAgentHostUnitText } from "../background/linuxUserSystemd.js";
import {
  MacosLaunchAgentService,
  macosAgentHostLaunchAgentLabel,
  macosAgentHostLaunchAgentPlist
} from "../background/macosLaunchAgent.js";
import {
  createPlatformBackgroundService,
  supportsPlatformBackgroundService
} from "../background/platformBackground.js";
import {
  WindowsUserStartupService,
  windowsAgentHostStartupCommand
} from "../background/windowsUserStartup.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const install = {
  workspaceId: "workspace-1",
  executablePath: "/opt/Node Runtime/bin/node",
  fixedArgs: ["/opt/PlanWeave package/dist/bin.js"],
  configPath: "/home/user/.planweave/agent-host/instances/workspace-1/config.json",
  privateDirectory: "/home/user/.planweave/agent-host"
};
const identity = {
  workspaceId: install.workspaceId,
  privateDirectory: install.privateDirectory
};

describe("Agent Host background adapters", () => {
  it("selects background adapters by capability instead of Desktop platform policy", () => {
    expect(createPlatformBackgroundService("darwin")).toBeInstanceOf(MacosLaunchAgentService);
    expect(supportsPlatformBackgroundService("darwin")).toBe(true);
    expect(supportsPlatformBackgroundService("win32")).toBe(true);
    expect(supportsPlatformBackgroundService("linux")).toBe(true);
    expect(supportsPlatformBackgroundService("aix")).toBe(false);
  });

  it("writes and starts a credential-free macOS LaunchAgent with fixed argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-launch-agent-"));
    directories.push(root);
    const runner = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("service not found"), { code: 113 }))
      .mockResolvedValue({ stdout: "", stderr: "" });
    const service = new MacosLaunchAgentService(runner, root, () => 501);

    await expect(service.install(install)).resolves.toEqual({
      state: "running",
      platform: "macos-launch-agent"
    });

    const label = macosAgentHostLaunchAgentLabel(install.workspaceId);
    const path = join(root, `${label}.plist`);
    const plist = await readFile(path, "utf8");
    expect(plist).toBe(macosAgentHostLaunchAgentPlist(install));
    expect(plist).toContain("<string>/opt/Node Runtime/bin/node</string>");
    expect(plist).toContain("<string>/opt/PlanWeave package/dist/bin.js</string>");
    expect(plist).not.toMatch(/pw_(?:enroll|host)_/);
    expect(runner.mock.calls).toEqual([
      ["launchctl", ["print", `gui/501/${label}`]],
      ["launchctl", ["bootstrap", "gui/501", path]],
      ["launchctl", ["kickstart", "-k", `gui/501/${label}`]]
    ]);
  });

  it("retries bootstrap while launchd retires an existing macOS LaunchAgent", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-launch-agent-replace-"));
    directories.push(root);
    const transientBootstrapError = Object.assign(new Error("bootstrap still in progress"), {
      code: 5
    });
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "state = running\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(transientBootstrapError)
      .mockRejectedValueOnce(transientBootstrapError)
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const waitForReplacement = vi.fn().mockResolvedValue(undefined);
    const service = new MacosLaunchAgentService(runner, root, () => 501, waitForReplacement);

    await expect(service.install(install)).resolves.toEqual({
      state: "running",
      platform: "macos-launch-agent"
    });

    const label = macosAgentHostLaunchAgentLabel(install.workspaceId);
    const path = join(root, `${label}.plist`);
    expect(runner.mock.calls).toEqual([
      ["launchctl", ["print", `gui/501/${label}`]],
      ["launchctl", ["bootout", `gui/501/${label}`]],
      ["launchctl", ["bootstrap", "gui/501", path]],
      ["launchctl", ["bootstrap", "gui/501", path]],
      ["launchctl", ["bootstrap", "gui/501", path]],
      ["launchctl", ["kickstart", "-k", `gui/501/${label}`]]
    ]);
    expect(waitForReplacement).toHaveBeenCalledTimes(2);
  });

  it("escapes macOS plist argv and exposes file-backed diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-launch-agent-logs-"));
    directories.push(root);
    const service = new MacosLaunchAgentService(
      vi.fn().mockResolvedValue({ stdout: "state = running\n", stderr: "" }),
      root,
      () => 502
    );
    const specialInstall = {
      ...install,
      executablePath: "/Applications/PlanWeave & Tools/PlanWeave",
      fixedArgs: ["--label=<Agent Host>"]
    };
    const plist = macosAgentHostLaunchAgentPlist(specialInstall);
    expect(plist).toContain("PlanWeave &amp; Tools");
    expect(plist).toContain("--label=&lt;Agent Host&gt;");
    await service.install(specialInstall);

    await expect(service.logs(identity)).resolves.toEqual({
      platform: "macos-launch-agent",
      source: "launch-agent-files",
      stdoutPath: join(install.privateDirectory, "agent-host.stdout.log"),
      stderrPath: join(install.privateDirectory, "agent-host.stderr.log")
    });
  });

  it("reports and manages the macOS LaunchAgent lifecycle idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-launch-agent-lifecycle-"));
    directories.push(root);
    const installRunner = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("service not found"), { code: 113 }))
      .mockResolvedValue({ stdout: "", stderr: "" });
    await new MacosLaunchAgentService(installRunner, root, () => 503).install(install);

    const missingService = () => Object.assign(new Error("service not found"), { code: 113 });
    const lifecycleRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "state = running\n", stderr: "" })
      .mockRejectedValueOnce(missingService())
      .mockRejectedValueOnce(missingService())
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(Object.assign(new Error("service not found"), { code: 3 }));
    const service = new MacosLaunchAgentService(lifecycleRunner, root, () => 503);

    await expect(service.status(identity)).resolves.toMatchObject({ state: "running" });
    await expect(service.status(identity)).resolves.toMatchObject({ state: "stopped" });
    await expect(service.restart(identity)).resolves.toMatchObject({ state: "running" });
    await expect(service.uninstall(identity)).resolves.toMatchObject({
      state: "not_installed"
    });
    await expect(service.uninstall(identity)).resolves.toMatchObject({
      state: "not_installed"
    });

    const label = macosAgentHostLaunchAgentLabel(install.workspaceId);
    const path = join(root, `${label}.plist`);
    expect(lifecycleRunner.mock.calls).toEqual([
      ["launchctl", ["print", `gui/503/${label}`]],
      ["launchctl", ["print", `gui/503/${label}`]],
      ["launchctl", ["print", `gui/503/${label}`]],
      ["launchctl", ["bootstrap", "gui/503", path]],
      ["launchctl", ["kickstart", "-k", `gui/503/${label}`]],
      ["launchctl", ["bootout", `gui/503/${label}`]],
      ["launchctl", ["bootout", `gui/503/${label}`]]
    ]);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      new MacosLaunchAgentService(
        vi.fn().mockRejectedValue(missingService()),
        root,
        () => 503
      ).status(identity)
    ).resolves.toMatchObject({ state: "not_installed" });
  });

  it("returns stable actionable setup errors from launchctl", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-failed-launch-agent-"));
    directories.push(root);
    const runner = vi.fn().mockRejectedValue(new Error("private runner detail"));
    await expect(
      new MacosLaunchAgentService(runner, root, () => 504).install(install)
    ).rejects.toMatchObject({
      message: "agent_host_background_setup_required",
      guidance: "check_launch_agent_permissions"
    } satisfies Partial<AgentHostBackgroundSetupError>);
  });

  it("writes a user systemd unit with a Node npm launcher and fixed argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-systemd-"));
    directories.push(root);
    const runner = vi.fn().mockResolvedValue({ stdout: "active\n", stderr: "" });
    await new LinuxUserSystemdService(runner, root).install(install);
    const unit = await readFile(join(root, "planweave-agent-host-workspace-1.service"), "utf8");
    expect(unit).toContain(
      'ExecStart="/opt/Node Runtime/bin/node" "/opt/PlanWeave package/dist/bin.js" "run" "--config" "/home/user/.planweave/agent-host/instances/workspace-1/config.json"'
    );
    expect(unit).toContain("Restart=always");
    expect(unit).not.toContain("Restart=on-failure");
    expect(unit).not.toMatch(/pw_(?:enroll|host)_/);
    expect(runner).toHaveBeenNthCalledWith(1, "systemctl", ["--user", "daemon-reload"]);
    expect(runner).toHaveBeenNthCalledWith(2, "systemctl", [
      "--user",
      "enable",
      "--now",
      "planweave-agent-host-workspace-1.service"
    ]);
  });

  it.each([
    ["executable newline", { executablePath: "/opt/PlanWeave/host\nEnvironment=BAD=1" }],
    ["fixed arg newline", { fixedArgs: ["/opt/host.js\nEnvironment=BAD=1"] }],
    ["config carriage return", { configPath: "/tmp/config.json\rExecStart=/bin/false" }],
    ["executable NUL", { executablePath: "/opt/PlanWeave/host\0suffix" }]
  ])("rejects %s at the systemd unit construction boundary", (_label, override) => {
    expect(() => linuxAgentHostUnitText({ ...install, ...override })).toThrow(
      "agent_host_background_unit_value_invalid"
    );
  });

  it("preserves literal systemd dollars and accepts legacy launchers without fixed args", () => {
    const legacyInstall = {
      workspaceId: install.workspaceId,
      executablePath: "/opt/$release/planweave-agent-host",
      configPath: "/home/$USER/agent-host.json",
      privateDirectory: install.privateDirectory
    };
    expect(linuxAgentHostUnitText(legacyInstall)).toContain(
      'ExecStart="/opt/$$release/planweave-agent-host" "run" "--config" "/home/$$USER/agent-host.json"'
    );
    expect(
      windowsAgentHostStartupCommand({
        executablePath: legacyInstall.executablePath,
        args: [
          "run",
          "--config",
          legacyInstall.configPath,
          "--background-instance",
          "0123456789abcdef"
        ],
        marker: "0123456789abcdef"
      })
    ).toContain(
      '"/opt/$release/planweave-agent-host" "run" "--config" "/home/$USER/agent-host.json"'
    );
  });

  it("registers current-user startup and immediately launches fixed argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-windows-startup-"));
    directories.push(root);
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const starter = vi.fn().mockResolvedValue(undefined);
    await new WindowsUserStartupService(runner, starter, {
      LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
      USERPROFILE: "C:\\Users\\user"
    }).install({
      ...install,
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      fixedArgs: [
        "C:\\Users\\user\\App Data\\npm\\node_modules\\@planweave-ai\\agent-host\\dist\\bin.js"
      ],
      configPath: "C:\\Users\\user\\.planweave\\agent-host\\config.json",
      privateDirectory: root
    });
    expect(runner).toHaveBeenCalledWith("reg.exe", [
      "ADD",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/V",
      expect.stringMatching(/^PlanWeaveAgentHost-[a-f0-9]{16}$/u),
      "/T",
      "REG_EXPAND_SZ",
      "/D",
      expect.stringContaining(
        '"C:\\Program Files\\nodejs\\node.exe" "%USERPROFILE%\\App Data\\npm\\node_modules\\@planweave-ai\\agent-host\\dist\\bin.js" "run" "--config" "%USERPROFILE%\\.planweave\\agent-host\\config.json"'
      ),
      "/F"
    ]);
    expect(starter).toHaveBeenCalledWith("C:\\Program Files\\nodejs\\node.exe", [
      "C:\\Users\\user\\App Data\\npm\\node_modules\\@planweave-ai\\agent-host\\dist\\bin.js",
      "run",
      "--config",
      "C:\\Users\\user\\.planweave\\agent-host\\config.json",
      "--background-instance",
      expect.stringMatching(/^[a-f0-9]{16}$/u)
    ]);
    expect(runner).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("Stop-Process")],
      {
        environment: {
          PLANWEAVE_AGENT_HOST_INSTANCE: expect.stringMatching(/^[a-f0-9]{16}$/u)
        }
      }
    );
    expect(JSON.stringify(runner.mock.calls)).not.toMatch(/pw_(?:enroll|host)_/);
  });

  it("quotes Windows argv containing quotes and trailing backslashes", () => {
    const command = windowsAgentHostStartupCommand({
      executablePath: "C:\\Program Files\\host.exe",
      args: ['C:\\Program Files\\host "stable"\\'],
      marker: "0123456789abcdef"
    });
    expect(command).toContain('"C:\\Program Files\\host \\"stable\\"\\\\"');
  });

  it("keeps the default packaged startup command within the Windows Run-key limit", () => {
    const command = windowsAgentHostStartupCommand(
      {
        executablePath: "C:\\Users\\TESTUSER\\AppData\\Local\\Programs\\PlanWeave\\PlanWeave.exe",
        args: [
          "--agent-host-service",
          "run",
          "--config",
          "C:\\Users\\TESTUSER\\.planweave\\agent-host\\instances\\workspace-local-d5e342216f40e0632c512d0d61b94e71\\config.json",
          "--background-instance",
          "0123456789abcdef"
        ],
        marker: "0123456789abcdef"
      },
      {
        LOCALAPPDATA: "C:\\Users\\TESTUSER\\AppData\\Local",
        USERPROFILE: "C:\\Users\\TESTUSER"
      }
    );

    expect(command).toContain('"%LOCALAPPDATA%\\Programs\\PlanWeave\\PlanWeave.exe"');
    expect(command).toContain('"%USERPROFILE%\\.planweave\\agent-host\\instances');
    expect(command.length).toBeLessThanOrEqual(260);
  });

  it("returns stable actionable setup errors from systemd", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-failed-bg-"));
    directories.push(root);
    const runner = vi.fn().mockRejectedValue(new Error("private runner detail"));
    await expect(new LinuxUserSystemdService(runner, root).install(install)).rejects.toMatchObject({
      message: "agent_host_background_setup_required",
      guidance: "enable_user_linger"
    } satisfies Partial<AgentHostBackgroundSetupError>);
  });

  it("returns stable actionable setup errors from Windows user startup", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("private runner detail"));
    await expect(
      new WindowsUserStartupService(runner, vi.fn()).install(install)
    ).rejects.toMatchObject({
      message: "agent_host_background_setup_required",
      guidance: "run_agent_host_manually"
    } satisfies Partial<AgentHostBackgroundSetupError>);
  });

  it("uses fixed systemctl argv for lifecycle operations and describes journal logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-systemd-lifecycle-"));
    directories.push(root);
    const unitPath = join(root, "planweave-agent-host-workspace-1.service");
    await new LinuxUserSystemdService(
      vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
      root
    ).install(install);
    const runner = vi.fn().mockResolvedValue({ stdout: "active\n", stderr: "" });
    const service = new LinuxUserSystemdService(runner, root);

    await expect(service.status(identity)).resolves.toMatchObject({ state: "running" });
    await expect(service.restart(identity)).resolves.toMatchObject({ state: "running" });
    await expect(service.logs(identity)).resolves.toEqual({
      platform: "linux-systemd-user",
      source: "systemd-journal",
      command: {
        executable: "journalctl",
        args: ["--user", "-u", "planweave-agent-host-workspace-1.service"]
      }
    });
    await expect(service.uninstall(identity)).resolves.toMatchObject({
      state: "not_installed"
    });

    expect(runner.mock.calls).toEqual([
      ["systemctl", ["--user", "is-active", "planweave-agent-host-workspace-1.service"]],
      ["systemctl", ["--user", "is-active", "planweave-agent-host-workspace-1.service"]],
      ["systemctl", ["--user", "restart", "planweave-agent-host-workspace-1.service"]],
      ["systemctl", ["--user", "disable", "--now", "planweave-agent-host-workspace-1.service"]],
      ["systemctl", ["--user", "daemon-reload"]]
    ]);
    await expect(readFile(unitPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses registry presence and a process marker for Windows background status", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "registry value", stderr: "" })
      .mockResolvedValueOnce({ stdout: "0", stderr: "" });

    await expect(new WindowsUserStartupService(runner).status(identity)).resolves.toEqual({
      state: "stopped",
      platform: "windows-user-startup"
    });
  });
});
