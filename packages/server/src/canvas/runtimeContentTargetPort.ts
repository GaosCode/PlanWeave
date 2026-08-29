import type { RuntimeCanvasScope } from "./executionRuntimePort.js";

export type RuntimeContentTargetEvidence = {
  revision: number;
  graphFingerprint: string;
};

export interface RuntimeContentTargetAuthorityPort {
  read(scope: RuntimeCanvasScope): RuntimeContentTargetEvidence;
}
