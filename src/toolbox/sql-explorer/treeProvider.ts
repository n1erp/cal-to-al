/**
 * Hierarchical SQL Explorer tree:
 * Connections → Databases → Schemas → (Tables | Views | Stored Procedures).
 *
 * @module sql-explorer/treeProvider
 */

import * as vscode from 'vscode';
import { CMD_SQL_PREVIEW_TABLE } from '../../constants';
import type { SqlServices } from '../../sql';

export type SqlNodeKind =
  | 'connection'
  | 'database'
  | 'schema'
  | 'tablesFolder'
  | 'viewsFolder'
  | 'proceduresFolder'
  | 'table'
  | 'view'
  | 'procedure'
  | 'message';

export interface SqlNode {
  kind: SqlNodeKind;
  label: string;
  connectionId?: string;
  database?: string;
  schema?: string;
  /** Object name for table/view/procedure nodes. */
  objectName?: string;
}

interface TableListRow {
  schema_name: string;
  name: string;
}

const FOLDER_KINDS: Record<string, { catalog: string; kind: SqlNodeKind; icon: string }> = {
  tablesFolder: { catalog: 'sys.tables', kind: 'table', icon: 'table' },
  viewsFolder: { catalog: 'sys.views', kind: 'view', icon: 'eye' },
  proceduresFolder: { catalog: 'sys.procedures', kind: 'procedure', icon: 'gear' },
};

export class SqlExplorerTreeProvider implements vscode.TreeDataProvider<SqlNode> {
  private readonly emitter = new vscode.EventEmitter<SqlNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Cache of schema→objects per connection::database, filled on expand. */
  private readonly objectCache = new Map<string, TableListRow[]>();

  constructor(private readonly services: SqlServices) {}

  refresh(node?: SqlNode): void {
    if (!node) {
      this.objectCache.clear();
    }
    this.emitter.fire(node);
  }

  getTreeItem(node: SqlNode): vscode.TreeItem {
    switch (node.kind) {
      case 'connection': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('server-environment');
        item.contextValue = 'sqlConnection';
        item.id = `conn:${node.connectionId}`;
        const profile = this.services.connections.getProfile(node.connectionId ?? '');
        item.description = profile?.server;
        item.tooltip = profile
          ? `${profile.server}${profile.port ? ':' + profile.port : ''} (${profile.authMode === 'ntlm' ? 'Windows auth' : 'SQL auth'})`
          : undefined;
        return item;
      }
      case 'database': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'sqlDatabase';
        item.id = `db:${node.connectionId}:${node.database}`;
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'sqlSchema';
        return item;
      }
      case 'tablesFolder':
      case 'viewsFolder':
      case 'proceduresFolder': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = node.kind;
        return item;
      }
      case 'table':
      case 'view': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.kind === 'table' ? 'table' : 'eye');
        item.contextValue = node.kind === 'table' ? 'sqlTable' : 'sqlView';
        item.command = {
          command: CMD_SQL_PREVIEW_TABLE,
          title: 'Preview Data',
          arguments: [node],
        };
        return item;
      }
      case 'procedure': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('gear');
        item.contextValue = 'sqlProcedure';
        return item;
      }
      default: {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  async getChildren(node?: SqlNode): Promise<SqlNode[]> {
    try {
      if (!node) {
        const profiles = this.services.connections.getProfiles();
        if (profiles.length === 0) {
          return [
            {
              kind: 'message',
              label: 'No connections. Use the + button to add one.',
            },
          ];
        }
        return profiles.map((p) => ({
          kind: 'connection',
          label: p.name,
          connectionId: p.id,
        }));
      }

      switch (node.kind) {
        case 'connection': {
          const databases = await this.services.runner.listDatabases(node.connectionId!);
          return databases.map((db) => ({
            kind: 'database',
            label: db,
            connectionId: node.connectionId,
            database: db,
          }));
        }
        case 'database': {
          const rows = await this.listObjects(node.connectionId!, node.database!, 'sys.tables');
          const schemas = [...new Set(rows.map((r) => r.schema_name))].sort();
          if (schemas.length === 0) {
            schemas.push('dbo');
          }
          return schemas.map((s) => ({
            kind: 'schema',
            label: s,
            connectionId: node.connectionId,
            database: node.database,
            schema: s,
          }));
        }
        case 'schema': {
          return (['tablesFolder', 'viewsFolder', 'proceduresFolder'] as const).map((kind) => ({
            kind,
            label:
              kind === 'tablesFolder'
                ? 'Tables'
                : kind === 'viewsFolder'
                  ? 'Views'
                  : 'Stored Procedures',
            connectionId: node.connectionId,
            database: node.database,
            schema: node.schema,
          }));
        }
        case 'tablesFolder':
        case 'viewsFolder':
        case 'proceduresFolder': {
          const meta = FOLDER_KINDS[node.kind];
          const rows = await this.listObjects(node.connectionId!, node.database!, meta.catalog);
          return rows
            .filter((r) => r.schema_name === node.schema)
            .map((r) => ({
              kind: meta.kind,
              label: r.name,
              connectionId: node.connectionId,
              database: node.database,
              schema: r.schema_name,
              objectName: r.name,
            }));
        }
        default:
          return [];
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.services.output.appendLine(
        `[${new Date().toISOString()}] [explorer] Failed loading children` +
          `${node ? ` for ${node.kind} "${node.label}"` : ''}: ${message}`
      );
      return [
        {
          kind: 'message',
          label: `Error: ${message.split('\n')[0]}`,
        },
      ];
    }
  }

  private async listObjects(
    connectionId: string,
    database: string,
    catalog: string
  ): Promise<TableListRow[]> {
    const cacheKey = `${connectionId}::${database}::${catalog}`;
    const cached = this.objectCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const result = await this.services.runner.query<TableListRow>(
      connectionId,
      database,
      `SELECT s.name AS schema_name, o.name
       FROM ${catalog} o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.is_ms_shipped = 0
       ORDER BY s.name, o.name`
    );
    this.objectCache.set(cacheKey, result.recordset);
    return result.recordset;
  }
}
