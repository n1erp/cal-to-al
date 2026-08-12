/**
 * Generates migration SQL per table mapping:
 * `INSERT INTO [db].[schema].[table] (...) SELECT ... FROM [db].[schema].[table]`
 * with identity handling and a transformation-rule hook per field.
 *
 * @module migration/queryGenerator
 */

import type { DatabaseMetadata } from '../../sql/types';
import { quoteIdent } from '../../sql/types';
import { isExcludedMigrationColumn, type MappingSet, type TableMapping } from './mappingEngine';

export interface GeneratedQuery {
  /** Fully qualified destination table (`[db].[schema].[table]`). */
  targetTable: string;
  /** Fully qualified source table. */
  sourceTable: string;
  /** The generated migration statement (single-server INSERT…SELECT shape). */
  sql: string;
  /** SELECT-only statement used by the cross-server bulk-copy path. */
  selectSql: string;
  /** Destination column list in insert order. */
  destinationColumns: string[];
  /** True when the destination table has an identity column that is mapped. */
  needsIdentityInsert: boolean;
  estimatedRows: number;
}

/** Render a field's SELECT expression, applying its transform rule if set. */
function fieldExpression(sourceColumn: string, transform?: string): string {
  const column = quoteIdent(sourceColumn);
  if (transform && transform.trim() !== '') {
    return transform.replace(/\{col\}/g, column);
  }
  return column;
}

function qualified(database: string, schema: string, table: string): string {
  return `${quoteIdent(database)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Generate the migration query for one enabled mapping.
 *
 * @param destinationMeta - Scanned destination metadata, used to detect
 *   identity columns for `SET IDENTITY_INSERT`.
 */
export function generateQuery(
  mapping: TableMapping,
  sourceDatabase: string,
  destinationDatabase: string,
  destinationMeta?: DatabaseMetadata
): GeneratedQuery {
  const included = mapping.fields.filter(
    (f) =>
      f.included &&
      !isExcludedMigrationColumn(f.sourceColumn) &&
      !isExcludedMigrationColumn(f.destinationColumn)
  );
  if (included.length === 0) {
    throw new Error(
      `Mapping ${mapping.source.table} → ${mapping.destination.table} has no included fields.`
    );
  }

  const targetTable = qualified(
    destinationDatabase,
    mapping.destination.schema,
    mapping.destination.table
  );
  const sourceTable = qualified(sourceDatabase, mapping.source.schema, mapping.source.table);

  const destColumns = included.map((f) => f.destinationColumn);
  const insertList = destColumns.map((c) => `    ${quoteIdent(c)}`).join(',\n');
  const selectList = included
    .map((f) => `    ${fieldExpression(f.sourceColumn, f.transform)}`)
    .join(',\n');

  // Identity handling: if any mapped destination column is an identity column,
  // wrap with SET IDENTITY_INSERT so explicit values are accepted.
  const destTableMeta = destinationMeta?.tables.find(
    (t) => t.schema === mapping.destination.schema && t.tableName === mapping.destination.table
  );
  const identityColumns = new Set(
    (destTableMeta?.fields ?? []).filter((f) => f.identity).map((f) => f.sqlColumn)
  );
  const needsIdentityInsert = destColumns.some((c) => identityColumns.has(c));

  const insertSelect = `INSERT INTO ${targetTable}\n(\n${insertList}\n)\nSELECT\n${selectList}\nFROM ${sourceTable};`;

  const sql = needsIdentityInsert
    ? `SET IDENTITY_INSERT ${targetTable} ON;\n${insertSelect}\nSET IDENTITY_INSERT ${targetTable} OFF;`
    : insertSelect;

  const selectSql = `SELECT\n${selectList}\nFROM ${quoteIdent(mapping.source.schema)}.${quoteIdent(mapping.source.table)}`;

  return {
    targetTable,
    sourceTable,
    sql,
    selectSql,
    destinationColumns: destColumns,
    needsIdentityInsert,
    estimatedRows: mapping.estimatedRows,
  };
}

/** Generate queries for every enabled mapping in a set. */
export function generateQueries(
  mappingSet: MappingSet,
  destinationMeta?: DatabaseMetadata
): { mapping: TableMapping; query: GeneratedQuery }[] {
  const results: { mapping: TableMapping; query: GeneratedQuery }[] = [];
  for (const mapping of mappingSet.mappings) {
    if (!mapping.enabled) {
      continue;
    }
    results.push({
      mapping,
      query: generateQuery(
        mapping,
        mappingSet.source.database,
        mappingSet.destination.database,
        destinationMeta
      ),
    });
  }
  return results;
}
