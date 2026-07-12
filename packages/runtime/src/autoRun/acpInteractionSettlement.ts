export class AcpInteractionSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpInteractionSettlementError";
  }
}

type AcpInteractionSettlementOptions<Input, Response, Result> = {
  requestId: string;
  normalize: (input: Input) => { response: Response; result: Result };
  publishResult: (result: Result) => Promise<void>;
  complete: (response: Response) => void;
};

export function createAcpInteractionSettlement<Input, Response, Result>(
  options: AcpInteractionSettlementOptions<Input, Response, Result>
): { settle(input: Input): Promise<void> } {
  let state: "pending" | "settling" | "settled" = "pending";

  return {
    settle: async (input) => {
      if (state !== "pending") {
        throw new AcpInteractionSettlementError(
          `Live runner request '${options.requestId}' was already answered.`
        );
      }
      state = "settling";
      let committed = false;
      try {
        const normalized = options.normalize(input);
        await options.publishResult(normalized.result);
        committed = true;
        state = "settled";
        options.complete(normalized.response);
      } catch (error) {
        if (!committed) state = "pending";
        throw error;
      }
    }
  };
}
