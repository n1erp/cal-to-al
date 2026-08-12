/**
 * Scans a database's full structure (tables, fields, keys, FKs, row counts)
 * and enriches it with NAV / Business Central metadata (table ids,
 * DataPerCompany, BC data types).
 *
 * @module sql/metadataScanner
 */

import type { ConnectionManager } from './connectionManager';
import type { QueryRunner } from './queryRunner';
import type {
  DatabaseMetadata,
  DbObjectInfo,
  FieldMetadata,
  ForeignKeyInfo,
  IndexInfo,
  TableMetadata,
} from './types';

interface ColumnRow {
  object_id: number;
  schema_name: string;
  table_name: string;
  column_id: number;
  column_name: string;
  type_name: string;
  max_length: number;
  precision: number;
  scale: number;
  is_nullable: boolean;
  is_identity: boolean;
  is_computed: boolean;
  collation_name: string | null;
  default_definition: string | null;
}

interface IndexRow {
  object_id: number;
  index_name: string;
  is_primary_key: boolean;
  is_unique: boolean;
  key_ordinal: number;
  column_name: string;
}

interface FkRow {
  fk_id: number;
  fk_name: string;
  parent_object_id: number;
  parent_column: string;
  ref_schema: string;
  ref_table: string;
  ref_column: string;
}

/** Strips a trailing BC extension app-id suffix, e.g. `Item$437dbf0e-...`. */
const APP_ID_SUFFIX = /\$[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STRING_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext']);

/** Maps a SQL column to the most likely NAV / BC data type. */
export function inferBcType(
  typeName: string,
  length: number | null,
  columnName: string
): string | null {
  switch (typeName) {
    case 'int':
      return 'Integer';
    case 'bigint':
      return 'BigInteger';
    case 'tinyint':
    case 'bit':
      return 'Boolean';
    case 'smallint':
      return 'Option';
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
    case 'float':
    case 'real':
      return 'Decimal';
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
      return 'DateTime';
    case 'date':
      return 'Date';
    case 'time':
      return 'Time';
    case 'uniqueidentifier':
      return 'GUID';
    case 'image':
      return 'BLOB';
    case 'varbinary':
      return length === -1 ? 'BLOB' : 'RecordID';
    case 'timestamp':
    case 'rowversion':
      return 'BigInteger';
    default:
      break;
  }
  if (STRING_TYPES.has(typeName)) {
    // NAV convention: "No." style key fields are Code, free text is Text.
    const lower = columnName.toLowerCase();
    const looksLikeCode =
      lower === 'no_' ||
      lower.endsWith(' no_') ||
      lower.endsWith('code') ||
      lower.endsWith(' code');
    return looksLikeCode ? 'Code' : 'Text';
  }
  return null;
}

function formatSqlTypeFull(row: ColumnRow, charLength: number | null): string {
  const t = row.type_name;
  if (STRING_TYPES.has(t) && t !== 'text' && t !== 'ntext') {
    return `${t}(${charLength === -1 || row.max_length === -1 ? 'max' : charLength})`;
  }
  if (t === 'varbinary' || t === 'binary') {
    return `${t}(${row.max_length === -1 ? 'max' : row.max_length})`;
  }
  if (t === 'decimal' || t === 'numeric') {
    return `${t}(${row.precision},${row.scale})`;
  }
  if (t === 'datetime2' || t === 'time') {
    return `${t}(${row.scale})`;
  }
  return t;
}

export class MetadataScanner {
  private readonly cache = new Map<string, DatabaseMetadata>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly runner: QueryRunner
  ) {}

  getCached(connectionId: string, database: string): DatabaseMetadata | undefined {
    return this.cache.get(`${connectionId}::${database}`);
  }

  invalidate(connectionId: string, database?: string): void {
    if (database) {
      this.cache.delete(`${connectionId}::${database}`);
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${connectionId}::`)) {
        this.cache.delete(key);
      }
    }
  }

  /** Scan a database (or return the cached model unless `refresh` is set). */
  async scan(
    connectionId: string,
    database: string,
    refresh = false
  ): Promise<DatabaseMetadata> {
    const key = `${connectionId}::${database}`;
    if (!refresh) {
      const cached = this.cache.get(key);
      if (cached) {
        return cached;
      }
    }

    const profile = this.connections.getProfile(connectionId);
    if (!profile) {
      throw new Error(`Unknown SQL connection profile: ${connectionId}`);
    }

    const [columns, rowCounts, indexes, fks, views, procedures, companies, navObjects] =
      await Promise.all([
        this.queryColumns(connectionId, database),
        this.queryRowCounts(connectionId, database),
        this.queryIndexes(connectionId, database),
        this.queryForeignKeys(connectionId, database),
        this.queryObjects(connectionId, database, 'sys.views'),
        this.queryObjects(connectionId, database, 'sys.procedures'),
        this.queryCompanies(connectionId, database),
        this.queryNavObjects(connectionId, database),
      ]);

    const tables = this.assemble(columns, rowCounts, indexes, fks, companies, navObjects);

    const metadata: DatabaseMetadata = {
      connectionId,
      connectionName: profile.name,
      server: profile.server,
      database,
      scannedAt: new Date().toISOString(),
      companies,
      tables,
      views,
      procedures,
    };
    this.cache.set(key, metadata);
    return metadata;
  }

  /**
   * Scan a single table (used by the preview panel; cheaper than a full
   * database scan on large NAV databases).
   */
  async scanTable(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<TableMetadata | undefined> {
    const cached = this.getCached(connectionId, database);
    if (cached) {
      const hit = cached.tables.find((t) => t.schema === schema && t.tableName === table);
      if (hit) {
        return hit;
      }
    }
    const filter = { schema, table };
    const [columns, rowCounts, indexes, fks, companies, navObjects] = await Promise.all([
      this.queryColumns(connectionId, database, filter),
      this.queryRowCounts(connectionId, database),
      this.queryIndexes(connectionId, database, filter),
      this.queryForeignKeys(connectionId, database, filter),
      this.queryCompanies(connectionId, database),
      this.queryNavObjects(connectionId, database),
    ]);
    const tables = this.assemble(columns, rowCounts, indexes, fks, companies, navObjects);
    return tables[0];
  }

  // ── Catalog queries ─────────────────────────────────────────────────────────

  private async queryColumns(
    connectionId: string,
    database: string,
    filter?: { schema: string; table: string }
  ): Promise<ColumnRow[]> {
    const result = await this.runner.query<ColumnRow>(
      connectionId,
      database,
      `SELECT
         t.object_id,
         s.name AS schema_name,
         t.name AS table_name,
         c.column_id,
         c.name AS column_name,
         ty.name AS type_name,
         c.max_length,
         c.precision,
         c.scale,
         c.is_nullable,
         c.is_identity,
         c.is_computed,
         c.collation_name,
         dc.definition AS default_definition
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.columns c ON c.object_id = t.object_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc
         ON dc.parent_object_id = t.object_id AND dc.parent_column_id = c.column_id
       WHERE t.is_ms_shipped = 0
         ${filter ? 'AND s.name = @schema AND t.name = @table' : ''}
       ORDER BY s.name, t.name, c.column_id`,
      filter
        ? [
            { name: 'schema', value: filter.schema },
            { name: 'table', value: filter.table },
          ]
        : undefined
    );
    return result.recordset;
  }

  private async queryRowCounts(
    connectionId: string,
    database: string
  ): Promise<Map<number, number>> {
    const result = await this.runner.query<{ object_id: number; row_count: number }>(
      connectionId,
      database,
      `SELECT p.object_id, SUM(p.row_count) AS row_count
       FROM sys.dm_db_partition_stats p
       WHERE p.index_id IN (0, 1)
       GROUP BY p.object_id`
    );
    return new Map(result.recordset.map((r) => [r.object_id, Number(r.row_count)]));
  }

  private async queryIndexes(
    connectionId: string,
    database: string,
    filter?: { schema: string; table: string }
  ): Promise<IndexRow[]> {
    const result = await this.runner.query<IndexRow>(
      connectionId,
      database,
      `SELECT
         i.object_id,
         i.name AS index_name,
         i.is_primary_key,
         i.is_unique,
         ic.key_ordinal,
         c.name AS column_name
       FROM sys.indexes i
       JOIN sys.index_columns ic
         ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c
         ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.name IS NOT NULL
         AND ic.key_ordinal > 0
         AND i.object_id IN (SELECT object_id FROM sys.tables WHERE is_ms_shipped = 0)
         ${filter ? 'AND i.object_id = OBJECT_ID(QUOTENAME(@schema) + N\'.\' + QUOTENAME(@table))' : ''}
       ORDER BY i.object_id, i.index_id, ic.key_ordinal`,
      filter
        ? [
            { name: 'schema', value: filter.schema },
            { name: 'table', value: filter.table },
          ]
        : undefined
    );
    return result.recordset;
  }

  private async queryForeignKeys(
    connectionId: string,
    database: string,
    filter?: { schema: string; table: string }
  ): Promise<FkRow[]> {
    const result = await this.runner.query<FkRow>(
      connectionId,
      database,
      `SELECT
         fk.object_id AS fk_id,
         fk.name AS fk_name,
         fk.parent_object_id,
         cp.name AS parent_column,
         sr.name AS ref_schema,
         tr.name AS ref_table,
         cr.name AS ref_column
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns cp
         ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
       JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
       JOIN sys.schemas sr ON sr.schema_id = tr.schema_id
       JOIN sys.columns cr
         ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
       ${filter ? 'WHERE fk.parent_object_id = OBJECT_ID(QUOTENAME(@schema) + N\'.\' + QUOTENAME(@table))' : ''}
       ORDER BY fk.object_id, fkc.constraint_column_id`,
      filter
        ? [
            { name: 'schema', value: filter.schema },
            { name: 'table', value: filter.table },
          ]
        : undefined
    );
    return result.recordset;
  }

  private async queryObjects(
    connectionId: string,
    database: string,
    catalog: 'sys.views' | 'sys.procedures'
  ): Promise<DbObjectInfo[]> {
    const result = await this.runner.query<{ schema_name: string; name: string }>(
      connectionId,
      database,
      `SELECT s.name AS schema_name, o.name
       FROM ${catalog} o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.is_ms_shipped = 0
       ORDER BY s.name, o.name`
    );
    return result.recordset.map((r) => ({ schema: r.schema_name, name: r.name }));
  }

  /** Companies in a NAV/BC database (empty for plain SQL databases). */
  private async queryCompanies(connectionId: string, database: string): Promise<string[]> {
    try {
      const result = await this.runner.query<{ Name: string }>(
        connectionId,
        database,
        `SELECT [Name] FROM [dbo].[Company] ORDER BY [Name]`
      );
      return result.recordset.map((r) => r.Name);
    } catch {
      return [];
    }
  }

  /** NAV `Object` table: table id + name (Type 1 = Table). Missing on plain databases. */
  private async queryNavObjects(
    connectionId: string,
    database: string
  ): Promise<Map<string, number>> {
    try {
      const result = await this.runner.query<{ ID: number; Name: string }>(
        connectionId,
        database,
        `SELECT [ID], [Name] FROM [dbo].[Object] WHERE [Type] = 1 AND [Company Name] = ''`
      );
      const map = new Map<string, number>();
      for (const row of result.recordset) {
        map.set(row.Name.toLowerCase(), row.ID);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  // ── Assembly ────────────────────────────────────────────────────────────────

  private assemble(
    columns: ColumnRow[],
    rowCounts: Map<number, number>,
    indexes: IndexRow[],
    fks: FkRow[],
    companies: string[],
    navObjects: Map<string, number>
  ): TableMetadata[] {
    // Group indexes per table.
    const indexesByTable = new Map<number, IndexInfo[]>();
    const indexKey = new Map<string, IndexInfo>();
    for (const row of indexes) {
      const key = `${row.object_id}::${row.index_name}`;
      let info = indexKey.get(key);
      if (!info) {
        info = {
          name: row.index_name,
          isPrimaryKey: Boolean(row.is_primary_key),
          isUnique: Boolean(row.is_unique),
          columns: [],
        };
        indexKey.set(key, info);
        const list = indexesByTable.get(row.object_id) ?? [];
        list.push(info);
        indexesByTable.set(row.object_id, list);
      }
      info.columns.push(row.column_name);
    }

    // Group foreign keys per table.
    const fksByTable = new Map<number, ForeignKeyInfo[]>();
    const fkKey = new Map<number, ForeignKeyInfo>();
    for (const row of fks) {
      let info = fkKey.get(row.fk_id);
      if (!info) {
        info = {
          name: row.fk_name,
          columns: [],
          referencedSchema: row.ref_schema,
          referencedTable: row.ref_table,
          referencedColumns: [],
        };
        fkKey.set(row.fk_id, info);
        const list = fksByTable.get(row.parent_object_id) ?? [];
        list.push(info);
        fksByTable.set(row.parent_object_id, list);
      }
      info.columns.push(row.parent_column);
      info.referencedColumns.push(row.ref_column);
    }

    // Sort company names longest first so "CRONUS International Ltd_$Item"
    // is matched before a shorter company that happens to be a prefix.
    const companyPrefixes = companies
      .map((c) => c.replace(/[."\\/%\][']/g, '_'))
      .sort((a, b) => b.length - a.length);

    // Group columns per table.
    const tables: TableMetadata[] = [];
    const byTable = new Map<number, ColumnRow[]>();
    for (const col of columns) {
      const list = byTable.get(col.object_id) ?? [];
      list.push(col);
      byTable.set(col.object_id, list);
    }

    for (const [objectId, cols] of byTable) {
      const first = cols[0];
      const tableIndexes = indexesByTable.get(objectId) ?? [];
      const pkIndex = tableIndexes.find((i) => i.isPrimaryKey);
      const pkColumns = new Set(pkIndex?.columns ?? []);

      // Company prefix detection: physical name `Company$Table`.
      let companyName: string | null = null;
      let baseName = first.table_name;
      for (const prefix of companyPrefixes) {
        if (baseName.startsWith(`${prefix}$`)) {
          companyName = prefix;
          baseName = baseName.slice(prefix.length + 1);
          break;
        }
      }
      // Strip BC extension app-id suffix from the logical name.
      baseName = baseName.replace(APP_ID_SUFFIX, '');

      const bcTableId = navObjects.get(baseName.toLowerCase()) ?? null;

      const fields: FieldMetadata[] = cols.map((c) => {
        const isCharType = STRING_TYPES.has(c.type_name);
        const charLength =
          isCharType && c.max_length > 0 && c.type_name.startsWith('n')
            ? c.max_length / 2
            : isCharType
              ? c.max_length
              : null;
        return {
          fieldId: null,
          fieldName: c.column_name,
          sqlColumn: c.column_name,
          sqlType: c.type_name,
          sqlTypeFull: formatSqlTypeFull(c, charLength),
          bcType: inferBcType(c.type_name, charLength, c.column_name),
          length: charLength,
          precision: c.precision ?? null,
          scale: c.scale ?? null,
          nullable: Boolean(c.is_nullable),
          identity: Boolean(c.is_identity),
          autoIncrement:
            Boolean(c.is_identity) ||
            Boolean(c.is_computed) ||
            c.type_name === 'timestamp' ||
            c.type_name === 'rowversion',
          isPrimaryKey: pkColumns.has(c.column_name),
          defaultValue: c.default_definition,
          collation: c.collation_name,
          columnId: c.column_id,
        };
      });

      tables.push({
        schema: first.schema_name,
        tableName: first.table_name,
        objectId,
        bcTableId,
        bcTableName: bcTableId !== null ? baseName : null,
        dataPerCompany: companyName !== null,
        companyName,
        baseName,
        primaryKey: pkIndex?.columns ?? [],
        secondaryKeys: tableIndexes.filter((i) => !i.isPrimaryKey),
        foreignKeys: fksByTable.get(objectId) ?? [],
        rowCount: rowCounts.get(objectId) ?? 0,
        fields,
      });
    }

    tables.sort((a, b) => a.tableName.localeCompare(b.tableName));
    return tables;
  }
}
