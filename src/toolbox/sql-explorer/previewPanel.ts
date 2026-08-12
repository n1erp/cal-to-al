/**
 * Table preview webview: paged data grid with search, per-column filters,
 * sorting, a metadata tab, and export actions.
 *
 * @module sql-explorer/previewPanel
 */

import * as vscode from 'vscode';
import { AssetPaths, extensionAssetUri } from '../../assetPaths';
import type { SqlServices } from '../../sql';
import { quoteIdent } from '../../sql/types';
import type { TableMetadata } from '../../sql/types';
import type { QueryParam } from '../../sql/queryRunner';
import { buildPreviewHtml } from './previewHtml';
import { exportTableData, type ExportFormat } from './exportService';

export interface PreviewTarget {
  connectionId: string;
  database: string;
  schema: string;
  objectName: string;
}

interface FilterSpec {
  column: string;
  op: 'contains' | 'equals' | 'gt' | 'lt' | 'ne';
  value: string;
}

interface LoadRequest {
  page: number;
  pageSize: number;
  sortColumn?: string;
  sortDir?: 'asc' | 'desc';
  search?: string;
  filters?: FilterSpec[];
}

const STRING_SQL_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext']);

const panels = new Map<string, vscode.WebviewPanel>();

/** Builds a parameterized WHERE clause from search text + column filters. */
export function buildWhere(
  table: TableMetadata,
  search: string | undefined,
  filters: FilterSpec[] | undefined
): { where: string; params: QueryParam[] } {
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  const columnNames = new Set(table.fields.map((f) => f.sqlColumn));

  if (search && search.trim() !== '') {
    const textColumns = table.fields.filter((f) => STRING_SQL_TYPES.has(f.sqlType));
    if (textColumns.length > 0) {
      params.push({ name: `search`, value: `%${escapeLike(search.trim())}%` });
      const ors = textColumns.map(
        (f) => `${quoteIdent(f.sqlColumn)} LIKE @search ESCAPE '\\'`
      );
      clauses.push(`(${ors.join(' OR ')})`);
    }
  }

  for (const filter of filters ?? []) {
    if (!columnNames.has(filter.column) || filter.value === '') {
      continue;
    }
    const p = `f${params.length}`;
    const col = quoteIdent(filter.column);
    switch (filter.op) {
      case 'contains':
        params.push({ name: p, value: `%${escapeLike(filter.value)}%` });
        clauses.push(`CAST(${col} AS nvarchar(max)) LIKE @${p} ESCAPE '\\'`);
        break;
      case 'equals':
        params.push({ name: p, value: filter.value });
        clauses.push(`CAST(${col} AS nvarchar(max)) = @${p}`);
        break;
      case 'ne':
        params.push({ name: p, value: filter.value });
        clauses.push(`CAST(${col} AS nvarchar(max)) <> @${p}`);
        break;
      case 'gt':
        params.push({ name: p, value: filter.value });
        clauses.push(`${col} > @${p}`);
        break;
      case 'lt':
        params.push({ name: p, value: filter.value });
        clauses.push(`${col} < @${p}`);
        break;
    }
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_[]/g, (m) => `\\${m}`);
}

function buildOrderBy(table: TableMetadata, sortColumn?: string, sortDir?: 'asc' | 'desc'): string {
  const columnNames = new Set(table.fields.map((f) => f.sqlColumn));
  if (sortColumn && columnNames.has(sortColumn)) {
    return `ORDER BY ${quoteIdent(sortColumn)} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`;
  }
  if (table.primaryKey.length > 0) {
    return `ORDER BY ${table.primaryKey.map((c) => quoteIdent(c)).join(', ')}`;
  }
  return `ORDER BY ${quoteIdent(table.fields[0].sqlColumn)}`;
}

/** Serialize SQL values into JSON-safe cell strings. */
function toCell(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  }
  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex').slice(0, 64)}${value.length > 32 ? '…' : ''}`;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

export async function openTablePreview(
  context: vscode.ExtensionContext,
  services: SqlServices,
  target: PreviewTarget
): Promise<void> {
  const key = `${target.connectionId}:${target.database}:${target.schema}:${target.objectName}`;
  const existing = panels.get(key);
  if (existing) {
    existing.reveal(undefined, false);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'calToAl.sqlPreview',
    `${target.objectName} — ${target.database}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        extensionAssetUri(context.extensionUri, AssetPaths.sqlExplorer.folder),
        extensionAssetUri(context.extensionUri, AssetPaths.icons.folder),
      ],
    }
  );
  panel.iconPath = new vscode.ThemeIcon('table');
  panels.set(key, panel);
  panel.onDidDispose(() => panels.delete(key));

  panel.webview.html = buildPreviewHtml(panel.webview, context.extensionUri);

  let table: TableMetadata | undefined;
  let lastRequest: LoadRequest = { page: 1, pageSize: 100 };

  const post = (message: unknown) => void panel.webview.postMessage(message);

  const sendInit = async () => {
    try {
      table = await services.scanner.scanTable(
        target.connectionId,
        target.database,
        target.schema,
        target.objectName
      );
      if (!table) {
        // Views have no sys.tables metadata; build a lightweight descriptor.
        table = await buildViewMetadata(services, target);
      }
      post({
        command: 'init',
        data: {
          database: target.database,
          schema: target.schema,
          table: target.objectName,
          meta: table,
        },
      });
      await sendPage(lastRequest);
    } catch (err) {
      post({ command: 'error', data: { message: errText(err) } });
    }
  };

  const sendPage = async (req: LoadRequest) => {
    if (!table) {
      return;
    }
    lastRequest = req;
    try {
      const { where, params } = buildWhere(table, req.search, req.filters);
      const from = `${quoteIdent(target.schema)}.${quoteIdent(target.objectName)}`;
      const orderBy = buildOrderBy(table, req.sortColumn, req.sortDir);
      const offset = (Math.max(1, req.page) - 1) * req.pageSize;

      const countResult = await services.runner.query<{ total: number }>(
        target.connectionId,
        target.database,
        `SELECT COUNT_BIG(*) AS total FROM ${from} ${where}`,
        params
      );
      const total = Number(countResult.recordset[0]?.total ?? 0);

      const dataResult = await services.runner.query(
        target.connectionId,
        target.database,
        `SELECT * FROM ${from} ${where} ${orderBy}
         OFFSET ${offset} ROWS FETCH NEXT ${Math.min(req.pageSize, 1000)} ROWS ONLY`,
        params
      );
      const columns = table.fields.map((f) => f.sqlColumn);
      const rows = dataResult.recordset.map((r) =>
        columns.map((c) => toCell((r as Record<string, unknown>)[c]))
      );
      post({
        command: 'page',
        data: { rows, total, page: req.page, pageSize: req.pageSize },
      });
    } catch (err) {
      post({ command: 'error', data: { message: errText(err) } });
    }
  };

  const handleExport = async (format: ExportFormat) => {
    if (!table) {
      return;
    }
    const { where, params } = buildWhere(table, lastRequest.search, lastRequest.filters);
    try {
      await exportTableData(services, target, table, format, where, params);
    } catch (err) {
      vscode.window.showErrorMessage(`Export failed: ${errText(err)}`);
    }
  };

  panel.webview.onDidReceiveMessage(async (raw: { command: string; data?: unknown }) => {
    switch (raw?.command) {
      case 'ready':
        await sendInit();
        break;
      case 'load':
        await sendPage(raw.data as LoadRequest);
        break;
      case 'refresh':
        services.scanner.invalidate(target.connectionId, target.database);
        await sendInit();
        break;
      case 'export':
        await handleExport((raw.data as { format: ExportFormat }).format);
        break;
      default:
        break;
    }
  });
}

/** Minimal TableMetadata for views (columns only, no keys). */
async function buildViewMetadata(
  services: SqlServices,
  target: PreviewTarget
): Promise<TableMetadata> {
  const result = await services.runner.query<{
    name: string;
    type_name: string;
    column_id: number;
    is_nullable: boolean;
    max_length: number;
    precision: number;
    scale: number;
    collation_name: string | null;
  }>(
    target.connectionId,
    target.database,
    `SELECT c.name, ty.name AS type_name, c.column_id, c.is_nullable,
            c.max_length, c.precision, c.scale, c.collation_name
     FROM sys.columns c
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     WHERE c.object_id = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@name))
     ORDER BY c.column_id`,
    [
      { name: 'schema', value: target.schema },
      { name: 'name', value: target.objectName },
    ]
  );
  return {
    schema: target.schema,
    tableName: target.objectName,
    objectId: 0,
    bcTableId: null,
    bcTableName: null,
    dataPerCompany: false,
    companyName: null,
    baseName: target.objectName,
    primaryKey: [],
    secondaryKeys: [],
    foreignKeys: [],
    rowCount: 0,
    fields: result.recordset.map((c) => ({
      fieldId: null,
      fieldName: c.name,
      sqlColumn: c.name,
      sqlType: c.type_name,
      sqlTypeFull: c.type_name,
      bcType: null,
      length: null,
      precision: c.precision,
      scale: c.scale,
      nullable: Boolean(c.is_nullable),
      identity: false,
      autoIncrement: false,
      isPrimaryKey: false,
      defaultValue: null,
      collation: c.collation_name,
      columnId: c.column_id,
    })),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
