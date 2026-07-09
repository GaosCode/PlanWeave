import { execFile, type ExecFileOptions } from "node:child_process";
import type {
  DesktopRunTerminalUnavailableReason,
  DesktopTerminalAppId
} from "@planweave-ai/runtime";
import { terminalAppById } from "./terminalApps.js";
import type { TmuxAttachIntent } from "./tmuxRunRecordResolver.js";

export type TerminalOpenIntent = {
  cwd: string;
};

type TerminalLauncher = {
  appId: DesktopTerminalAppId;
  launch(intent: TmuxAttachIntent): Promise<void>;
  open(intent: TerminalOpenIntent): Promise<void>;
};

function execFileVoid(
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, maxBuffer: 64 * 1024 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function errorCode(caught: unknown): string | null {
  if (!caught || typeof caught !== "object" || !("code" in caught)) {
    return null;
  }
  const code = (caught as Record<"code", unknown>).code;
  return typeof code === "string" ? code : null;
}

function tmuxCommandArgs(intent: TmuxAttachIntent): string[] {
  return intent.mode === "readOnly"
    ? ["tmux", "attach-session", "-r", "-t", intent.sessionName]
    : ["tmux", "attach-session", "-t", intent.sessionName];
}

function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function tmuxShellCommand(intent: TmuxAttachIntent): string {
  return tmuxCommandArgs(intent).map(shellQuoteArg).join(" ");
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function iTermScript(command: string): string[] {
  const terminalApp = terminalAppById("iterm2");
  return [
    "-e",
    `set planweaveItermWasRunning to application "${appleScriptString(terminalApp.macOpenName)}" is running`,
    "-e",
    `tell application "${appleScriptString(terminalApp.macOpenName)}"`,
    "-e",
    "activate",
    "-e",
    "if planweaveItermWasRunning then",
    "-e",
    "set planweaveWindow to (create window with default profile)",
    "-e",
    "else",
    "-e",
    "delay 0.2",
    "-e",
    "if (count of windows) is 0 then",
    "-e",
    "set planweaveWindow to (create window with default profile)",
    "-e",
    "else",
    "-e",
    "set planweaveWindow to current window",
    "-e",
    "end if",
    "-e",
    "end if",
    "-e",
    "select planweaveWindow",
    "-e",
    `tell current session of planweaveWindow to write text "${command}"`,
    "-e",
    "activate",
    "-e",
    "end tell"
  ];
}

export async function checkTmuxSessionAvailability(
  sessionName: string
): Promise<DesktopRunTerminalUnavailableReason | null> {
  try {
    await execFileVoid("tmux", ["has-session", "-t", sessionName], {
      timeout: 2_000,
      env: process.env
    });
    return null;
  } catch (caught) {
    if (errorCode(caught) === "ENOENT") {
      return "tmux_unavailable";
    }
    return "tmux_session_not_running";
  }
}

async function ensureTmuxSessionExists(sessionName: string): Promise<void> {
  const unavailableReason = await checkTmuxSessionAvailability(sessionName);
  if (unavailableReason === "tmux_unavailable") {
    throw new Error("tmux is not available.");
  }
  if (unavailableReason === "tmux_session_not_running") {
    throw new Error("tmux session does not exist.");
  }
}

const terminalLauncher: TerminalLauncher = {
  appId: "terminal",
  async launch(intent) {
    const command = appleScriptString(tmuxShellCommand(intent));
    await execFileVoid("/usr/bin/osascript", [
      "-e",
      `tell application "Terminal" to do script "${command}"`
    ]);
  },
  async open(intent) {
    const terminalApp = terminalAppById("terminal");
    await execFileVoid("/usr/bin/open", ["-a", terminalApp.macOpenName, intent.cwd]);
  }
};

const itermLauncher: TerminalLauncher = {
  appId: "iterm2",
  async launch(intent) {
    const command = appleScriptString(tmuxShellCommand(intent));
    await execFileVoid("/usr/bin/osascript", iTermScript(command));
  },
  async open(intent) {
    const terminalApp = terminalAppById("iterm2");
    await execFileVoid("/usr/bin/open", ["-a", terminalApp.macOpenName, intent.cwd]);
  }
};

const ghosttyLauncher: TerminalLauncher = {
  appId: "ghostty",
  async launch(intent) {
    const terminalApp = terminalAppById("ghostty");
    await execFileVoid(
      "/usr/bin/open",
      ["-n", "-a", terminalApp.macOpenName, "--args", "-e", ...tmuxCommandArgs(intent)],
      {
        cwd: intent.cwd ?? undefined
      }
    );
  },
  async open(intent) {
    const terminalApp = terminalAppById("ghostty");
    await execFileVoid(
      "/usr/bin/open",
      ["-n", "-a", terminalApp.macOpenName, "--args", `--working-directory=${intent.cwd}`],
      {
        cwd: intent.cwd
      }
    );
  }
};

const launchers = new Map<DesktopTerminalAppId, TerminalLauncher>([
  [terminalLauncher.appId, terminalLauncher],
  [itermLauncher.appId, itermLauncher],
  [ghosttyLauncher.appId, ghosttyLauncher]
]);

export async function launchRunTerminal(
  appId: DesktopTerminalAppId,
  intent: TmuxAttachIntent
): Promise<void> {
  const launcher = launchers.get(appId);
  if (!launcher) {
    throw new Error(`Unsupported terminal app '${appId}'.`);
  }
  if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
    return;
  }
  await ensureTmuxSessionExists(intent.sessionName);
  await launcher.launch(intent);
}

export async function openTerminal(
  appId: DesktopTerminalAppId,
  intent: TerminalOpenIntent
): Promise<void> {
  const launcher = launchers.get(appId);
  if (!launcher) {
    throw new Error(`Unsupported terminal app '${appId}'.`);
  }
  if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
    return;
  }
  await launcher.open(intent);
}
