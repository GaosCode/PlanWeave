import type { GraphEditResult } from "../types.js";
import type { DesktopGraphEditResult } from "./types.js";

export function cloneDesktopGraphEditResult(result: GraphEditResult): DesktopGraphEditResult {
  const { graph: _graph, ...cloneable } = result;
  return cloneable;
}
