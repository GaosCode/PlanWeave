import { describe, expect, it } from "vitest";
import {
  quoteWindowsCmdArgument,
  windowsBatchCommandLine
} from "../process/windowsManagedProcess.js";

describe("Windows process invocation quoting", () => {
  it("leaves simple arguments unquoted", () => {
    expect(quoteWindowsCmdArgument("--version")).toBe("--version");
    expect(quoteWindowsCmdArgument(String.raw`C:\tools\codex.cmd`)).toBe(
      String.raw`C:\tools\codex.cmd`
    );
  });

  it("quotes spaces and doubles embedded quotes", () => {
    expect(quoteWindowsCmdArgument(String.raw`C:\Program Files\app\tool.cmd`)).toBe(
      String.raw`"C:\Program Files\app\tool.cmd"`
    );
    expect(quoteWindowsCmdArgument('say "hi"')).toBe(`"say ""hi"""`);
  });

  it("builds a batch command line for cmd.exe /d /s /c probes", () => {
    expect(
      windowsBatchCommandLine(String.raw`C:\Users\dev\AppData\Roaming\npm\codex.cmd`, ["--version"])
    ).toBe(String.raw`C:\Users\dev\AppData\Roaming\npm\codex.cmd --version`);
    expect(
      windowsBatchCommandLine(String.raw`C:\Program Files\tools\opencode.cmd`, ["acp", "--help"])
    ).toBe(String.raw`"C:\Program Files\tools\opencode.cmd" acp --help`);
  });
});
