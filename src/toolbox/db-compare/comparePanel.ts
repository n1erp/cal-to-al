/**
 * Database comparison dashboard webview: loads the persisted comparison
 * report from `.cal2al/database-comparison.json` (same pattern as the
 * Migration Dashboard).
 *
 * @module db-compare/comparePanel
 */

import * as vscode from 'vscode';
import { AssetPaths } from '../../assetPaths';
import { CMD_SQL_CREATE_COMPARISON } from '../../constants';
import type { SqlServices } from '../../sql';
import type { DatabaseMetadata } from '../../sql/types';
import { comparisonFilePath } from '../migration/artifacts';
import { pickDatabase } from '../sql-explorer/connectionWizard';
import { buildWebviewHtml } from '../webviewHtml';
import { compareDatabases } from './comparisonEngine';
import type { ComparisonStore } from './comparisonStore';

let panel: vscode.WebviewPanel | undefined;

export function openComparisonDashboard(
  context: vscode.ExtensionContext,
  services: SqlServices,
  store: ComparisonStore
): void {
  if (panel) {
    panel.reveal(undefined, false);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'calToAl.dbCompare',
    'Database Comparison',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, ...AssetPaths.dbCompare.folder.split('/')),
      ],
    }
  );
  panel.iconPath = new vscode.ThemeIcon('compare-changes');
  panel.webview.html = buildWebviewHtml(
    panel.webview,
    context.extensionUri,
    AssetPaths.dbCompare,
    'Database Comparison'
  );

  const currentPanel = panel;
  const post = (message: unknown) => void currentPanel.webview.postMessage(message);

  const sendReport = () => {
    post({
      command: 'report',
      data: {
        report: store.getReport() ?? null,
        reportPath: safeComparisonPath(),
      },
    });
  };

  const storeSub = store.onDidChange(() => sendReport());

  currentPanel.onDidDispose(() => {
    storeSub.dispose();
    panel = undefined;
  });

  currentPanel.webview.onDidReceiveMessage(async (raw: { command: string }) => {
    switch (raw?.command) {
      case 'ready':
        sendReport();
        break;
      case 'refresh':
        await store.load();
        break;
      case 'saveReport':
        try {
          await store.save();
          vscode.window.showInformationMessage(
            `Comparison saved to ${safeComparisonPath()}`
          );
        } catch (err) {
          vscode.window.showErrorMessage(
            `Could not save comparison: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        break;
      case 'openReportFile':
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(comparisonFilePath()));
        } catch {
          vscode.window.showWarningMessage('Database comparison file not found.');
        }
        break;
      case 'openLogs':
        services.output.show(true);
        break;
      case 'openMigrationDashboard':
        await vscode.commands.executeCommand('calToAl.sql.openMigrationDashboard');
        break;
      default:
        break;
    }
  });
}

function safeComparisonPath(): string {
  try {
    return comparisonFilePath();
  } catch {
    return '';
  }
}

/** Pick databases, scan, compare, persist, and open the dashboard. */
export async function createDatabaseComparison(
  context: vscode.ExtensionContext,
  services: SqlServices,
  store: ComparisonStore
): Promise<void> {
  const sourceRef = await pickDatabase(services.connections, services.runner, 'Source database');
  if (!sourceRef) {
    return;
  }
  const destinationRef = await pickDatabase(
    services.connections,
    services.runner,
    'Destination database'
  );
  if (!destinationRef) {
    return;
  }

  let source: DatabaseMetadata;
  let destination: DatabaseMetadata;
  try {
    [source, destination] = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Scanning databases for comparison…',
      },
      () =>
        Promise.all([
          services.scanner.scan(sourceRef.connectionId, sourceRef.database),
          services.scanner.scan(destinationRef.connectionId, destinationRef.database),
        ])
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Database comparison failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const report = compareDatabases(source, destination);
  await store.saveFromReport(report);

  services.output.appendLine(
    `[compare] ${source.database} vs ${destination.database}: ` +
      `${report.matched.length} matched, ${report.missingInDestination.length} tables added, ` +
      `${report.missingInSource.length} added in destination`
  );
  services.output.appendLine(`[compare] Saved to ${safeComparisonPath()}`);

  vscode.window.showInformationMessage(
    `Database comparison saved (${report.matched.length} matched tables).`
  );
  openComparisonDashboard(context, services, store);
}

export function registerComparisonDashboardCommands(
  context: vscode.ExtensionContext,
  services: SqlServices,
  store: ComparisonStore,
  openCommand: string
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(openCommand, async () => {
      if (!store.getReport()) {
        await store.load();
      }
      if (!store.getReport()) {
        await createDatabaseComparison(context, services, store);
        return;
      }
      openComparisonDashboard(context, services, store);
    }),
    vscode.commands.registerCommand(CMD_SQL_CREATE_COMPARISON, () =>
      createDatabaseComparison(context, services, store)
    )
  );
}
