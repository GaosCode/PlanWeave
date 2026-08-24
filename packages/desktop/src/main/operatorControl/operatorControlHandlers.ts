import { app, BrowserWindow, clipboard, ipcMain, safeStorage } from "electron";
import { isAbsolute, resolve } from "node:path";
import {
  assertNoSmuggledOperatorSecrets,
  operatorControlInvokeChannels,
  operatorImportCredentialInputSchema,
  operatorControlStatusChangedChannel,
  type OperatorControlStatus,
  type PlanWeaveOperatorControlApi
} from "../../shared/operatorControl.js";
import {
  OperatorControlService,
  type OperatorControlServiceOptions
} from "./operatorControlService.js";
import {
  DesktopLocalAgentHostProvisioner,
  unavailableLocalAgentHostProvisioner
} from "./localAgentHostProvisioner.js";

let service: OperatorControlService | null = null;

const desktopAgentHostServiceFlag = "--agent-host-service";

export function resolveDesktopAgentHostLauncher(input: {
  executablePath: string;
  isPackaged: boolean;
  developmentNodeExecutablePath?: string;
  developmentAgentHostCliPath?: string;
  workingDirectory?: string;
}) {
  if (input.isPackaged) {
    return {
      executablePath: input.executablePath,
      fixedArgs: [desktopAgentHostServiceFlag]
    };
  }
  if (!input.developmentNodeExecutablePath || !input.developmentAgentHostCliPath) return null;
  const nodeExecutablePath = isAbsolute(input.developmentNodeExecutablePath)
    ? input.developmentNodeExecutablePath
    : resolve(input.workingDirectory ?? process.cwd(), input.developmentNodeExecutablePath);
  const agentHostCliPath = isAbsolute(input.developmentAgentHostCliPath)
    ? input.developmentAgentHostCliPath
    : resolve(input.workingDirectory ?? process.cwd(), input.developmentAgentHostCliPath);
  return {
    executablePath: nodeExecutablePath,
    fixedArgs: [agentHostCliPath]
  };
}

export type OperatorControlHandlerOptions = OperatorControlServiceOptions & {
  readOperatorToken?: () => string;
};

function publishStatusToRenderers(status: OperatorControlStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(operatorControlStatusChangedChannel, status);
    }
  }
}

function createDefaultService(options: OperatorControlServiceOptions = {}): OperatorControlService {
  const agentHostLauncher = resolveDesktopAgentHostLauncher({
    executablePath: process.execPath,
    isPackaged: app.isPackaged,
    developmentNodeExecutablePath: process.env.PLANWEAVE_DESKTOP_NODE_EXECUTABLE,
    developmentAgentHostCliPath: process.env.PLANWEAVE_DESKTOP_AGENT_HOST_CLI_PATH
  });
  return new OperatorControlService({
    ...options,
    safeStorage: options.safeStorage ?? {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    },
    localAgentHost:
      options.localAgentHost ??
      (agentHostLauncher
        ? new DesktopLocalAgentHostProvisioner({ launcher: agentHostLauncher })
        : unavailableLocalAgentHostProvisioner()),
    onStatusChange: options.onStatusChange ?? publishStatusToRenderers
  });
}

export function getOperatorControlService(): OperatorControlService {
  if (!service) service = createDefaultService();
  return service;
}

export function createOperatorControlService(
  options: OperatorControlServiceOptions = {}
): OperatorControlService {
  return createDefaultService(options);
}

export function setOperatorControlServiceForTests(next: OperatorControlService | null): void {
  service = next;
}

export function registerOperatorControlHandlers(
  options: OperatorControlHandlerOptions = {}
): OperatorControlService {
  const { readOperatorToken = () => clipboard.readText(), ...serviceOptions } = options;
  service = createDefaultService(serviceOptions);
  const active = service;
  ipcMain.handle(operatorControlInvokeChannels.getStatus, () => active.getStatus());
  ipcMain.handle(operatorControlInvokeChannels.upsertProfile, (_event, input: unknown) =>
    active.upsertProfile(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.removeProfile, (_event, input: unknown) =>
    active.removeProfile(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.setActiveProfile, (_event, input: unknown) =>
    active.setActiveProfile(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.clearActiveProfile, () =>
    active.clearActiveProfile()
  );
  ipcMain.handle(operatorControlInvokeChannels.importCredential, (_event, input: unknown) => {
    assertNoSmuggledOperatorSecrets(input, "importOperatorCredential");
    const parsed = operatorImportCredentialInputSchema.parse(input);
    return active.importCredential({
      ...parsed,
      operatorToken: readOperatorToken().trim()
    });
  });
  ipcMain.handle(operatorControlInvokeChannels.clearCredential, (_event, input: unknown) =>
    active.clearCredential(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.listHosts, (_event, input: unknown) =>
    active.listHosts(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.listAgentEndpoints, (_event, input: unknown) =>
    active.listAgentEndpoints(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.copyHostBootstrapHandoff, (_event, input: unknown) =>
    active.copyHostBootstrapHandoff(input, (content) => clipboard.writeText(content))
  );
  ipcMain.handle(operatorControlInvokeChannels.copyMemberSetupCode, (_event, input: unknown) =>
    active.copyMemberSetupCode(input, (content) => clipboard.writeText(content))
  );
  ipcMain.handle(operatorControlInvokeChannels.revokeHost, (_event, input: unknown) =>
    active.revokeHost(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.renewHostCredential, (_event, input: unknown) =>
    active.renewHostCredential(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.getLocalAgentHostStatus, (_event, input: unknown) =>
    active.getLocalAgentHostStatus(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.repairLocalAgentHost, (_event, input: unknown) =>
    active.repairLocalAgentHost(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.registerLocalAgentHost, (_event, input: unknown) =>
    active.registerLocalAgentHost(input)
  );
  ipcMain.handle(operatorControlInvokeChannels.enrollLocalAgentHost, (_event, input: unknown) =>
    active.enrollLocalAgentHost(input)
  );
  ipcMain.handle(
    operatorControlInvokeChannels.dispatchOwnerFleetRemoteOperation,
    (_event, input: unknown) => active.dispatchOwnerFleetRemoteOperation(input)
  );
  ipcMain.handle(
    operatorControlInvokeChannels.observeOwnerFleetRemoteOperation,
    (_event, input: unknown) => active.observeOwnerFleetRemoteOperation(input)
  );
  ipcMain.handle(
    operatorControlInvokeChannels.replayOwnerFleetRemoteOperationEvents,
    (_event, input: unknown) => active.replayOwnerFleetRemoteOperationEvents(input)
  );
  ipcMain.handle(
    operatorControlInvokeChannels.executeOwnerFleetRemoteOperationAction,
    (_event, input: unknown) => active.executeOwnerFleetRemoteOperationAction(input)
  );
  return active;
}

export async function shutdownOperatorControlService(): Promise<void> {
  if (!service) return;
  const active = service;
  service = null;
  await active.shutdown();
}

/** Preload-side shape is declared here only to keep the main registration auditable. */
export type OperatorControlBridgeApi = PlanWeaveOperatorControlApi;
