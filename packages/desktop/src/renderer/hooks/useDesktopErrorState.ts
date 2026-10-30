import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

export type CaptureDesktopErrorClear = () => () => void;

export function useDesktopErrorState() {
  const [error, publishError] = useState<string | null>(null);
  const revision = useRef(0);
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>((value) => {
    revision.current += 1;
    publishError(value);
  }, []);
  const captureErrorClear = useCallback(() => {
    const captured = revision.current;
    return () => {
      if (revision.current === captured) setError(null);
    };
  }, [setError]);
  return { error, setError, captureErrorClear };
}
