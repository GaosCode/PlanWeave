import { identifierSegmentRequirement, isIdentifierSegment } from "../schema/identifierSegment.js";

export function parseBlockRef(ref: string): { taskId: string; blockId: string } {
  const [taskId, blockId, extraSegment] = ref.split("#", 3);
  if (extraSegment !== undefined || !taskId || !blockId) {
    throw new Error(`Invalid block ref '${ref}'. Expected '<task-id>#<block-id>'.`);
  }
  if (!isIdentifierSegment(taskId) || !isIdentifierSegment(blockId)) {
    const invalidPart = isIdentifierSegment(taskId) ? "Block" : "Task";
    throw new Error(`Invalid block ref '${ref}'. ${invalidPart} ${identifierSegmentRequirement}`);
  }
  return { taskId, blockId };
}
