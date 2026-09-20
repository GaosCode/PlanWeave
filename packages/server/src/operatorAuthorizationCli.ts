import { access } from "node:fs/promises";
import { loadServerConfig, resolveServerConfigPath } from "./config.js";
import { centralSchemaVersion, latestCentralSchemaVersion } from "./migrations.js";
import { openServerDatabase } from "./sqlite.js";
import { OperatorManagementAuthorization } from "./identity/operatorManagementAuthorization.js";

/** Local filesystem authority is required; no expired bearer can mint a recovery code. */
export async function createOperatorRecoveryCode(
  args: readonly string[],
  env?: Readonly<Record<string, string | undefined>>
): Promise<{ operatorId: string; recoveryCode: string; expiresAt: string }> {
  const index = args.indexOf("--operator");
  const operatorId = args[index + 1];
  if (index < 0 || !operatorId || operatorId.startsWith("--")) throw new Error("server_cli_usage");
  const configArgs = [...args.slice(0, index), ...args.slice(index + 2)];
  const config = await loadServerConfig(resolveServerConfigPath(configArgs, env));
  await access(config.databasePath);
  const database = await openServerDatabase(config.databasePath, config.limits.busyTimeoutMs);
  try {
    // Recovery never upgrades a database underneath an older running Server.
    if (centralSchemaVersion(database) !== latestCentralSchemaVersion) {
      throw new Error("server_authorization_upgrade_required");
    }
    const service = new OperatorManagementAuthorization(
      database,
      config.operatorCredentials,
      config.operatorSessionTtlMs
    );
    return { operatorId, ...service.createRecoveryCode(operatorId) };
  } catch (error) {
    if (error instanceof Error && error.message === "operator_management_authority_unavailable") {
      throw new Error("server_management_authority_unavailable");
    }
    throw error;
  } finally {
    database.close();
  }
}
