/**
 * QuickInput flows for adding / editing SQL connection profiles, plus shared
 * pickers for choosing a connection and database.
 *
 * @module sql-explorer/connectionWizard
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../../sql/connectionManager';
import type { QueryRunner } from '../../sql/queryRunner';
import type { ConnectionProfile, DatabaseRef, SqlAuthMode } from '../../sql/types';

export type WizardLogger = (message: string) => void;

/** Multi-step input flow to create or edit a connection profile. */
export async function runConnectionWizard(
  connections: ConnectionManager,
  existing?: ConnectionProfile,
  options?: { logger?: WizardLogger; showLog?: () => void }
): Promise<void> {
  const log = options?.logger ?? (() => undefined);
  const showLog = options?.showLog;

  const name = await vscode.window.showInputBox({
    title: existing ? `Edit Connection: ${existing.name}` : 'New SQL Connection — Name',
    prompt: 'Display name for this connection',
    value: existing?.name ?? '',
    validateInput: (v) => (v.trim() ? undefined : 'Name is required'),
  });
  if (name === undefined) {
    return;
  }

  const server = await vscode.window.showInputBox({
    title: 'SQL Connection — Server',
    prompt:
      'Host, host\\instance, or host,port. For named instances prefer host,port (e.g. DESKTOP-S4EOQ9N,49201) to avoid SQL Browser timeouts.',
    value: existing
      ? existing.port
        ? `${existing.server.split('\\')[0]},${existing.port}`
        : existing.server
      : 'localhost',
    validateInput: (v) => (v.trim() ? undefined : 'Server is required'),
  });
  if (server === undefined) {
    return;
  }

  let port: number | undefined = existing?.port;
  let serverName = server.trim();
  const commaIdx = serverName.indexOf(',');
  if (commaIdx >= 0) {
    port = Number(serverName.slice(commaIdx + 1).trim()) || undefined;
    serverName = serverName.slice(0, commaIdx).trim();
  }

  // Named instances need either SQL Browser (UDP 1434) or an explicit TCP port.
  // Browser lookups frequently time out behind Windows Firewall, so ask for the port.
  if (serverName.includes('\\') && !port) {
    const portInput = await vscode.window.showInputBox({
      title: 'SQL Connection — TCP Port (recommended for named instances)',
      prompt:
        'Enter the instance TCP port from SQL Server Configuration Manager → TCP/IP → IPAll. Leave empty to try SQL Browser (often times out).',
      value: existing?.port ? String(existing.port) : '',
      placeHolder: 'e.g. 1433 or 49201',
      validateInput: (v) => {
        if (!v.trim()) {
          return undefined;
        }
        const n = Number(v.trim());
        return Number.isInteger(n) && n > 0 && n < 65536
          ? undefined
          : 'Enter a port number between 1 and 65535, or leave empty';
      },
    });
    if (portInput === undefined) {
      return;
    }
    if (portInput.trim()) {
      port = Number(portInput.trim());
    }
  } else if (!serverName.includes('\\') && !commaIdx && existing?.port && !port) {
    port = existing.port;
  }

  const authItems = [
    {
      label: 'SQL Server Authentication',
      description: 'Login name and password',
      mode: 'sql' as SqlAuthMode,
    },
    {
      label: 'Windows Authentication (NTLM)',
      description: 'Domain + user + password (SSO not supported)',
      mode: 'ntlm' as SqlAuthMode,
    },
  ];
  const authPick = await vscode.window.showQuickPick(authItems, {
    title: 'SQL Connection — Authentication',
    placeHolder: existing
      ? `Current: ${existing.authMode === 'ntlm' ? 'Windows' : 'SQL'}`
      : undefined,
  });
  if (!authPick) {
    return;
  }

  let domain: string | undefined;
  if (authPick.mode === 'ntlm') {
    domain = await vscode.window.showInputBox({
      title: 'SQL Connection — Windows Domain',
      prompt: 'Windows domain (leave empty if username is DOMAIN\\user, or for local accounts)',
      value: existing?.domain ?? '',
    });
    if (domain === undefined) {
      return;
    }
  }

  const username = await vscode.window.showInputBox({
    title: 'SQL Connection — User Name',
    prompt:
      authPick.mode === 'ntlm'
        ? 'Windows user name (or DOMAIN\\user)'
        : 'SQL login name (e.g. sa)',
    value: existing?.username ?? '',
    validateInput: (v) => (v.trim() ? undefined : 'User name is required'),
  });
  if (username === undefined) {
    return;
  }

  const password = await vscode.window.showInputBox({
    title: 'SQL Connection — Password',
    prompt: existing ? 'Leave empty to keep the stored password' : 'Password',
    password: true,
  });
  if (password === undefined) {
    return;
  }

  const securityPick = await vscode.window.showQuickPick(
    [
      {
        label: 'On-premises (recommended)',
        description: 'Encrypt + trust server certificate',
        encrypt: true,
        trust: true,
      },
      {
        label: 'Encrypt, validate certificate',
        description: 'Typical for Azure SQL',
        encrypt: true,
        trust: false,
      },
      {
        label: 'No encryption',
        description: 'Legacy SQL Server only',
        encrypt: false,
        trust: true,
      },
    ],
    { title: 'SQL Connection — Encryption' }
  );
  if (!securityPick) {
    return;
  }

  const profile: ConnectionProfile = {
    id: existing?.id ?? ConnectionManager.newProfileId(),
    name: name.trim(),
    server: serverName,
    port,
    authMode: authPick.mode,
    username: username.trim(),
    domain: domain?.trim() || undefined,
    encrypt: securityPick.encrypt,
    trustServerCertificate: securityPick.trust,
  };

  const effectivePassword =
    password !== '' ? password : ((existing && (await connections.getPassword(existing.id))) ?? '');

  if (!effectivePassword && authPick.mode === 'sql') {
    log('[test] Warning: password is empty.');
  }

  // Test before saving so the user gets immediate feedback.
  const tested = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Testing connection to ${profile.server}…`,
    },
    async () => {
      try {
        await ConnectionManager.testConnection(profile, effectivePassword, log);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[wizard] Connection test failed for "${profile.name}": ${message}`);
        const buttons = showLog ? ['Open Log', 'Save Anyway', 'Cancel'] : ['Save Anyway', 'Cancel'];
        const choice = await vscode.window.showWarningMessage(
          `Connection test failed: ${message.split('\n')[0]}`,
          { modal: false, detail: message },
          ...buttons
        );
        if (choice === 'Open Log') {
          showLog?.();
          return false;
        }
        return choice === 'Save Anyway';
      }
    }
  );
  if (!tested) {
    return;
  }

  await connections.saveProfile(profile, password !== '' ? password : undefined);
  log(`[wizard] Saved connection "${profile.name}".`);
  vscode.window.showInformationMessage(`Connection "${profile.name}" saved.`);
}

/** Pick one saved connection profile. */
export async function pickConnection(
  connections: ConnectionManager,
  title: string
): Promise<ConnectionProfile | undefined> {
  const profiles = connections.getProfiles();
  if (profiles.length === 0) {
    vscode.window.showWarningMessage('No SQL connections saved. Add one in the SQL Explorer first.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    profiles.map((p) => ({ label: p.name, description: p.server, profile: p })),
    { title }
  );
  return pick?.profile;
}

/** Pick a connection, then one of its databases. */
export async function pickDatabase(
  connections: ConnectionManager,
  runner: QueryRunner,
  title: string
): Promise<DatabaseRef | undefined> {
  const profile = await pickConnection(connections, title);
  if (!profile) {
    return undefined;
  }
  try {
    const databases = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Listing databases on ${profile.server}…`,
      },
      () => runner.listDatabases(profile.id)
    );
    const db = await vscode.window.showQuickPick(databases, {
      title: `${title} — database on ${profile.name}`,
    });
    if (!db) {
      return undefined;
    }
    return { connectionId: profile.id, database: db };
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not list databases: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}
