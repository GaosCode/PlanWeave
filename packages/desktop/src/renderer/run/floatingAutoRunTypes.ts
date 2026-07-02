import type { Dispatch, SetStateAction } from "react";
import type { ExecutorPreflightResult } from "@planweave-ai/runtime";
import type { createTranslator } from "../i18n";
import type { AutoRunScopeMode } from "../types";

export type FloatingAutoRunTranslator = ReturnType<typeof createTranslator>;

export type AutoRunScopeModeSetter = Dispatch<SetStateAction<AutoRunScopeMode>>;

export type ExecutorPreflightView = {
  error: string | null;
  loading: boolean;
  result: ExecutorPreflightResult | null;
  runPreflight: () => Promise<ExecutorPreflightResult | null>;
};
