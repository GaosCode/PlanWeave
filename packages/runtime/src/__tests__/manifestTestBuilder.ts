import type { ExecutorProfile, ManifestBlock, ManifestTaskNode, PlanPackageManifest } from "../types.js";
import { basicManifest } from "./promptTestHelpers.js";

type BasicManifestOptions = Parameters<typeof basicManifest>[0];

export function manifestTestBuilder(options: BasicManifestOptions = {}): PlanPackageManifestTestBuilder {
  return new PlanPackageManifestTestBuilder(basicManifest(options));
}

export class PlanPackageManifestTestBuilder {
  private readonly manifest: PlanPackageManifest;

  constructor(manifest: PlanPackageManifest = basicManifest()) {
    this.manifest = structuredClone(manifest);
  }

  withExecutor(name: string, profile: ExecutorProfile): this {
    this.manifest.executors = {
      ...(this.manifest.executors ?? {}),
      [name]: profile
    };
    return this;
  }

  withDefaultExecutor(name: string): this {
    this.manifest.execution = {
      ...this.manifest.execution,
      defaultExecutor: name
    };
    return this;
  }

  withReviewCycles(maxFeedbackCycles: number): this {
    this.manifest.review = {
      ...this.manifest.review,
      maxFeedbackCycles
    };
    this.manifest.nodes = this.manifest.nodes.map((task) => ({
      ...task,
      blocks: task.blocks.map((block) =>
        block.type === "review"
          ? {
              ...block,
              review: {
                ...block.review,
                maxFeedbackCycles
              }
            }
          : block
      )
    }));
    return this;
  }

  withParallelExecution({ enabled = true, maxConcurrent = 1 }: { enabled?: boolean; maxConcurrent?: number } = {}): this {
    this.manifest.execution = {
      ...this.manifest.execution,
      parallel: {
        enabled,
        maxConcurrent
      }
    };
    return this;
  }

  withTask(taskId: string, update: (task: ManifestTaskNode) => ManifestTaskNode): this {
    let found = false;
    this.manifest.nodes = this.manifest.nodes.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      found = true;
      return update(task);
    });
    if (!found) {
      throw new Error(`Missing manifest task '${taskId}'.`);
    }
    return this;
  }

  withBlock(taskId: string, blockId: string, update: (block: ManifestBlock) => ManifestBlock): this {
    let found = false;
    this.withTask(taskId, (task) => ({
      ...task,
      blocks: task.blocks.map((block) => {
        if (block.id !== blockId) {
          return block;
        }
        found = true;
        return update(block);
      })
    }));
    if (!found) {
      throw new Error(`Missing manifest block '${taskId}#${blockId}'.`);
    }
    return this;
  }

  build(): PlanPackageManifest {
    return structuredClone(this.manifest);
  }
}
