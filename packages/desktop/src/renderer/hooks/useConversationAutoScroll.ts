import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD = 48;

export function useConversationAutoScroll(changeKey: number) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (typeof viewport.scrollTo === "function") {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior });
    } else {
      viewport.scrollTop = viewport.scrollHeight;
    }
    setFollowing(true);
  }, []);

  useEffect(() => {
    if (following) scrollToBottom("auto");
  }, [changeKey, following, scrollToBottom]);

  const onScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setFollowing(
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD
    );
  }, []);

  return { following, onScroll, scrollToBottom, viewportRef };
}
