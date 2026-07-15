export function parseBlockRef(ref: string): { taskId: string; blockId: string } {
  const parts = ref.split("#");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid block ref '${ref}'. Expected '<task-id>#<block-id>'.`);
  }
  return { taskId: parts[0], blockId: parts[1] };
}
