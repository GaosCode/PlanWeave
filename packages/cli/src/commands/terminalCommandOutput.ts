import { stripVTControlCharacters } from "node:util";

function unsafeTerminalControl(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code < 0x20 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function readable(value: string): string {
  return Array.from(stripVTControlCharacters(value))
    .filter((character) => !unsafeTerminalControl(character))
    .join("");
}

export function terminalField(label: string, value: string): string {
  return `${label}: ${readable(value).replace(/\n/g, "\n  ")}`;
}

export function terminalCommandExamples(label: string, argv: string[]): string[] {
  if (argv.some((arg) => Array.from(arg).some(unsafeTerminalControl))) {
    return [
      `${label} command unavailable: an argument contains unsafe terminal control characters.`
    ];
  }
  const posix = argv.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
  const powershell = argv
    .map((arg) => `'${arg.replace(/['\u2018-\u201b]/g, (quote) => quote + quote)}'`)
    .join(" ");
  return [label, `POSIX: ${posix}`, `PowerShell: & ${powershell}`];
}
