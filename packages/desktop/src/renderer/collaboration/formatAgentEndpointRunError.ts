import type { createTranslator } from "../i18n";

type Translator = ReturnType<typeof createTranslator>;

function withPlaceholders(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template
  );
}

function matchPrefix(message: string, prefix: string): { rest: string } | null {
  if (!message.startsWith(prefix)) return null;
  return { rest: message.slice(prefix.length) };
}

/**
 * Humanize claim-bus / endpoint / remote run error codes for UI display.
 * Keeps the original code in the message for diagnostics.
 * Unknown messages pass through unchanged.
 */
export function formatAgentEndpointRunError(message: string, t: Translator): string {
  if (message === "claim_bus_cancelled") {
    return withPlaceholders(t("claimBusCancelledError"), { code: message });
  }

  if (message === "collaboration_runtime_status_unavailable") {
    return withPlaceholders(t("collaborationRuntimeStatusUnavailableError"), {
      code: message
    });
  }

  if (
    message === "collaboration_runtime_state_uninitialized" ||
    message === "collaboration_runtime_runtime_not_attached"
  ) {
    return withPlaceholders(t("collaborationRuntimePreparingEnvironmentError"), {
      code: message
    });
  }

  if (
    message === "content_out_of_sync" ||
    message === "collaboration_runtime_content_out_of_sync"
  ) {
    return `${t("collaborationRuntimeContentOutOfSync")} [${message}]`;
  }

  {
    const matched = matchPrefix(message, "claim_bus_blocked:");
    if (matched) {
      return withPlaceholders(t("claimBusBlockedError"), {
        reason: matched.rest || "unknown",
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "claim_bus_idle:");
    if (matched) {
      return withPlaceholders(t("claimBusIdleError"), {
        reason: matched.rest || "unknown",
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "claim_bus_route_missing:");
    if (matched) {
      return withPlaceholders(t("claimBusRouteMissingError"), {
        block: matched.rest || "unknown",
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "local_agent_unit_");
    if (matched) {
      const separator = matched.rest.indexOf(":");
      if (separator >= 0) {
        const phase = matched.rest.slice(0, separator);
        const block = matched.rest.slice(separator + 1);
        return withPlaceholders(t("localAgentUnitFailedError"), {
          phase,
          block: block || "unknown",
          code: message
        });
      }
    }
  }

  {
    const matched = matchPrefix(message, "local_agent_run_not_started:");
    if (matched) {
      return withPlaceholders(t("localAgentRunNotStartedError"), {
        block: matched.rest || "unknown",
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "agent_endpoint_preference_mismatch:");
    if (matched) {
      const separator = matched.rest.indexOf(":");
      const block = separator >= 0 ? matched.rest.slice(0, separator) : matched.rest;
      const detail = separator >= 0 ? matched.rest.slice(separator + 1) : "mismatch";
      return withPlaceholders(t("agentEndpointPreferenceMismatchError"), {
        block: block || "unknown",
        detail,
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "agent_endpoint_selection_missing:");
    if (matched) {
      return withPlaceholders(t("agentEndpointSelectionMissingError"), {
        block: matched.rest || "unknown",
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "agent_endpoint_unavailable:");
    if (matched) {
      const [block = "unknown", endpoint = "unknown", ...reasonParts] = matched.rest.split(":");
      return withPlaceholders(t("agentEndpointUnavailableError"), {
        block,
        endpoint,
        reason: reasonParts.join(":") || "unavailable",
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "agent_endpoint_unknown:");
    if (matched) {
      const parts = matched.rest.split(":");
      const block = parts[0] ?? "unknown";
      const endpoint = parts[2] ?? parts[parts.length - 1] ?? "unknown";
      return withPlaceholders(t("agentEndpointUnknownError"), {
        block,
        endpoint,
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "remote_agent_block_");
    if (matched) {
      const separator = matched.rest.indexOf(":");
      if (separator >= 0) {
        const state = matched.rest.slice(0, separator);
        const block = matched.rest.slice(separator + 1).split(":")[0] ?? "unknown";
        return withPlaceholders(t("remoteAgentBlockFailedError"), {
          state,
          block,
          code: message
        });
      }
    }
  }

  {
    const matched = matchPrefix(message, "collaboration_runtime_task_status_unavailable:");
    if (matched) {
      return withPlaceholders(t("collaborationRuntimeTaskStatusUnavailableError"), {
        task: matched.rest || "unknown",
        code: message
      });
    }
  }

  {
    const matched = matchPrefix(message, "collaboration_runtime_block_status_unavailable:");
    if (matched) {
      return withPlaceholders(t("collaborationRuntimeBlockStatusUnavailableError"), {
        block: matched.rest || "unknown",
        code: message
      });
    }
  }

  // Host failure shape: "<message> (<code>)"
  const hostFailure = /^(.*) \(([a-z][a-z0-9_]*)\)$/s.exec(message);
  if (hostFailure) {
    const detail = hostFailure[1]?.trim() ?? message;
    const code = hostFailure[2] ?? "remote_failure";
    return withPlaceholders(t("remoteAgentFailureError"), {
      message: detail,
      code
    });
  }

  return message;
}
