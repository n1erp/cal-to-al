/**
 * Migration execution engine. Runs plan entries sequentially with two
 * strategies:
 *
 * - `insert-select`: source and destination share a server — a single
 *   `INSERT INTO … SELECT` inside a destination transaction.
 * - `bulk-copy`: different servers — stream rows from the source connection
 *   and bulk-insert batches into the destination inside a transaction.
 *
 * Every state change is written through {@link PlanStore} so the JSON plan
 * file is always the live execution log.
 *
 * @module migration/executionEngine
 */

import * as sql from 'mssql';
import * as vscode from 'vscode';
import { MIGRATION_CONFIG_NAMESPACE, MIGRATION_SETTINGS } from '../../constants';
import type { SqlServices } from '../../sql';
import type { FieldMetadata, TableMetadata } from '../../sql/types';
import { generateQuery } from './queryGenerator';
import { isExcludedMigrationColumn } from './mappingEngine';
import type { MigrationPlan, PlanEntry, PlanStore } from './planStore';

export interface RunState {
  running: boolean;
  currentEntryId: string | null;
  /** Ids queued in the active run (including the current one). */
  queued: string[];
  /** Rows copied so far for the current entry (bulk-copy progress). */
  currentRows: number;
}

interface SqlErrorLike {
  message?: string;
  number?: number;
  code?: string | number;
}

function errorCode(err: unknown): string | number | null {
  const e = err as SqlErrorLike;
  return e?.number ?? e?.code ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a scanned destination column to an mssql bulk-load column type. */
function mssqlType(field: FieldMetadata): sql.ISqlType {
  const length = field.length ?? undefined;
  switch (field.sqlType) {
    case 'int':
      return sql.Int();
    case 'bigint':
      return sql.BigInt();
    case 'smallint':
      return sql.SmallInt();
    case 'tinyint':
      return sql.TinyInt();
    case 'bit':
      return sql.Bit();
    case 'decimal':
    case 'numeric':
      return sql.Decimal(field.precision ?? 38, field.scale ?? 20);
    case 'money':
      return sql.Money();
    case 'smallmoney':
      return sql.SmallMoney();
    case 'float':
      return sql.Float();
    case 'real':
      return sql.Real();
    case 'date':
      return sql.Date();
    case 'datetime':
      return sql.DateTime();
    case 'datetime2':
      return sql.DateTime2(field.scale ?? 7);
    case 'smalldatetime':
      return sql.SmallDateTime();
    case 'datetimeoffset':
      return sql.DateTimeOffset(field.scale ?? 7);
    case 'time':
      return sql.Time(field.scale ?? 7);
    case 'char':
      return sql.Char(length ?? 1);
    case 'nchar':
      return sql.NChar(length ?? 1);
    case 'varchar':
      return length && length > 0 ? sql.VarChar(length) : sql.VarChar(sql.MAX);
    case 'nvarchar':
      return length && length > 0 ? sql.NVarChar(length) : sql.NVarChar(sql.MAX);
    case 'text':
      return sql.VarChar(sql.MAX);
    case 'ntext':
      return sql.NVarChar(sql.MAX);
    case 'binary':
    case 'varbinary':
      return field.length === -1 || field.sqlTypeFull.includes('max')
        ? sql.VarBinary(sql.MAX)
        : sql.VarBinary(Math.max(1, Math.abs(field.length ?? 8000)));
    case 'image':
      return sql.VarBinary(sql.MAX);
    case 'uniqueidentifier':
      return sql.UniqueIdentifier();
    case 'xml':
      return sql.Xml();
    default:
      return sql.NVarChar(sql.MAX);
  }
}

export class ExecutionEngine implements vscode.Disposable {
  private state: RunState = { running: false, currentEntryId: null, queued: [], currentRows: 0 };
  private cts: vscode.CancellationTokenSource | undefined;
  private readonly emitter = new vscode.EventEmitter<RunState>();
  readonly onDidChangeState = this.emitter.event;

  constructor(
    private readonly services: SqlServices,
    private readonly planStore: PlanStore
  ) {}

  getState(): RunState {
    return this.state;
  }

  private setState(patch: Partial<RunState>): void {
    this.state = { ...this.state, ...patch };
    this.emitter.fire(this.state);
  }

  private get batchSize(): number {
    return Math.max(
      100,
      vscode.workspace
        .getConfiguration(MIGRATION_CONFIG_NAMESPACE)
        .get<number>(MIGRATION_SETTINGS.batchSize, 5000)
    );
  }

  private log(text: string): void {
    this.services.output.appendLine(`[${new Date().toISOString()}] ${text}`);
  }

  /** Request a graceful stop after the current statement finishes or aborts. */
  stop(): void {
    if (this.state.running) {
      this.log('Stop requested.');
      this.cts?.cancel();
    }
  }

  /**
   * Execute the given plan entries sequentially.
   *
   * @param options.isRetry - marks entries as retries and bumps retry_count.
   * @param options.resume - skip entries that already completed.
   */
  async executeEntries(
    ids: string[],
    options: { isRetry?: boolean; resume?: boolean; allowIncomplete?: boolean } = {}
  ): Promise<void> {
    const plan = this.planStore.getPlan();
    if (!plan) {
      vscode.window.showWarningMessage('No migration plan loaded.');
      return;
    }
    if (this.state.running) {
      vscode.window.showWarningMessage('A migration run is already in progress.');
      return;
    }

    let queue = ids
      .map((id) => this.planStore.getEntry(id))
      .filter((e): e is PlanEntry => Boolean(e));
    if (options.resume) {
      queue = queue.filter((e) => !e.executed);
    }
    if (queue.length === 0) {
      vscode.window.showInformationMessage('Nothing to execute.');
      return;
    }

    this.cts = new vscode.CancellationTokenSource();
    const token = this.cts.token;
    this.setState({
      running: true,
      queued: queue.map((e) => e.id),
      currentEntryId: null,
      currentRows: 0,
    });
    this.services.output.show(true);
    this.log(
      `Starting migration run: ${queue.length} table(s), ` +
        `${plan.source.database} → ${plan.destination.database}` +
        (options.isRetry ? ' (retry)' : '') +
        (options.allowIncomplete ? '' : '')
    );

    try {
      for (const queuedEntry of queue) {
        if (token.isCancellationRequested) {
          break;
        }
        const entry = this.planStore.getEntry(queuedEntry.id);
        if (!entry) {
          continue;
        }
        if (!entry.mapping_complete) {
          this.log(
            `⚠ ${entry.table_trgt}: executing with ${entry.field_diff_count} field difference(s) — query may be incomplete`
          );
        }
        await this.executeOne(plan, entry, Boolean(options.isRetry), token);
      }
    } finally {
      const cancelled = token.isCancellationRequested;
      this.cts.dispose();
      this.cts = undefined;
      this.setState({ running: false, currentEntryId: null, queued: [], currentRows: 0 });
      this.log(cancelled ? 'Migration run stopped.' : 'Migration run finished.');
    }
  }

  private async executeOne(
    plan: MigrationPlan,
    entry: PlanEntry,
    isRetry: boolean,
    token: vscode.CancellationToken
  ): Promise<void> {
    const startedAt = new Date();
    this.setState({ currentEntryId: entry.id, currentRows: 0 });
    this.log(`▶ ${entry.table_src} → ${entry.table_trgt} (${entry.mode})`);

    await this.planStore.updateEntry(entry.id, {
      status: 'Running',
      executed: false,
      started_at: startedAt.toISOString(),
      finished_at: null,
      duration_ms: null,
      error_code: null,
      error_message: null,
      executed_rows: null,
      retry_count: isRetry ? entry.retry_count + 1 : entry.retry_count,
      is_retry: isRetry,
    });

    try {
      const rows =
        entry.mode === 'insert-select'
          ? await this.runInsertSelect(plan, entry)
          : await this.runBulkCopy(plan, entry, token);

      const finishedAt = new Date();
      await this.planStore.updateEntry(entry.id, {
        executed: true,
        status: 'Completed',
        executed_rows: rows,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
      });
      this.log(`✔ ${entry.table_trgt}: ${rows.toLocaleString()} rows in ${finishedAt.getTime() - startedAt.getTime()} ms`);
    } catch (err) {
      const finishedAt = new Date();
      const cancelled = token.isCancellationRequested || err instanceof vscode.CancellationError;
      await this.planStore.updateEntry(entry.id, {
        executed: false,
        status: cancelled ? 'Stopped' : 'Failed',
        error_code: cancelled ? null : errorCode(err),
        error_message: cancelled ? 'Execution stopped by user.' : errorMessage(err),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
      });
      this.log(
        cancelled
          ? `■ ${entry.table_trgt}: stopped`
          : `✖ ${entry.table_trgt}: ${errorMessage(err)}`
      );
    }
  }

  // ── Strategy: same server, INSERT…SELECT in a transaction ──────────────────

  private async runInsertSelect(plan: MigrationPlan, entry: PlanEntry): Promise<number> {
    this.log(`SQL (${entry.table_trgt}):\n${entry.query}`);
    const pool = await this.services.connections.getPool(
      plan.destination.connectionId,
      plan.destination.database
    );
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const request = new sql.Request(transaction);
      const result = await request.query(entry.query);
      await transaction.commit();
      return result.rowsAffected.reduce((a, b) => a + b, 0);
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
  }

  // ── Strategy: cross-server streamed bulk copy ───────────────────────────────

  private async runBulkCopy(
    plan: MigrationPlan,
    entry: PlanEntry,
    token: vscode.CancellationToken
  ): Promise<number> {
    const mappingSet = this.planStore.getMappingSet();
    const mapping = mappingSet?.mappings.find((m) => m.id === entry.mapping_id);
    if (!mappingSet || !mapping) {
      throw new Error(
        'Mapping details not found (mappings.json missing) — cannot run cross-server copy.'
      );
    }

    const destTable = await this.services.scanner.scanTable(
      plan.destination.connectionId,
      plan.destination.database,
      mapping.destination.schema,
      mapping.destination.table
    );
    if (!destTable) {
      throw new Error(`Destination table not found: ${entry.table_trgt}`);
    }

    const query = generateQuery(
      mapping,
      plan.source.database,
      plan.destination.database
    );
    const included = mapping.fields.filter(
      (f) =>
        f.included &&
        !isExcludedMigrationColumn(f.sourceColumn) &&
        !isExcludedMigrationColumn(f.destinationColumn)
    );
    const destFieldByColumn = new Map(destTable.fields.map((f) => [f.sqlColumn, f]));

    const destPool = await this.services.connections.getPool(
      plan.destination.connectionId,
      plan.destination.database
    );
    const sourcePool = await this.services.connections.getPool(
      plan.source.connectionId,
      plan.source.database
    );

    const transaction = new sql.Transaction(destPool);
    await transaction.begin();

    const makeTable = (): sql.Table => {
      const table = new sql.Table(
        `[${mapping.destination.schema}].[${mapping.destination.table}]`
      );
      table.create = false;
      for (const pair of included) {
        const destField = destFieldByColumn.get(pair.destinationColumn);
        if (!destField) {
          throw new Error(
            `Destination column not found: ${pair.destinationColumn} in ${entry.table_trgt}`
          );
        }
        table.columns.add(pair.destinationColumn, mssqlType(destField), {
          nullable: destField.nullable,
        });
      }
      return table;
    };

    const batchSize = this.batchSize;
    let batch = makeTable();
    let batchRows = 0;
    let totalRows = 0;

    this.log(`SQL (${entry.table_trgt}):\n${query.selectSql}`);

    const flush = async () => {
      if (batchRows === 0) {
        return;
      }
      const request = new sql.Request(transaction);
      await request.bulk(batch, { keepNulls: true });
      totalRows += batchRows;
      batch = makeTable();
      batchRows = 0;
      this.setState({ currentRows: totalRows });
      this.log(`  … ${entry.table_trgt}: ${totalRows.toLocaleString()} rows copied`);
    };

    try {
      // Stream from source with backpressure (pause while flushing a batch).
      const sourceRequest = sourcePool.request();
      sourceRequest.stream = true;

      const cancelSub = token.onCancellationRequested(() => sourceRequest.cancel());

      await new Promise<void>((resolve, reject) => {
        let flushing = Promise.resolve();
        let failed = false;

        sourceRequest.on('row', (row: Record<string, unknown>) => {
          if (failed) {
            return;
          }
          batch.rows.add(...included.map((pair) => row[pair.sourceColumn] as never));
          batchRows += 1;
          if (batchRows >= batchSize) {
            sourceRequest.pause();
            flushing = flush()
              .then(() => {
                sourceRequest.resume();
              })
              .catch((err) => {
                failed = true;
                sourceRequest.cancel();
                reject(err);
              });
          }
        });
        sourceRequest.on('error', (err: Error) => {
          failed = true;
          reject(err);
        });
        sourceRequest.on('done', () => {
          void flushing.then(resolve, reject);
        });
        void sourceRequest.query(query.selectSql);
      });
      cancelSub.dispose();

      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }

      await flush();
      await transaction.commit();
      return totalRows;
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
  }

  dispose(): void {
    this.stop();
    this.emitter.dispose();
  }
}
