/**
 * SQL Explorer feature module: tree view, connection management commands,
 * table preview and export.
 *
 * @module sql-explorer
 */

import * as vscode from 'vscode';
import {
  CMD_SQL_ADD_CONNECTION,
  CMD_SQL_DELETE_CONNECTION,
  CMD_SQL_EDIT_CONNECTION,
  CMD_SQL_EXPORT_TABLE,
  CMD_SQL_OPEN_EXPLORER,
  CMD_SQL_PREVIEW_TABLE,
  CMD_SQL_REFRESH_EXPLORER,
  SQL_EXPLORER_VIEW_ID,
} from '../../constants';
import type { SqlServices } from '../../sql';
import { openConnectDialog } from './connectDialogPanel';
import { pickConnection } from './connectionWizard';
import { exportTableData, type ExportFormat } from './exportService';
import { openTablePreview, type PreviewTarget } from './previewPanel';
import { SqlExplorerTreeProvider, type SqlNode } from './treeProvider';

function nodeToTarget(node: SqlNode): PreviewTarget | undefined {
  if (!node?.connectionId || !node.database || !node.schema || !node.objectName) {
    return undefined;
  }
  return {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    objectName: node.objectName,
  };
}

export function registerSqlExplorer(
  context: vscode.ExtensionContext,
  services: SqlServices
): void {
  const provider = new SqlExplorerTreeProvider(services);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(SQL_EXPLORER_VIEW_ID, provider),
    services.connections.onProfilesChanged(() => provider.refresh()),

    vscode.commands.registerCommand(CMD_SQL_OPEN_EXPLORER, async () => {
      // Reveal the SQL Explorer sidebar view (also restores it if previously hidden).
      await vscode.commands.executeCommand(`${SQL_EXPLORER_VIEW_ID}.focus`);
    }),

    vscode.commands.registerCommand(CMD_SQL_ADD_CONNECTION, async () => {
      await openConnectDialog(context, services.connections, undefined, {
        logger: (message) => services.output.appendLine(`[${new Date().toISOString()}] ${message}`),
        showLog: () => services.output.show(true),
      });
    }),

    vscode.commands.registerCommand(CMD_SQL_EDIT_CONNECTION, async (node?: SqlNode) => {
      const profile = node?.connectionId
        ? services.connections.getProfile(node.connectionId)
        : await pickConnection(services.connections, 'Edit SQL Connection');
      if (profile) {
        await openConnectDialog(context, services.connections, profile, {
          logger: (message) =>
            services.output.appendLine(`[${new Date().toISOString()}] ${message}`),
          showLog: () => services.output.show(true),
        });
      }
    }),

    vscode.commands.registerCommand(CMD_SQL_DELETE_CONNECTION, async (node?: SqlNode) => {
      const profile = node?.connectionId
        ? services.connections.getProfile(node.connectionId)
        : await pickConnection(services.connections, 'Delete SQL Connection');
      if (!profile) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Delete SQL connection "${profile.name}"?`,
        { modal: true },
        'Delete'
      );
      if (confirmed === 'Delete') {
        await services.connections.deleteProfile(profile.id);
        services.scanner.invalidate(profile.id);
      }
    }),

    vscode.commands.registerCommand(CMD_SQL_REFRESH_EXPLORER, () => {
      for (const profile of services.connections.getProfiles()) {
        services.scanner.invalidate(profile.id);
      }
      provider.refresh();
    }),

    vscode.commands.registerCommand(CMD_SQL_PREVIEW_TABLE, async (node?: SqlNode) => {
      const target = node ? nodeToTarget(node) : undefined;
      if (!target) {
        return;
      }
      await openTablePreview(context, services, target);
    }),

    vscode.commands.registerCommand(CMD_SQL_EXPORT_TABLE, async (node?: SqlNode) => {
      const target = node ? nodeToTarget(node) : undefined;
      if (!target) {
        return;
      }
      const formatPick = await vscode.window.showQuickPick(
        [
          { label: 'CSV', format: 'csv' as ExportFormat },
          { label: 'Excel (.xlsx)', format: 'xlsx' as ExportFormat },
          { label: 'JSON', format: 'json' as ExportFormat },
        ],
        { title: `Export ${target.objectName}` }
      );
      if (!formatPick) {
        return;
      }
      try {
        const table = await services.scanner.scanTable(
          target.connectionId,
          target.database,
          target.schema,
          target.objectName
        );
        if (!table) {
          vscode.window.showErrorMessage(`Table metadata not found for ${target.objectName}.`);
          return;
        }
        await exportTableData(services, target, table, formatPick.format, '', []);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Export failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );
}
