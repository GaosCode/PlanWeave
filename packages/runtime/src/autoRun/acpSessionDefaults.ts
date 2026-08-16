import type { NewSessionResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpConnection } from "./acpConnection.js";
import type { AcpEngineSessionConfigurator } from "./acpExecutionEngineContracts.js";
import type { DesktopAcpSessionDefaults } from "./desktopAgentSettings.js";
import {
  sessionConfigurationFromProtocol,
  type AcpSessionConfiguration
} from "./acpSessionConfiguration.js";

type SessionDefaultsWriter = {
  setConfigOption(
    configId: string,
    value: string | boolean
  ): Promise<readonly SessionConfigOption[]>;
  setMode(modeId: string): Promise<void>;
};

async function applySessionDefaults(options: {
  agentId: string;
  defaults: DesktopAcpSessionDefaults;
  session: NewSessionResponse;
  writer: SessionDefaultsWriter;
}): Promise<AcpSessionConfiguration> {
  const defaults = options.defaults;
  let advertised: readonly SessionConfigOption[] = options.session.configOptions ?? [];
  let modes = options.session.modes;
  const configuredEntries = Object.entries(defaults.configOptions);
  for (const [configId, value] of configuredEntries) {
    const config = advertised.find((candidate) => candidate.id === configId);
    if (!config) {
      throw new Error(
        `ACP agent '${options.agentId}' did not advertise configured option '${configId}'.`
      );
    }
    if (config.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new Error(`ACP option '${configId}' requires a boolean value.`);
      }
      advertised = (await options.writer.setConfigOption(configId, value)) ?? [];
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`ACP option '${configId}' requires a selected value id.`);
    }
    const available = config.options.flatMap((candidate) =>
      "group" in candidate ? candidate.options : [candidate]
    );
    if (!available.some((candidate) => candidate.value === value)) {
      throw new Error(`ACP option '${configId}' did not advertise configured value '${value}'.`);
    }
    advertised = (await options.writer.setConfigOption(configId, value)) ?? [];
  }

  const configuredProtocolMode = advertised.some(
    (option) => option.category === "mode" && Object.hasOwn(defaults.configOptions, option.id)
  );
  if (defaults.modeId && !configuredProtocolMode) {
    if (!modes?.availableModes.some((mode) => mode.id === defaults.modeId)) {
      throw new Error(
        `ACP agent '${options.agentId}' did not advertise configured session mode '${defaults.modeId}'.`
      );
    }
    await options.writer.setMode(defaults.modeId);
    modes = { ...modes, currentModeId: defaults.modeId };
  }
  return sessionConfigurationFromProtocol({ modes, configOptions: advertised });
}

export function applyDesktopAcpSessionDefaults(options: {
  agentId: string;
  defaults: DesktopAcpSessionDefaults;
  connection: AcpConnection;
  session: NewSessionResponse;
  operation?: { signal?: AbortSignal; timeoutMs?: number };
}): Promise<AcpSessionConfiguration> {
  return applySessionDefaults({
    ...options,
    writer: {
      setConfigOption: async (configId, value) => {
        const response = await options.connection.setSessionConfigOption(
          typeof value === "boolean"
            ? { sessionId: options.session.sessionId, configId, type: "boolean", value }
            : { sessionId: options.session.sessionId, configId, value },
          options.operation
        );
        return response.configOptions;
      },
      setMode: async (modeId) => {
        await options.connection.setSessionMode(
          { sessionId: options.session.sessionId, modeId },
          options.operation
        );
      }
    }
  });
}

export function applyDesktopAcpSessionDefaultsWithConfigurator(options: {
  agentId: string;
  defaults: DesktopAcpSessionDefaults;
  configurator: AcpEngineSessionConfigurator;
  session: NewSessionResponse;
}): Promise<AcpSessionConfiguration> {
  return applySessionDefaults({
    ...options,
    writer: {
      setConfigOption: (configId, value) =>
        options.configurator.setConfigOption({ configId, value }),
      setMode: (modeId) => options.configurator.setMode(modeId)
    }
  });
}
