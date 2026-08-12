/**
 * Migration Dashboard webview panel: live data grid over the migration plan
 * with execution actions, progress, SQL preview, field-mapping overrides,
 * and report export.
 *
 * @module migration/dashboardPanel
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { AssetPaths, extensionAssetUri } from '../../assetPaths';
import { CMD_SQL_CREATE_COMPARISON } from '../../constants';
import type { SqlServices } from '../../sql';
import { buildWebviewHtml } from '../webviewHtml';
import type { ComparisonStore } from '../db-compare/comparisonStore';
import { comparisonFilePath, planFilePath } from './artifacts';
import type { ExecutionEngine } from './executionEngine';
import { generateQuery } from './queryGenerator';
import type { PlanEntry, PlanStore } from './planStore';

interface MappingPatch {
  entryId: string;
  fields: { sourceColumn: string; destinationColumn: string; included: boolean }[];
}

let panel: vscode.WebviewPanel | undefined;

export function openMigrationDashboard(
  context: vscode.ExtensionContext,
  services: SqlServices,
  planStore: PlanStore,
  engine: ExecutionEngine,
  comparisonStore: ComparisonStore,
  createPlanFromComparison?: () => Promise<boolean>
): void {
  if (panel) {
    panel.reveal(undefined, false);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'calToAl.migrationDashboard',
    'Migration Dashboard',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        extensionAssetUri(context.extensionUri, AssetPaths.migrationDashboard.folder),
        extensionAssetUri(context.extensionUri, AssetPaths.icons.folder),
      ],
    }
  );
  panel.iconPath = new vscode.ThemeIcon('rocket');
  panel.webview.html = buildWebviewHtml(
    panel.webview,
    context.extensionUri,
    AssetPaths.migrationDashboard,
    'Migration Dashboard'
  );

  const currentPanel = panel;
  const post = (message: unknown) => void currentPanel.webview.postMessage(message);

  const sendPlan = () => {
    const plan = planStore.getPlan();
    const mappingSet = planStore.getMappingSet();
    const comparison = comparisonStore.getReport();
    const comparisonComparedAt = comparison?.comparedAt ?? null;
    post({
      command: 'plan',
      data: {
        plan: plan ?? null,
        mappings: mappingSet
          ? Object.fromEntries(mappingSet.mappings.map((m) => [m.id, m]))
          : {},
        planPath: safePlanPath(),
        workflow: {
          comparisonExists: Boolean(comparison),
          comparisonComparedAt,
          comparisonPath: safeComparisonPath(),
          comparisonMatchedTables: comparison?.matched.length ?? 0,
          planLinkedToComparison:
            Boolean(plan?.comparisonComparedAt) &&
            Boolean(comparisonComparedAt) &&
            plan!.comparisonComparedAt === comparisonComparedAt,
          comparisonStale:
            Boolean(plan?.comparisonComparedAt) &&
            Boolean(comparisonComparedAt) &&
            plan!.comparisonComparedAt !== comparisonComparedAt,
        },
      },
    });
  };

  const planSub = planStore.onDidChange(() => sendPlan());
  const comparisonSub = comparisonStore.onDidChange(() => sendPlan());
  const stateSub = engine.onDidChangeState((state) => post({ command: 'runState', data: state }));

  currentPanel.onDidDispose(() => {
    planSub.dispose();
    comparisonSub.dispose();
    stateSub.dispose();
    panel = undefined;
  });

  currentPanel.webview.onDidReceiveMessage(
    async (raw: { command: string; data?: unknown }) => {
      switch (raw?.command) {
        case 'ready':
          sendPlan();
          post({ command: 'runState', data: engine.getState() });
          break;
        case 'execute': {
          const ids = (raw.data as { ids: string[] })?.ids ?? [];
          const confirmed = await confirmExecuteIfNeeded(planStore, ids);
          if (confirmed) {
            void engine.executeEntries(confirmed, { resume: false, allowIncomplete: true });
          }
          break;
        }
        case 'executeOne': {
          const id = (raw.data as { id: string })?.id;
          if (!id) {
            break;
          }
          const confirmed = await confirmExecuteIfNeeded(planStore, [id]);
          if (confirmed) {
            void engine.executeEntries(confirmed, { resume: false, allowIncomplete: true });
          }
          break;
        }
        case 'executeAll': {
          const plan = planStore.getPlan();
          if (plan) {
            const ids = plan.entries.map((e) => e.id);
            const confirmed = await confirmExecuteIfNeeded(planStore, ids);
            if (confirmed) {
              void engine.executeEntries(confirmed, { resume: true, allowIncomplete: true });
            }
          }
          break;
        }
        case 'retryFailed': {
          const plan = planStore.getPlan();
          if (plan) {
            const failed = plan.entries.filter((e) => e.status === 'Failed').map((e) => e.id);
            const confirmed = await confirmExecuteIfNeeded(planStore, failed);
            if (confirmed) {
              void engine.executeEntries(confirmed, { isRetry: true, allowIncomplete: true });
            }
          }
          break;
        }
        case 'stop':
          engine.stop();
          break;
        case 'refresh':
          await planStore.load();
          await comparisonStore.load();
          break;
        case 'savePlan':
          try {
            await planStore.save();
            vscode.window.showInformationMessage(`Migration plan saved to ${safePlanPath()}`);
          } catch (err) {
            vscode.window.showErrorMessage(
              `Could not save plan: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          break;
        case 'exportReport':
          await exportReport(planStore);
          break;
        case 'openLogs':
          services.output.show(true);
          break;
        case 'openPlanFile':
          try {
            await vscode.window.showTextDocument(vscode.Uri.file(planFilePath()));
          } catch {
            vscode.window.showWarningMessage('Migration plan file not found.');
          }
          break;
        case 'updateMapping':
          await applyMappingPatch(services, planStore, raw.data as MappingPatch);
          break;
        case 'createPlanFromComparison':
          if (createPlanFromComparison) {
            await createPlanFromComparison();
          }
          break;
        case 'openComparisonDashboard':
          await vscode.commands.executeCommand('calToAl.sql.compareDatabases');
          break;
        case 'createDatabaseComparison':
          await vscode.commands.executeCommand(CMD_SQL_CREATE_COMPARISON);
          break;
        default:
          break;
      }
    }
  );
}

function safePlanPath(): string {
  try {
    return planFilePath();
  } catch {
    return '';
  }
}

function safeComparisonPath(): string {
  try {
    return comparisonFilePath();
  } catch {
    return '';
  }
}

/** Warn when selected tables have comparison/mapping gaps; user may still execute. */
async function confirmExecuteIfNeeded(
  planStore: PlanStore,
  ids: string[]
): Promise<string[] | null> {
  const entries = ids
    .map((id) => planStore.getEntry(id))
    .filter((e): e is PlanEntry => Boolean(e));
  if (entries.length === 0) {
    return null;
  }
  const risky = entries.filter((e) => !e.mapping_complete);
  if (risky.length === 0) {
    return ids;
  }
  const sample = risky
    .slice(0, 4)
    .map((e) => `${e.table_trgt} (${e.field_diff_count} field diff(s))`)
    .join('; ');
  const pick = await vscode.window.showWarningMessage(
    `${risky.length} of ${entries.length} selected table(s) are not fully aligned with the destination schema` +
      (sample ? `: ${sample}${risky.length > 4 ? '…' : ''}` : '.') +
      ' Generated INSERT queries may be incomplete. Execute anyway?',
    { modal: true },
    'Execute Anyway',
    'Cancel'
  );
  return pick === 'Execute Anyway' ? ids : null;
}

/** Apply include/exclude overrides from the dashboard and regenerate the SQL. */
async function applyMappingPatch(
  services: SqlServices,
  planStore: PlanStore,
  patch: MappingPatch
): Promise<void> {
  const mappingSet = planStore.getMappingSet();
  const entry = planStore.getEntry(patch?.entryId ?? '');
  if (!mappingSet || !entry) {
    return;
  }
  const mapping = mappingSet.mappings.find((m) => m.id === entry.mapping_id);
  if (!mapping) {
    return;
  }

  const wanted = new Map(
    patch.fields.map((f) => [`${f.sourceColumn}→${f.destinationColumn}`, f.included])
  );
  for (const pair of mapping.fields) {
    const key = `${pair.sourceColumn}→${pair.destinationColumn}`;
    if (wanted.has(key)) {
      pair.included = wanted.get(key)!;
    }
  }

  await planStore.updateMappings(mappingSet);

  try {
    // Cached destination metadata (when available) keeps identity handling intact.
    const destinationMeta = services.scanner.getCached(
      mappingSet.destination.connectionId,
      mappingSet.destination.database
    );
    const query = generateQuery(
      mapping,
      mappingSet.source.database,
      mappingSet.destination.database,
      destinationMeta
    );
    await planStore.updateEntry(entry.id, {
      query: query.sql,
      status: entry.executed ? entry.status : 'Pending',
      error_code: null,
      error_message: null,
      mapping_complete:
        entry.field_diff_count === 0 && mapping.unmappedDestinationColumns.length === 0,
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not regenerate query: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Export an HTML or CSV execution report next to the user's chosen path. */
async function exportReport(planStore: PlanStore): Promise<void> {
  const plan = planStore.getPlan();
  if (!plan) {
    vscode.window.showWarningMessage('No migration plan loaded.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'HTML report', ext: 'html' },
      { label: 'CSV summary', ext: 'csv' },
    ],
    { title: 'Export Execution Report' }
  );
  if (!pick) {
    return;
  }
  const destination = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`migration-report.${pick.ext}`),
    filters: pick.ext === 'html' ? { HTML: ['html'] } : { CSV: ['csv'] },
  });
  if (!destination) {
    return;
  }

  const content = pick.ext === 'html' ? buildHtmlReport(planStore) : buildCsvReport(planStore);
  await fs.promises.writeFile(destination.fsPath, content, 'utf8');
  const open = await vscode.window.showInformationMessage(
    `Report exported to ${destination.fsPath}`,
    'Open'
  );
  if (open === 'Open') {
    await vscode.env.openExternal(destination);
  }
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildCsvReport(planStore: PlanStore): string {
  const plan = planStore.getPlan()!;
  const header =
    'Status,Source Table,Destination Table,Estimated Rows,Executed Rows,Duration (ms),Retry Count,Error';
  const lines = plan.entries.map((e) =>
    [
      e.status,
      e.table_src,
      e.table_trgt,
      String(e.rows),
      e.executed_rows === null ? '' : String(e.executed_rows),
      e.duration_ms === null ? '' : String(e.duration_ms),
      String(e.retry_count),
      e.error_message ?? '',
    ]
      .map(csvEscape)
      .join(',')
  );
  return '\uFEFF' + [header, ...lines].join('\r\n') + '\r\n';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtmlReport(planStore: PlanStore): string {
  const plan = planStore.getPlan()!;
  const completed = plan.entries.filter((e) => e.status === 'Completed').length;
  const failed = plan.entries.filter((e) => e.status === 'Failed').length;
  const pending = plan.entries.filter((e) => e.status === 'Pending').length;
  const totalRows = plan.entries.reduce((a, e) => a + (e.executed_rows ?? 0), 0);

  const rows = plan.entries
    .map(
      (e) => `<tr class="s-${e.status.toLowerCase()}">
<td>${escapeHtml(e.status)}</td>
<td>${escapeHtml(e.table_src)}</td>
<td>${escapeHtml(e.table_trgt)}</td>
<td class="num">${e.rows.toLocaleString()}</td>
<td class="num">${e.executed_rows === null ? '—' : e.executed_rows.toLocaleString()}</td>
<td class="num">${e.duration_ms === null ? '—' : e.duration_ms.toLocaleString() + ' ms'}</td>
<td class="num">${e.retry_count}</td>
<td>${escapeHtml(e.error_message ?? '')}</td>
</tr>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Migration Execution Report</title>
<style>
body { font-family: Segoe UI, sans-serif; margin: 24px; color: #1f1f1f; }
h1 { font-size: 1.4em; }
.summary { display: flex; gap: 24px; margin: 16px 0; }
.summary div { border: 1px solid #ddd; border-radius: 6px; padding: 8px 20px; }
.summary b { display: block; font-size: 1.5em; }
table { border-collapse: collapse; width: 100%; font-size: 0.9em; }
th, td { border: 1px solid #ccc; padding: 4px 10px; text-align: left; }
th { background: #f0f0f0; }
td.num { text-align: right; }
tr.s-completed td:first-child { color: #1a7f37; font-weight: 600; }
tr.s-failed td:first-child { color: #c62828; font-weight: 600; }
tr.s-stopped td:first-child { color: #b26a00; font-weight: 600; }
</style>
</head>
<body>
<h1>Migration Execution Report</h1>
<p>Source: <b>${escapeHtml(plan.source.server)} / ${escapeHtml(plan.source.database)}</b>
 → Destination: <b>${escapeHtml(plan.destination.server)} / ${escapeHtml(plan.destination.database)}</b><br>
Generated: ${new Date().toLocaleString()}</p>
<div class="summary">
<div><b>${plan.entries.length}</b>Tables</div>
<div><b>${completed}</b>Completed</div>
<div><b>${failed}</b>Failed</div>
<div><b>${pending}</b>Pending</div>
<div><b>${totalRows.toLocaleString()}</b>Rows migrated</div>
</div>
<table>
<thead><tr><th>Status</th><th>Source Table</th><th>Destination Table</th><th>Estimated Rows</th><th>Executed Rows</th><th>Duration</th><th>Retries</th><th>Error</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;
}
