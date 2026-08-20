import type { WorkRuntimePackageFactsPort } from "../work/runtimePort.js";
import type { WorkItemPackagePort } from "../work/workItemFacts.js";

export function runtimeFactsFromPackagePort(
  packagePort: WorkItemPackagePort,
  release: () => void = () => {}
): WorkRuntimePackageFactsPort {
  return {
    async acquireFacts(input) {
      const facts = packagePort.resolveWorkItems(input.workItems);
      return {
        package: {
          resolveWorkItem(item) {
            const index = input.workItems.findIndex(
              (candidate) => JSON.stringify(candidate) === JSON.stringify(item)
            );
            if (index < 0) throw new Error("runtime_package_fact_not_requested");
            return facts[index]!;
          },
          resolveWorkItems(items) {
            return items.map((item) => this.resolveWorkItem(item));
          }
        },
        evidence: {
          sourceRevision: "snapshot:test",
          graphFingerprint: `pkg-${"a".repeat(64)}`
        },
        release
      };
    }
  };
}
