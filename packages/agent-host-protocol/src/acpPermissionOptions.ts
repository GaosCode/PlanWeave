import { z } from "zod";

export const ACP_PERMISSION_OPTION_ID_MAX_BYTES = 1_024 as const;
export const ACP_PERMISSION_OPTION_LABEL_MAX_LENGTH = 512 as const;
export const ACP_PERMISSION_OPTION_MAX_COUNT = 64 as const;
export const EXACT_PERMISSION_OPTIONS_VERSION_HEADER =
  "x-planweave-exact-permission-options-version" as const;
export const exactPermissionOptionsVersionSchema = z.literal(1);

const encoder = new TextEncoder();

export const acpPermissionOptionIdSchema = z
  .string()
  .min(1)
  .max(ACP_PERMISSION_OPTION_ID_MAX_BYTES)
  .refine(
    (value) =>
      !/[\uD800-\uDFFF]/u.test(value) &&
      encoder.encode(value).byteLength <= ACP_PERMISSION_OPTION_ID_MAX_BYTES,
    "Permission option ID must be valid Unicode within the UTF-8 byte budget."
  );

export const acpPermissionOptionSchema = z
  .object({
    optionId: acpPermissionOptionIdSchema,
    label: z.string().min(1).max(ACP_PERMISSION_OPTION_LABEL_MAX_LENGTH),
    kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"])
  })
  .strict();

export const acpPermissionOptionsSchema = z
  .array(acpPermissionOptionSchema)
  .min(1)
  .max(ACP_PERMISSION_OPTION_MAX_COUNT)
  .refine(
    (options) => new Set(options.map(({ optionId }) => optionId)).size === options.length,
    "Permission option IDs must be unique."
  );

export const exactPermissionSelectionSchema = z.discriminatedUnion("decision", [
  z
    .object({ decision: z.literal("select_option"), optionId: acpPermissionOptionIdSchema })
    .strict(),
  z.object({ decision: z.literal("deny") }).strict()
]);

export type AcpPermissionOption = z.infer<typeof acpPermissionOptionSchema>;
export type ExactPermissionSelection = z.infer<typeof exactPermissionSelectionSchema>;

/** The returned ID belongs to the original request; null means ACP cancelled. */
export function selectedAcpPermissionOptionId(
  optionsInput: unknown,
  selectionInput: unknown
): string | null {
  const options = acpPermissionOptionsSchema.parse(optionsInput);
  const selection = exactPermissionSelectionSchema.parse(selectionInput);
  if (selection.decision === "deny") return null;
  if (!options.some(({ optionId }) => optionId === selection.optionId)) {
    throw new Error("interaction_permission_option_unknown");
  }
  return selection.optionId;
}

/** Absence identifies an old Host. Explicit unsupported or repeated headers fail closed. */
export function negotiateExactPermissionOptionsVersion(header: unknown): 1 | undefined {
  if (header === undefined) return undefined;
  if (header !== "1") throw new Error("exact_permission_options_unsupported");
  return 1;
}

export function requireExactPermissionOptionsVersion(version: unknown): void {
  if (!exactPermissionOptionsVersionSchema.safeParse(version).success) {
    throw new Error("exact_permission_options_unsupported");
  }
}
