import { z } from "zod";

const EXECUTOR_AGENT_INFO_FIELD_MAX_LENGTH = 256;

export const invalidExecutorAgentInfoMessage =
  "ACP initialize returned invalid agentInfo; name and version must be non-empty strings.";

export const executorAgentInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(EXECUTOR_AGENT_INFO_FIELD_MAX_LENGTH),
    version: z.string().trim().min(1).max(EXECUTOR_AGENT_INFO_FIELD_MAX_LENGTH)
  })
  .strict();
export type ExecutorAgentInfo = z.infer<typeof executorAgentInfoSchema>;
