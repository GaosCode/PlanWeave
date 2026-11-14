import { z } from "zod";

const forbiddenIdentifierCharacters = /[#<>:"/\\|?*]/;
const windowsDeviceName = /^(?:CON(?:IN\$|OUT\$)?|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³]) *(?:\.|$)/i;

export const identifierSegmentRequirement =
  "ID must be a non-empty portable directory name without '#', path separators, Windows-reserved characters or device names, leading spaces, or trailing spaces or periods.";

export function isIdentifierSegment(value: string | undefined): value is string {
  if (
    !value ||
    forbiddenIdentifierCharacters.test(value) ||
    windowsDeviceName.test(value) ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.endsWith(".")
  ) {
    return false;
  }
  for (const character of value) {
    if (character < " ") return false;
  }
  return true;
}

export const identifierSegmentSchema = z
  .string()
  .refine(isIdentifierSegment, identifierSegmentRequirement);
