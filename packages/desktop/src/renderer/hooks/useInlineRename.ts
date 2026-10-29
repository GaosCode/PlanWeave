import { useLayoutEffect, useRef, useState } from "react";
import type { RenameRequest, RenameResult } from "../renameResult";

type InlineRenameOptions = {
  active: boolean;
  name: string;
  scopeKey: string;
  onClose: () => void;
  onSave: (name: string, request: RenameRequest) => Promise<RenameResult>;
};

export function useInlineRename({ active, name, scopeKey, onClose, onSave }: InlineRenameOptions) {
  const [draft, setDraftValue] = useState(name);
  const edited = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lifecycle = useRef({
    generation: 0,
    pending: false,
    active: false,
    editorActive: false,
    scopeKey
  });
  const nameRef = useRef(name);
  nameRef.current = name;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const state = lifecycle.current;
    const changedScope = state.editorActive && state.scopeKey !== scopeKey;
    state.editorActive = active;
    state.generation += 1;
    state.pending = false;
    state.active = active && !changedScope;
    state.scopeKey = scopeKey;
    setPending(false);
    setFailed(false);
    edited.current = false;
    setDraftValue(nameRef.current);
    if (active && changedScope) closeRef.current();
    if (state.active) {
      const frame = requestAnimationFrame(() => {
        if (!edited.current) {
          inputRef.current?.focus();
          inputRef.current?.select();
        }
      });
      return () => {
        cancelAnimationFrame(frame);
        state.generation += 1;
        state.active = false;
      };
    }
    return () => {
      state.generation += 1;
      state.active = false;
    };
  }, [active, scopeKey]);

  const cancel = () => {
    lifecycle.current.generation += 1;
    lifecycle.current.active = false;
    closeRef.current();
  };

  const commit = async () => {
    const state = lifecycle.current;
    if (!state.active || state.pending) return;
    const nextName = draft.trim();
    if (!nextName || nextName === name.trim()) {
      cancel();
      return;
    }
    state.pending = true;
    setPending(true);
    setFailed(false);
    const generation = state.generation;
    const request = {
      isCurrent: () => state.active && state.generation === generation
    };
    const result = await onSave(nextName, request);
    if (!request.isCurrent()) return;
    state.pending = false;
    setPending(false);
    if (result.status === "failed") {
      setFailed(true);
    } else {
      cancel();
    }
  };

  const setDraft = (value: string) => {
    edited.current = true;
    setDraftValue(value);
  };
  return { cancel, commit, draft, failed, inputRef, pending, setDraft };
}
