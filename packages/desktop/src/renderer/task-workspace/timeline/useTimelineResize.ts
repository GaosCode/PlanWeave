import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

const keyboardResizeStep = 16;

export function useTimelineResize(options: {
  setTimelineWidth: (width: number) => void;
  timelineWidth: number;
}) {
  const { setTimelineWidth, timelineWidth } = options;
  const cleanupRef = useRef<(() => void) | null>(null);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      cleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = timelineWidth;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setTimelineWidth(startWidth + moveEvent.clientX - startX);
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
    [setTimelineWidth, timelineWidth]
  );

  const resizeWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      let widthDelta = -keyboardResizeStep;
      if (event.key === "ArrowRight") {
        widthDelta = keyboardResizeStep;
      }
      setTimelineWidth(timelineWidth + widthDelta);
    },
    [setTimelineWidth, timelineWidth]
  );

  useEffect(() => () => cleanupRef.current?.(), []);

  return { resizeWithKeyboard, startResize };
}
