import { useEffect } from "react";

export function useTaskWorkspaceReturnShortcut(onReturnToCanvas: () => void): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === "[") {
        event.preventDefault();
        onReturnToCanvas();
      }
    };
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [onReturnToCanvas]);
}
