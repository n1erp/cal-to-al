/**
 * SSMS-style Connect to Server webview: credentials form, instance discovery,
 * authentication selection, and save via ConnectionManager.
 *
 * @module sql-explorer/connectDialogPanel
 */

import * as vscode from 'vscode';
import { AssetPaths, extensionAssetUri } from '../../assetPaths';
import { ConnectionManager } from '../../sql/connectionManager';
import { discoverSqlInstances, type DiscoveredInstance } from '../../sql/instanceDiscovery';
import type { ConnectionProfile, SqlAuthMode } from '../../sql/types';
import { buildConnectHtml } from './connectHtml';

export type ConnectDialogLogger = (message: string) => void;

interface ConnectFormData {
  name: string;
  server: string;
  port?: number;
  authMode: SqlAuthMode;
  username: string;
  domain?: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  password: string;
}

let panel: vscode.WebviewPanel | undefined;
/** Profile being edited (undefined = new connection). Updated when the panel is reused. */
let editingProfile: ConnectionProfile | undefined;

function recentServers(connections: ConnectionManager): string[] {
  return connections
    .getProfiles()
    .map((p) => (p.port ? `${p.server.split('\\')[0]},${p.port}` : p.server));
}

async function loadInstances(connections: ConnectionManager): Promise<DiscoveredInstance[]> {
  return discoverSqlInstances(recentServers(connections));
}

function toProfile(data: ConnectFormData, existing?: ConnectionProfile): ConnectionProfile {
  return {
    id: existing?.id ?? ConnectionManager.newProfileId(),
    name: data.name.trim(),
    server: data.server.trim(),
    port: data.port,
    authMode: data.authMode === 'ntlm' ? 'ntlm' : 'sql',
    username: data.username.trim(),
    domain: data.domain?.trim() || undefined,
    encrypt: Boolean(data.encrypt),
    trustServerCertificate: Boolean(data.trustServerCertificate),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open (or reveal) the Connect to Server dialog.
 * Reuses a single panel so add/edit do not stack multiple dialogs.
 */
export async function openConnectDialog(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  existing?: ConnectionProfile,
  options?: { logger?: ConnectDialogLogger; showLog?: () => void }
): Promise<void> {
  const logger = options?.logger;
  const showLog = options?.showLog;
  editingProfile = existing;

  if (panel) {
    panel.reveal(vscode.ViewColumn.Active, false);
    panel.title = existing ? `Edit Connection — ${existing.name}` : 'Connect to Server';
    await sendInit(panel, connections, existing);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'calToAl.sqlConnect',
    existing ? `Edit Connection — ${existing.name}` : 'Connect to Server',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        extensionAssetUri(context.extensionUri, AssetPaths.sqlConnect.folder),
        extensionAssetUri(context.extensionUri, AssetPaths.icons.folder),
      ],
    }
  );
  panel.iconPath = new vscode.ThemeIcon('server-environment');
  panel.webview.html = buildConnectHtml(panel.webview, context.extensionUri);

  const current = panel;
  current.onDidDispose(() => {
    if (panel === current) {
      panel = undefined;
      editingProfile = undefined;
    }
  });

  current.webview.onDidReceiveMessage(async (raw: { command?: string; data?: unknown }) => {
    if (!panel || panel !== current) {
      return;
    }
    switch (raw?.command) {
      case 'ready':
        await sendInit(current, connections, editingProfile);
        break;
      case 'discoverInstances':
        await refreshInstances(current, connections);
        break;
      case 'connect':
        await handleConnect(
          current,
          connections,
          editingProfile,
          raw.data as ConnectFormData,
          logger,
          showLog
        );
        break;
      case 'cancel':
        current.dispose();
        break;
      default:
        break;
    }
  });
}

async function sendInit(
  target: vscode.WebviewPanel,
  connections: ConnectionManager,
  existing?: ConnectionProfile
): Promise<void> {
  const post = (message: unknown) => void target.webview.postMessage(message);
  post({
    command: 'status',
    data: { message: 'Looking for SQL Server instances…', kind: 'busy' },
  });

  let instances: DiscoveredInstance[] = [];
  let discoverError: string | undefined;
  try {
    instances = await loadInstances(connections);
  } catch (err) {
    discoverError = `Could not discover instances: ${errText(err)}. Type the server name manually.`;
  }

  post({
    command: 'init',
    data: {
      existing: existing
        ? {
            name: existing.name,
            server: existing.server,
            port: existing.port,
            authMode: existing.authMode,
            username: existing.username,
            domain: existing.domain,
            encrypt: existing.encrypt,
            trustServerCertificate: existing.trustServerCertificate,
          }
        : null,
      instances,
    },
  });

  if (discoverError) {
    post({ command: 'instances', data: { instances, error: discoverError } });
  }
}

async function refreshInstances(
  target: vscode.WebviewPanel,
  connections: ConnectionManager
): Promise<void> {
  try {
    const instances = await loadInstances(connections);
    target.webview.postMessage({ command: 'instances', data: { instances } });
  } catch (err) {
    target.webview.postMessage({
      command: 'instances',
      data: {
        instances: [],
        error: `Could not discover instances: ${errText(err)}`,
      },
    });
  }
}

async function handleConnect(
  target: vscode.WebviewPanel,
  connections: ConnectionManager,
  existing: ConnectionProfile | undefined,
  data: ConnectFormData,
  logger: ConnectDialogLogger | undefined,
  showLog: (() => void) | undefined
): Promise<void> {
  const post = (message: unknown) => void target.webview.postMessage(message);

  if (!data?.server?.trim() || !data?.username?.trim()) {
    post({
      command: 'connectResult',
      data: { ok: false, message: 'Server name and login are required.' },
    });
    return;
  }

  const profile = toProfile(data, existing);
  const passwordInput = data.password ?? '';
  const storedPassword = existing ? ((await connections.getPassword(existing.id)) ?? '') : '';
  const effectivePassword = passwordInput !== '' ? passwordInput : storedPassword;

  if (!effectivePassword && profile.authMode === 'sql') {
    logger?.('[connect-dialog] Warning: password is empty.');
  }

  try {
    await ConnectionManager.testConnection(profile, effectivePassword, (message) =>
      logger?.(message)
    );
  } catch (err) {
    const message = errText(err);
    logger?.(`[connect-dialog] Connection test failed for "${profile.name}": ${message}`);
    const buttons = showLog ? ['Open Log', 'Save Anyway', 'Cancel'] : ['Save Anyway', 'Cancel'];
    const choice = await vscode.window.showWarningMessage(
      `Connection test failed: ${message.split('\n')[0]}`,
      { modal: false, detail: message },
      ...buttons
    );
    if (choice === 'Open Log') {
      showLog?.();
      post({ command: 'connectResult', data: { ok: false, message } });
      return;
    }
    if (choice !== 'Save Anyway') {
      post({ command: 'connectResult', data: { ok: false, message } });
      return;
    }
  }

  // Persist password when typed; otherwise keep existing secret (undefined = no change).
  const passwordToStore =
    passwordInput !== '' ? passwordInput : existing ? undefined : effectivePassword || undefined;
  await connections.saveProfile(profile, passwordToStore);

  logger?.(`[connect-dialog] Saved connection "${profile.name}".`);
  post({
    command: 'connectResult',
    data: { ok: true, message: `Connected. Saved "${profile.name}".` },
  });
  void vscode.window.showInformationMessage(`Connection "${profile.name}" saved.`);
  target.dispose();
}
