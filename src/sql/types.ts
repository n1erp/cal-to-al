/**
 * Shared type definitions for the SQL / data-migration layer.
 *
 * @module sql/types
 */

/** Supported SQL Server authentication modes. */
export type SqlAuthMode = 'sql' | 'ntlm';

/** A saved SQL Server connection profile (password lives in SecretStorage). */
export interface ConnectionProfile {
  /** Stable unique id (uuid). */
  id: string;
  /** Display name shown in the SQL Explorer. */
  name: string;
  /** Host name or host\instance. */
  server: string;
  /** TCP port (default 1433). */
  port?: number;
  /** 'sql' = SQL authentication, 'ntlm' = Windows authentication with explicit credentials. */
  authMode: SqlAuthMode;
  /** Login (SQL auth) or Windows user name (NTLM). */
  username: string;
  /** Windows domain (NTLM only). */
  domain?: string;
  /** Encrypt the connection. */
  encrypt: boolean;
  /** Trust self-signed server certificates. */
  trustServerCertificate: boolean;
}

/** Foreign key definition on a table. */
export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

/** Index / key definition (primary or secondary). */
export interface IndexInfo {
  name: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
  columns: string[];
}

/** Metadata for a single table column, enriched with BC information when available. */
export interface FieldMetadata {
  /** Business Central / NAV field id (null when not resolvable). */
  fieldId: number | null;
  /** Logical field name (BC field name when known, otherwise the SQL column name). */
  fieldName: string;
  /** Physical SQL column name. */
  sqlColumn: string;
  /** Base SQL type name, e.g. 'nvarchar'. */
  sqlType: string;
  /** Full SQL type with size/precision, e.g. 'nvarchar(50)' or 'decimal(38,20)'. */
  sqlTypeFull: string;
  /** Inferred Business Central data type (Code, Text, Integer, Decimal, ...). */
  bcType: string | null;
  /** Character length for string types (null otherwise). */
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  identity: boolean;
  /** True when the column value is auto-generated (identity, computed or timestamp). */
  autoIncrement: boolean;
  isPrimaryKey: boolean;
  defaultValue: string | null;
  collation: string | null;
  /** Ordinal column id inside the table. */
  columnId: number;
}

/** Metadata for a single table, enriched with BC information when available. */
export interface TableMetadata {
  schema: string;
  /** Physical SQL table name (may include the company prefix). */
  tableName: string;
  /** SQL object id. */
  objectId: number;
  /** Business Central table id (from the NAV Object / BC metadata tables), null when unknown. */
  bcTableId: number | null;
  /** Business Central table name, null when unknown. */
  bcTableName: string | null;
  /** True when the table is per-company (physical name is `Company$Table`). */
  dataPerCompany: boolean;
  /** Company prefix when {@link dataPerCompany} is true. */
  companyName: string | null;
  /** Table name with the company prefix stripped (equals tableName otherwise). */
  baseName: string;
  /** Primary key column names in key order. */
  primaryKey: string[];
  /** Non-primary indexes. */
  secondaryKeys: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  rowCount: number;
  fields: FieldMetadata[];
}

/** Simple descriptor for views and stored procedures in the explorer. */
export interface DbObjectInfo {
  schema: string;
  name: string;
}

/** Full metadata model for one database, produced by the MetadataScanner. */
export interface DatabaseMetadata {
  connectionId: string;
  connectionName: string;
  server: string;
  database: string;
  /** ISO timestamp of the scan. */
  scannedAt: string;
  /** Companies found in the `Company` table (empty for non-NAV databases). */
  companies: string[];
  tables: TableMetadata[];
  views: DbObjectInfo[];
  procedures: DbObjectInfo[];
}

/** A reference to a database on a saved connection. */
export interface DatabaseRef {
  connectionId: string;
  database: string;
}

/** Quotes an identifier with square brackets, escaping embedded brackets. */
export function quoteIdent(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

/** Builds a fully qualified, bracket-quoted `[db].[schema].[table]` name. */
export function qualifiedName(database: string, schema: string, table: string): string {
  return `${quoteIdent(database)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
}
