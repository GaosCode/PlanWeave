import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

const keyboardResizeStep = 16;

export function useInspectorResize(options: {
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
}) {
  const { inspectorWidth, setInspectorWidth } = options;
  const cleanupRef = useRef<(() => void) | null>(null);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      cleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = inspectorWidth;
      const handlePointerMove = (moveEvent: PointerEvent) => {
        setInspectorWidth(startWidth - (moveEvent.clientX - startX));
      };
      const cleanup = () => {
        globalThis.removeEventListener("pointermove", handlePointerMove);
        globalThis.removeEventListener("pointerup", cleanup);
        globalThis.removeEventListener("pointercancel", cleanup);
        if (cleanupRef.current === cleanup) {
          cleanupRef.current = null;
        }
      };
      cleanupRef.current = cleanup;
      globalThis.addEventListener("pointermove", handlePointerMove);
      globalThis.addEventListener("pointerup", cleanup);
      globalThis.addEventListener("pointercancel", cleanup);
    },
    [inspectorWidth, setInspectorWidth]
  );

  const resizeWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? keyboardResizeStep : -keyboardResizeStep;
      setInspectorWidth(inspectorWidth + delta);
    },
    [inspectorWidth, setInspectorWidth]
  );

  useEffect(() => () => cleanupRef.current?.(), []);

  return { resizeWithKeyboard, startResize };
}
