export type HostInventoryOperationMode = "refresh" | "continue";

type HostInventoryOperationJob = {
  mode: HostInventoryOperationMode;
  promise: Promise<void>;
  start: () => void;
};

type HostInventoryOperationLane = {
  active: HostInventoryOperationJob | null;
  queued: HostInventoryOperationJob | null;
};

export type HostInventoryOperationCoordinator = {
  run: (
    authorityKey: string,
    mode: HostInventoryOperationMode,
    operation: () => Promise<void>
  ) => Promise<void>;
};

export function createHostInventoryOperationCoordinator(): HostInventoryOperationCoordinator {
  const lanes = new Map<string, HostInventoryOperationLane>();

  const createJob = (
    authorityKey: string,
    lane: HostInventoryOperationLane,
    mode: HostInventoryOperationMode,
    operation: () => Promise<void>
  ): HostInventoryOperationJob => {
    let resolveJob!: () => void;
    let rejectJob!: (cause: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job: HostInventoryOperationJob = {
      mode,
      promise,
      start() {
        const advanceLane = () => {
          if (lane.active !== job) return;
          const queued = lane.queued;
          lane.queued = null;
          lane.active = queued;
          if (queued) {
            queued.start();
          } else {
            lanes.delete(authorityKey);
          }
        };
        let execution: Promise<void>;
        try {
          execution = operation();
        } catch (cause) {
          advanceLane();
          rejectJob(cause);
          return;
        }
        execution.then(
          () => {
            advanceLane();
            resolveJob();
          },
          (cause) => {
            advanceLane();
            rejectJob(cause);
          }
        );
      }
    };
    return job;
  };

  return {
    run(authorityKey, mode, operation) {
      const lane = lanes.get(authorityKey) ?? { active: null, queued: null };
      lanes.set(authorityKey, lane);

      if (lane.active?.mode === mode) return lane.active.promise;
      if (lane.queued?.mode === mode) return lane.queued.promise;
      const job = createJob(authorityKey, lane, mode, operation);
      if (!lane.active) {
        lane.active = job;
        job.start();
        return job.promise;
      }

      lane.queued = job;
      return job.promise;
    }
  };
}
