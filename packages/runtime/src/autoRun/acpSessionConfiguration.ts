import type { NewSessionResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { NormalizedRunnerEvent } from "./normalizedEventContract.js";

const acpSessionTextSchema = z.string().max(4_096);
const acpSessionDescriptionSchema = acpSessionTextSchema.nullable();

export const acpSessionModeSchema = z
  .object({
    id: acpSessionTextSchema,
    name: acpSessionTextSchema,
    description: acpSessionDescriptionSchema
  })
  .strict();

export const acpSessionModeStateSchema = z
  .object({
    currentModeId: acpSessionTextSchema,
    availableModes: z.array(acpSessionModeSchema).max(256)
  })
  .strict();

export const acpSessionConfigOptionSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: acpSessionTextSchema,
      type: z.literal("select"),
      name: acpSessionTextSchema,
      description: acpSessionDescriptionSchema,
      category: acpSessionTextSchema.nullable(),
      currentValue: acpSessionTextSchema,
      options: z
        .array(
          z
            .object({
              value: acpSessionTextSchema,
              name: acpSessionTextSchema,
              description: acpSessionDescriptionSchema,
              group: acpSessionTextSchema.nullable()
            })
            .strict()
        )
        .max(512)
    })
    .strict(),
  z
    .object({
      id: acpSessionTextSchema,
      type: z.literal("boolean"),
      name: acpSessionTextSchema,
      description: acpSessionDescriptionSchema,
      category: acpSessionTextSchema.nullable(),
      currentValue: z.boolean()
    })
    .strict()
]);

export const acpSessionConfigurationSchema = z
  .object({
    modes: acpSessionModeStateSchema.nullable(),
    configOptions: z.array(acpSessionConfigOptionSchema).max(256)
  })
  .strict();

const actualConfigurationSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("config_option"), optionId: acpSessionTextSchema }).strict(),
  z.object({ kind: z.literal("session_mode"), optionId: z.null() }).strict(),
  z
    .object({ kind: z.literal("config_option_and_session_mode"), optionId: acpSessionTextSchema })
    .strict()
]);

export const acpActualConfigurationFieldSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      value: z.union([acpSessionTextSchema, z.boolean()]),
      source: actualConfigurationSourceSchema,
      reason: z.null()
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      value: z.null(),
      source: z.null(),
      reason: z.string().min(1).max(1_024)
    })
    .strict()
]);

export const acpActualSessionConfigurationSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      sequence: z.number().int().positive(),
      observedAt: z.string().datetime(),
      sessionId: z.string().min(1).max(4_096),
      protocol: acpSessionConfigurationSchema,
      fields: z
        .object({
          model: acpActualConfigurationFieldSchema,
          reasoning: acpActualConfigurationFieldSchema,
          mode: acpActualConfigurationFieldSchema,
          permission: acpActualConfigurationFieldSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.string().min(1).max(1_024)
    })
    .strict()
]);

export type AcpSessionConfiguration = z.infer<typeof acpSessionConfigurationSchema>;
export type AcpSessionConfigOption = z.infer<typeof acpSessionConfigOptionSchema>;
export type AcpActualSessionConfiguration = z.infer<typeof acpActualSessionConfigurationSchema>;
export type AcpActualConfigurationField = z.infer<typeof acpActualConfigurationFieldSchema>;

function normalizeConfigOptions(
  configOptions: readonly SessionConfigOption[] | null | undefined
): AcpSessionConfigOption[] {
  return (configOptions ?? []).map((option) => {
    if (option.type === "boolean") {
      return acpSessionConfigOptionSchema.parse({
        id: option.id,
        type: option.type,
        name: option.name,
        description: option.description ?? null,
        category: option.category ?? null,
        currentValue: option.currentValue
      });
    }
    const values: Array<{
      value: string;
      name: string;
      description: string | null;
      group: string | null;
    }> = [];
    for (const candidate of option.options) {
      if ("group" in candidate) {
        for (const grouped of candidate.options) {
          values.push({
            value: grouped.value,
            name: grouped.name,
            description: grouped.description ?? null,
            group: candidate.name
          });
        }
      } else {
        values.push({
          value: candidate.value,
          name: candidate.name,
          description: candidate.description ?? null,
          group: null
        });
      }
    }
    return acpSessionConfigOptionSchema.parse({
      id: option.id,
      type: option.type,
      name: option.name,
      description: option.description ?? null,
      category: option.category ?? null,
      currentValue: option.currentValue,
      options: values
    });
  });
}

export function sessionConfigurationFromProtocol(options: {
  modes: NewSessionResponse["modes"];
  configOptions: readonly SessionConfigOption[] | null | undefined;
}): AcpSessionConfiguration {
  return acpSessionConfigurationSchema.parse({
    modes: options.modes
      ? {
          currentModeId: options.modes.currentModeId,
          availableModes: options.modes.availableModes.map((mode) => ({
            id: mode.id,
            name: mode.name,
            description: mode.description ?? null
          }))
        }
      : null,
    configOptions: normalizeConfigOptions(options.configOptions)
  });
}

export function sessionConfigurationFromNewSession(
  session: NewSessionResponse
): AcpSessionConfiguration {
  return sessionConfigurationFromProtocol({
    modes: session.modes,
    configOptions: session.configOptions
  });
}

const unavailablePermissionReason =
  "Permission policy is unavailable because ACP does not define a portable session permission configuration field.";

function unavailable(reason: string): AcpActualConfigurationField {
  return { available: false, value: null, source: null, reason };
}

function fieldFromCategory(
  configuration: AcpSessionConfiguration,
  category: "model" | "thought_level"
): AcpActualConfigurationField {
  const matches = configuration.configOptions.filter((option) => option.category === category);
  if (matches.length === 0) {
    return unavailable(`ACP did not advertise a '${category}' configuration option.`);
  }
  if (matches.length > 1) {
    return unavailable(`ACP advertised multiple '${category}' configuration options.`);
  }
  const option = matches[0]!;
  return {
    available: true,
    value: option.currentValue,
    source: { kind: "config_option", optionId: option.id },
    reason: null
  };
}

function modeField(configuration: AcpSessionConfiguration): AcpActualConfigurationField {
  const matches = configuration.configOptions.filter((option) => option.category === "mode");
  if (matches.length > 1) {
    return unavailable("ACP advertised multiple 'mode' configuration options.");
  }
  const option = matches[0];
  const sessionMode = configuration.modes?.currentModeId;
  if (option && sessionMode !== undefined && option.currentValue !== sessionMode) {
    return unavailable("ACP session mode and the advertised 'mode' configuration option disagree.");
  }
  if (option && sessionMode !== undefined) {
    return {
      available: true,
      value: option.currentValue,
      source: { kind: "config_option_and_session_mode", optionId: option.id },
      reason: null
    };
  }
  if (option) {
    return {
      available: true,
      value: option.currentValue,
      source: { kind: "config_option", optionId: option.id },
      reason: null
    };
  }
  if (sessionMode !== undefined) {
    return {
      available: true,
      value: sessionMode,
      source: { kind: "session_mode", optionId: null },
      reason: null
    };
  }
  return unavailable("ACP did not advertise a session mode or a 'mode' configuration option.");
}

function availableConfiguration(options: {
  configuration: AcpSessionConfiguration;
  sequence: number;
  observedAt: string;
  sessionId: string;
}): AcpActualSessionConfiguration {
  return acpActualSessionConfigurationSchema.parse({
    available: true,
    sequence: options.sequence,
    observedAt: options.observedAt,
    sessionId: options.sessionId,
    protocol: options.configuration,
    fields: {
      model: fieldFromCategory(options.configuration, "model"),
      reasoning: fieldFromCategory(options.configuration, "thought_level"),
      mode: modeField(options.configuration),
      permission: unavailable(unavailablePermissionReason)
    }
  });
}

export function projectAcpActualSessionConfiguration(
  events: readonly NormalizedRunnerEvent[]
): AcpActualSessionConfiguration {
  let configuration: AcpSessionConfiguration | null = null;
  let sessionId: string | null = null;
  let sequence: number | null = null;
  let observedAt: string | null = null;
  let failure: string | null = null;
  let initialSeen = false;
  let defaultsSeen = false;

  for (const event of events) {
    const body = event.body;
    if (
      body.kind !== "session_configuration_snapshot" &&
      body.kind !== "session_mode_update" &&
      body.kind !== "session_config_options_update"
    ) {
      continue;
    }
    const correlatedSessionId = event.correlation?.sessionId;
    if (!correlatedSessionId) {
      failure = "ACP configuration event is missing its authoritative sessionId correlation.";
      continue;
    }
    if (sessionId !== null && sessionId !== correlatedSessionId) {
      failure = "ACP configuration events reference more than one sessionId in one runner record.";
      continue;
    }
    sessionId = correlatedSessionId;

    if (body.kind === "session_configuration_snapshot") {
      if (body.phase === "initial") {
        if (initialSeen || defaultsSeen) {
          failure = "ACP initial configuration snapshot is duplicated or out of order.";
          continue;
        }
        initialSeen = true;
      } else {
        if (!initialSeen || defaultsSeen) {
          failure =
            "ACP defaults-applied configuration snapshot is missing its initial snapshot or duplicated.";
          continue;
        }
        defaultsSeen = true;
      }
      configuration = body.configuration;
    } else if (configuration === null) {
      failure = "ACP configuration update precedes the authoritative initial snapshot.";
      continue;
    } else if (body.kind === "session_config_options_update") {
      configuration = acpSessionConfigurationSchema.parse({
        ...configuration,
        configOptions: body.configOptions
      });
    } else if (configuration.modes === null) {
      failure = "ACP current mode update has no advertised session mode state to update.";
      continue;
    } else {
      configuration = acpSessionConfigurationSchema.parse({
        ...configuration,
        modes: { ...configuration.modes, currentModeId: body.currentModeId }
      });
    }
    sequence = event.sequence;
    observedAt = event.timestamp;
  }

  if (failure !== null) return { available: false, reason: failure };
  if (
    configuration === null ||
    sessionId === null ||
    sequence === null ||
    observedAt === null ||
    !initialSeen
  ) {
    return {
      available: false,
      reason: "No authoritative ACP session configuration snapshot was recorded for this run."
    };
  }
  return availableConfiguration({ configuration, sequence, observedAt, sessionId });
}
