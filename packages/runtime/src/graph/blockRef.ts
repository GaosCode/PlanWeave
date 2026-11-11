import { isIdentifierSegment } from "../schema/identifierSegment.js";

export function parseBlockRef(ref: string): { taskId: string; blockId: string } {
  const [taskId, blockId, extraSegment] = ref.split("#", 3);
  if (extraSegment !== undefined || !isIdentifierSegment(taskId) || !isIdentifierSegment(blockId)) {
    throw new Error(`Invalid block ref '${ref}'. Expected '<task-id>#<block-id>'.`);
  }
  return { taskId, blockId };
}
