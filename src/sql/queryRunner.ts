/**
 * Query execution helpers on top of {@link ConnectionManager} pools:
 * parameterized queries, cancellation, and row streaming.
 *
 * @module sql/queryRunner
 */

import * as sql from 'mssql';
import * as vscode from 'vscode';
import type { ConnectionManager } from './connectionManager';

export interface QueryParam {
  name: string;
  value: unknown;
}

export interface StreamOptions {
  /** Called once with the recordset column metadata. */
  onColumns?: (columns: sql.IColumnMetadata) => void;
  /** Called for every row. */
  onRow: (row: Record<string, unknown>) => void;
  /** Cancels the running request when triggered. */
  token?: vscode.CancellationToken;
}

export class QueryRunner {
  constructor(private readonly connections: ConnectionManager) {}

  /** Run a (optionally parameterized) query and return the full result set. */
  async query<T = Record<string, unknown>>(
    profileId: string,
    database: string | undefined,
    text: string,
    params?: QueryParam[]
  ): Promise<sql.IResult<T>> {
    const pool = await this.connections.getPool(profileId, database);
    const request = pool.request();
    for (const p of params ?? []) {
      request.input(p.name, p.value as never);
    }
    return request.query<T>(text);
  }

  /** Run a statement, returning total rows affected. */
  async execute(
    profileId: string,
    database: string | undefined,
    text: string
  ): Promise<number> {
    const result = await this.query(profileId, database, text);
    return result.rowsAffected.reduce((a, b) => a + b, 0);
  }

  /**
   * Stream a query row by row (used for previews, exports and cross-server
   * bulk copies). Resolves with the number of rows streamed.
   */
  async stream(
    profileId: string,
    database: string | undefined,
    text: string,
    options: StreamOptions,
    params?: QueryParam[]
  ): Promise<number> {
    const pool = await this.connections.getPool(profileId, database);
    const request = pool.request();
    request.stream = true;
    for (const p of params ?? []) {
      request.input(p.name, p.value as never);
    }

    let cancelSub: vscode.Disposable | undefined;
    if (options.token) {
      if (options.token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      cancelSub = options.token.onCancellationRequested(() => request.cancel());
    }

    let rowCount = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        request.on('recordset', (columns: sql.IColumnMetadata) => {
          options.onColumns?.(columns);
        });
        request.on('row', (row: Record<string, unknown>) => {
          rowCount += 1;
          try {
            options.onRow(row);
          } catch (err) {
            request.cancel();
            reject(err);
          }
        });
        request.on('error', (err: Error) => reject(err));
        request.on('done', () => resolve());
        void request.query(text);
      });
    } finally {
      cancelSub?.dispose();
    }

    if (options.token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    return rowCount;
  }

  /** List databases on a server (excluding system databases). */
  async listDatabases(profileId: string): Promise<string[]> {
    const result = await this.query<{ name: string }>(
      profileId,
      undefined,
      `SELECT name FROM sys.databases
       WHERE name NOT IN ('master','tempdb','model','msdb') AND state = 0
       ORDER BY name`
    );
    return result.recordset.map((r) => r.name);
  }
}
