import { z } from "zod";

export const CAPTURE_DURATION_MS = 60_000;
export const CAPTURE_SAMPLE_LIMIT = 20_000;
export const captureIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,48}$/);
export const captureStageSchema = z.enum([
  "pointer_input",
  "renderer_send",
  "bridge_ack",
  "bridge_error",
  "socket_send",
  "socket_receive",
  "socket_open",
  "socket_close",
  "socket_error",
  "renderer_receive",
  "renderer_commit",
  "frame",
  "long_task",
  "hidden",
  "visible"
]);
export type CaptureStage = z.infer<typeof captureStageSchema>;
export const captureSampleSchema = z
  .object({
    stage: captureStageSchema,
    atMs: z.number().finite().nonnegative(),
    peer: z.number().int().nonnegative().optional(),
    pointer: z.boolean().optional(),
    durationMs: z.number().finite().nonnegative().optional()
  })
  .strict();
export type CaptureSample = z.infer<typeof captureSampleSchema>;
export const captureTraceSchema = z
  .object({
    captureId: captureIdSchema,
    startedAt: z.string().datetime(),
    durationMs: z.number().finite().nonnegative(),
    stopReason: z.enum(["running", "manual", "time_limit", "scope_changed", "sample_limit"]),
    scopeTag: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    samples: z.array(captureSampleSchema).max(CAPTURE_SAMPLE_LIMIT)
  })
  .strict();
export type CaptureTrace = z.infer<typeof captureTraceSchema>;
export const captureStartSchema = z
  .object({
    captureId: captureIdSchema,
    scopeKey: z.string().min(1).max(1024)
  })
  .strict();
export const captureExportSchema = z
  .object({
    renderer: captureTraceSchema,
    transport: captureTraceSchema,
    longTaskSupported: z.boolean()
  })
  .strict()
  .refine((value) => value.renderer.captureId === value.transport.captureId, {
    message: "Capture IDs must match."
  });
export type CaptureExport = z.infer<typeof captureExportSchema>;
export type CollaborationCaptureApi = {
  start(input: z.infer<typeof captureStartSchema>): Promise<void>;
  stop(): Promise<CaptureTrace | null>;
  export(input: CaptureExport): Promise<boolean>;
};
