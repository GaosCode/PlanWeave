import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  CreateElicitationResponse as CreateElicitationResponseGuard,
  ElicitationPropertySchema,
  MultiSelectItems,
  type CreateElicitationResponse,
  type ElicitationPropertySchema as AcpElicitationPropertySchema,
  type ElicitationSchema
} from "@agentclientprotocol/sdk";
import type { JsonRpcValue } from "./liveControl.js";
import {
  AcpInteractionSettlementError,
  createAcpInteractionSettlement
} from "./acpInteractionSettlement.js";

export type AcpElicitationResult = {
  outcome: "submitted" | "cancelled";
  message: string;
};

export class AcpElicitationSettlementError extends AcpInteractionSettlementError {
  constructor(message: string) {
    super(message);
    this.name = "AcpElicitationSettlementError";
  }
}

type AcpElicitationSettlementOptions = {
  requestId: string;
  requestedSchema: ElicitationSchema;
  publishResult: (result: AcpElicitationResult) => Promise<void>;
  complete: (response: CreateElicitationResponse) => void;
};

export type AcpElicitationSettlement = {
  respond(value: JsonRpcValue): Promise<void>;
  cancel(): Promise<void>;
};

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: true
});
addFormats.default(ajv, { formats: ["email", "uri", "date", "date-time"] });

function propertyValidationSchema(property: AcpElicitationPropertySchema): Record<string, unknown> {
  if (ElicitationPropertySchema.isString(property)) {
    return compactSchema({
      type: "string",
      minLength: property.minLength,
      maxLength: property.maxLength,
      pattern: property.pattern,
      format: property.format,
      enum: property.enum,
      oneOf: property.oneOf?.map((option) => ({ const: option.const }))
    });
  }
  if (ElicitationPropertySchema.isNumber(property)) {
    return compactSchema({
      type: "number",
      minimum: property.minimum,
      maximum: property.maximum
    });
  }
  if (ElicitationPropertySchema.isInteger(property)) {
    return compactSchema({
      type: "integer",
      minimum: property.minimum,
      maximum: property.maximum
    });
  }
  if (ElicitationPropertySchema.isBoolean(property)) return { type: "boolean" };
  if (ElicitationPropertySchema.isArray(property)) {
    let allowed: readonly string[];
    if (MultiSelectItems.isString(property.items)) {
      allowed = property.items.enum;
    } else if (MultiSelectItems.isTitled(property.items)) {
      allowed = property.items.anyOf.map((option) => option.const);
    } else {
      throw new AcpElicitationSettlementError(
        "Preview elicitation uses an unsupported multi-select item schema."
      );
    }
    return compactSchema({
      type: "array",
      items: { type: "string", enum: [...allowed] },
      minItems: property.minItems,
      maxItems: property.maxItems
    });
  }
  throw new AcpElicitationSettlementError(
    `Preview elicitation uses unsupported property type '${String(property.type)}'.`
  );
}

function compactSchema(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null)
  );
}

function compileContentValidator(schema: ElicitationSchema): ValidateFunction {
  if (schema.type !== undefined && schema.type !== "object") {
    throw new AcpElicitationSettlementError(
      `Preview elicitation root type '${String(schema.type)}' is unsupported.`
    );
  }
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, property]) => [
      name,
      propertyValidationSchema(property)
    ])
  );
  const requestedSchema = compactSchema({
    type: "object",
    properties,
    required: schema.required
  });
  try {
    return ajv.compile(requestedSchema);
  } catch (error) {
    throw new AcpElicitationSettlementError(
      `Preview elicitation schema is unsupported: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function validationDiagnostic(errors: readonly ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "content did not match the advertised schema";
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function normalizeResponse(
  value: JsonRpcValue,
  validateContent: ValidateFunction
): { response: CreateElicitationResponse; result: AcpElicitationResult } {
  const candidate = value as CreateElicitationResponse;
  if (CreateElicitationResponseGuard.isAccept(candidate)) {
    const content = candidate.content ?? {};
    if (!validateContent(content)) {
      throw new AcpElicitationSettlementError(
        `Preview elicitation response is invalid: ${validationDiagnostic(validateContent.errors)}`
      );
    }
    return {
      response: { action: "accept", content },
      result: {
        outcome: "submitted",
        message: "Preview elicitation response was submitted."
      }
    };
  }
  if (CreateElicitationResponseGuard.isCancel(candidate)) {
    return {
      response: { action: "cancel" },
      result: {
        outcome: "cancelled",
        message: "Preview elicitation was cancelled."
      }
    };
  }
  if (CreateElicitationResponseGuard.isDecline(candidate)) {
    return {
      response: { action: "decline" },
      result: {
        outcome: "cancelled",
        message: "Preview elicitation was declined."
      }
    };
  }
  throw new AcpElicitationSettlementError(
    "Preview elicitation response is not a supported ACP wire response."
  );
}

export function createAcpElicitationSettlement(
  options: AcpElicitationSettlementOptions
): AcpElicitationSettlement {
  const validateContent = compileContentValidator(options.requestedSchema);
  const settlement = createAcpInteractionSettlement({
    requestId: options.requestId,
    normalize: (value: JsonRpcValue) => normalizeResponse(value, validateContent),
    publishResult: options.publishResult,
    complete: options.complete
  });

  return {
    respond: settlement.settle,
    cancel: () => settlement.settle({ action: "cancel" })
  };
}
