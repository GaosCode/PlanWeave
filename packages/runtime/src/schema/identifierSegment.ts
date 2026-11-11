import { z } from "zod";

const identifierSegmentCharacters = /^[^#]*$/;

export const identifierSegmentSchema = z
  .string()
  .min(1)
  .regex(identifierSegmentCharacters, "ID must not contain '#'.");

export function isIdentifierSegment(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && identifierSegmentCharacters.test(value);
}
