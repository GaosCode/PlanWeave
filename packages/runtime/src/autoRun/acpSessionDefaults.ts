import type { NewSessionResponse } from "@agentclientprotocol/sdk";
import type { AgentFamily } from "../types.js";
import type { AcpConnection } from "./acpConnection.js";
import type { DesktopAcpSessionDefaults } from "./desktopAgentSettings.js";
import {
  sessionConfigurationFromProtocol,
  type AcpSessionConfiguration
} from "./acpSessionConfiguration.js";

export async function applyDesktopAcpSessionDefaults(options: {
  agentId: AgentFamily;
  defaults: DesktopAcpSessionDefaults;
  connection: AcpConnection;
  session: NewSessionResponse;
  operation?: { signal?: AbortSignal; timeoutMs?: number };
}): Promise<AcpSessionConfiguration> {
  const defaults = options.defaults;
  let advertised = options.session.configOptions ?? [];
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
      const response = await options.connection.setSessionConfigOption(
        { sessionId: options.session.sessionId, configId, type: "boolean", value },
        options.operation
      );
      advertised = response.configOptions;
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
    const response = await options.connection.setSessionConfigOption(
      { sessionId: options.session.sessionId, configId, value },
      options.operation
    );
    advertised = response.configOptions;
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
    await options.connection.setSessionMode(
      { sessionId: options.session.sessionId, modeId: defaults.modeId },
      options.operation
    );
    modes = { ...modes, currentModeId: defaults.modeId };
  }
  return sessionConfigurationFromProtocol({ modes, configOptions: advertised });
}
