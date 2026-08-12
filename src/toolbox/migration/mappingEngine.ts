/**
 * Smart mapping engine: automatically pairs source and destination tables
 * (BC table id → name → fuzzy) and their fields (BC field id → name → fuzzy),
 * with support for manual overrides. Persisted to `.cal2al/mappings.json`.
 *
 * @module migration/mappingEngine
 */

import * as crypto from 'crypto';
import type { DatabaseMetadata, FieldMetadata, TableMetadata } from '../../sql/types';
import { matchTables } from '../db-compare/comparisonEngine';
import { normalizeName, similarity } from '../db-compare/fuzzy';

const FUZZY_FIELD_THRESHOLD = 0.85;

/** Destination/source columns never copied in INSERT…SELECT (BC system + timestamp). */
const EXCLUDED_MIGRATION_COLUMN_NAMES = new Set([
  'timestamp',
  '$systemid',
  '$systemcreatedat',
  '$systemcreatedby',
  '$systemmodifiedat',
  '$systemmodifiedby',
]);

/** True when a SQL column must be omitted from migration INSERT/SELECT lists. */
export function isExcludedMigrationColumn(columnName: string): boolean {
  return EXCLUDED_MIGRATION_COLUMN_NAMES.has(columnName.toLowerCase());
}

/** One source column → destination column pair inside a table mapping. */
export interface FieldMappingPair {
  sourceColumn: string;
  destinationColumn: string;
  /** Excluded pairs are skipped by the query generator. */
  included: boolean;
  /**
   * Optional SQL transformation expression applied to the source column.
   * `{col}` is replaced with the bracket-quoted source column. Defaults to
   * the plain column when absent — the hook for future transformation rules.
   */
  transform?: string;
  matchedBy: 'bc-id' | 'name' | 'fuzzy' | 'manual';
}

export interface TableEndpoint {
  schema: string;
  table: string;
}

export interface TableMapping {
  id: string;
  enabled: boolean;
  matchedBy: 'bc-id' | 'name' | 'fuzzy' | 'manual';
  confidence: number;
  source: TableEndpoint;
  destination: TableEndpoint;
  fields: FieldMappingPair[];
  estimatedRows: number;
  /** Destination columns that exist but received no source pair. */
  unmappedDestinationColumns: string[];
}

export interface DatabaseEndpoint {
  connectionId: string;
  connectionName: string;
  server: string;
  database: string;
}

export interface MappingSet {
  version: 1;
  createdAt: string;
  source: DatabaseEndpoint;
  destination: DatabaseEndpoint;
  mappings: TableMapping[];
}

function endpoint(meta: DatabaseMetadata): DatabaseEndpoint {
  return {
    connectionId: meta.connectionId,
    connectionName: meta.connectionName,
    server: meta.server,
    database: meta.database,
  };
}

/** True for columns whose values the server generates (never insertable). */
function isNonInsertable(field: FieldMetadata): boolean {
  return (
    isExcludedMigrationColumn(field.sqlColumn) ||
    field.sqlType === 'timestamp' ||
    field.sqlType === 'rowversion' ||
    (field.autoIncrement && !field.identity)
  );
}

/** Pair fields of one matched table: BC field id → exact name → fuzzy name. */
export function matchFields(
  source: TableMetadata,
  destination: TableMetadata
): { pairs: FieldMappingPair[]; unmappedDestination: string[] } {
  const pairs: FieldMappingPair[] = [];
  const remainingDest = destination.fields.filter((f) => !isNonInsertable(f));
  const destByFieldId = new Map<number, FieldMetadata>();
  const destByName = new Map<string, FieldMetadata>();
  for (const f of remainingDest) {
    if (f.fieldId !== null && !destByFieldId.has(f.fieldId)) {
      destByFieldId.set(f.fieldId, f);
    }
    const key = normalizeName(f.sqlColumn);
    if (!destByName.has(key)) {
      destByName.set(key, f);
    }
  }

  const taken = new Set<FieldMetadata>();
  const fuzzyQueue: FieldMetadata[] = [];

  for (const sf of source.fields) {
    if (isNonInsertable(sf)) {
      continue;
    }
    // 1) BC field id.
    if (sf.fieldId !== null) {
      const hit = destByFieldId.get(sf.fieldId);
      if (hit && !taken.has(hit)) {
        taken.add(hit);
        pairs.push({
          sourceColumn: sf.sqlColumn,
          destinationColumn: hit.sqlColumn,
          included: true,
          matchedBy: 'bc-id',
        });
        continue;
      }
    }
    // 2) Exact normalized name.
    const hit = destByName.get(normalizeName(sf.sqlColumn));
    if (hit && !taken.has(hit)) {
      taken.add(hit);
      pairs.push({
        sourceColumn: sf.sqlColumn,
        destinationColumn: hit.sqlColumn,
        included: true,
        matchedBy: 'name',
      });
      continue;
    }
    fuzzyQueue.push(sf);
  }

  // 3) Fuzzy, best score first.
  const scored: { sf: FieldMetadata; df: FieldMetadata; score: number }[] = [];
  for (const sf of fuzzyQueue) {
    for (const df of remainingDest) {
      if (taken.has(df)) {
        continue;
      }
      const score = similarity(sf.sqlColumn, df.sqlColumn);
      if (score >= FUZZY_FIELD_THRESHOLD) {
        scored.push({ sf, df, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const fuzzyTaken = new Set<FieldMetadata>();
  for (const { sf, df } of scored) {
    if (fuzzyTaken.has(sf) || taken.has(df)) {
      continue;
    }
    fuzzyTaken.add(sf);
    taken.add(df);
    pairs.push({
      sourceColumn: sf.sqlColumn,
      destinationColumn: df.sqlColumn,
      included: true,
      matchedBy: 'fuzzy',
    });
  }

  const unmappedDestination = remainingDest
    .filter((f) => !taken.has(f))
    .map((f) => f.sqlColumn);

  return { pairs, unmappedDestination };
}

/** Build the full auto-generated mapping set for two scanned databases. */
export function buildMappingSet(
  source: DatabaseMetadata,
  destination: DatabaseMetadata
): MappingSet {
  const { pairs } = matchTables(source.tables, destination.tables);

  const mappings: TableMapping[] = pairs.map((pair) => {
    const fieldResult = matchFields(pair.source, pair.destination);
    return {
      id: crypto.randomUUID(),
      enabled: fieldResult.pairs.some((p) => p.included),
      matchedBy: pair.matchedBy,
      confidence: pair.confidence,
      source: { schema: pair.source.schema, table: pair.source.tableName },
      destination: {
        schema: pair.destination.schema,
        table: pair.destination.tableName,
      },
      fields: fieldResult.pairs,
      estimatedRows: pair.source.rowCount,
      unmappedDestinationColumns: fieldResult.unmappedDestination,
    };
  });

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    source: endpoint(source),
    destination: endpoint(destination),
    mappings,
  };
}
