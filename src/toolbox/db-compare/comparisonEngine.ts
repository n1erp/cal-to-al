/**
 * Compares two database metadata models and produces a structured report:
 * table presence / rename detection and per-table field differences.
 *
 * @module db-compare/comparisonEngine
 */

import type { DatabaseMetadata, FieldMetadata, TableMetadata } from '../../sql/types';
import { normalizeName, similarity } from './fuzzy';

export const FUZZY_TABLE_THRESHOLD = 0.8;

export type FieldDiffKind =
  | 'missing-in-source'
  | 'missing-in-destination'
  | 'sql-type'
  | 'bc-type'
  | 'nullable'
  | 'primary-key';

export interface FieldDiff {
  fieldName: string;
  kind: FieldDiffKind;
  sourceValue: string | null;
  destinationValue: string | null;
}

export interface TableComparison {
  /** How the pair was matched. */
  matchedBy: 'bc-id' | 'name' | 'fuzzy';
  /** Fuzzy similarity (1 for exact matches). */
  confidence: number;
  source: TableRef;
  destination: TableRef;
  fieldsInBoth: number;
  fieldDiffs: FieldDiff[];
}

export interface TableRef {
  schema: string;
  tableName: string;
  bcTableId: number | null;
  rowCount: number;
  fieldCount: number;
}

export interface ComparisonReport {
  source: { connectionId: string; connectionName: string; database: string };
  destination: { connectionId: string; connectionName: string; database: string };
  comparedAt: string;
  matched: TableComparison[];
  missingInSource: TableRef[];
  missingInDestination: TableRef[];
}

function toRef(t: TableMetadata): TableRef {
  return {
    schema: t.schema,
    tableName: t.tableName,
    bcTableId: t.bcTableId,
    rowCount: t.rowCount,
    fieldCount: t.fields.length,
  };
}

/** Matches source tables to destination tables by BC id → name → fuzzy name. */
export function matchTables(
  sourceTables: TableMetadata[],
  destinationTables: TableMetadata[]
): {
  pairs: { source: TableMetadata; destination: TableMetadata; matchedBy: 'bc-id' | 'name' | 'fuzzy'; confidence: number }[];
  unmatchedSource: TableMetadata[];
  unmatchedDestination: TableMetadata[];
} {
  const pairs: {
    source: TableMetadata;
    destination: TableMetadata;
    matchedBy: 'bc-id' | 'name' | 'fuzzy';
    confidence: number;
  }[] = [];

  const remainingDest = new Set(destinationTables);
  const unmatchedSource: TableMetadata[] = [];

  // Index destination by BC id and normalized name.
  const destByBcId = new Map<number, TableMetadata[]>();
  const destByName = new Map<string, TableMetadata[]>();
  for (const t of destinationTables) {
    if (t.bcTableId !== null) {
      const list = destByBcId.get(t.bcTableId) ?? [];
      list.push(t);
      destByBcId.set(t.bcTableId, list);
    }
    const key = normalizeName(t.baseName);
    const list = destByName.get(key) ?? [];
    list.push(t);
    destByName.set(key, list);
  }

  const takeCandidate = (candidates: TableMetadata[] | undefined, source: TableMetadata) => {
    if (!candidates) {
      return undefined;
    }
    // Prefer a candidate from the same company when both are per-company.
    const available = candidates.filter((c) => remainingDest.has(c));
    if (available.length === 0) {
      return undefined;
    }
    return (
      available.find((c) => c.companyName === source.companyName) ?? available[0]
    );
  };

  const fuzzySource: TableMetadata[] = [];

  for (const source of sourceTables) {
    // 1) BC table id.
    if (source.bcTableId !== null) {
      const hit = takeCandidate(destByBcId.get(source.bcTableId), source);
      if (hit) {
        remainingDest.delete(hit);
        pairs.push({ source, destination: hit, matchedBy: 'bc-id', confidence: 1 });
        continue;
      }
    }
    // 2) Exact (normalized) name.
    const hit = takeCandidate(destByName.get(normalizeName(source.baseName)), source);
    if (hit) {
      remainingDest.delete(hit);
      pairs.push({ source, destination: hit, matchedBy: 'name', confidence: 1 });
      continue;
    }
    fuzzySource.push(source);
  }

  // 3) Fuzzy best-match on what's left (greedy, best score first).
  const scored: { source: TableMetadata; destination: TableMetadata; score: number }[] = [];
  for (const source of fuzzySource) {
    for (const dest of remainingDest) {
      const score = similarity(source.baseName, dest.baseName);
      if (score >= FUZZY_TABLE_THRESHOLD) {
        scored.push({ source, destination: dest, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const fuzzyMatched = new Set<TableMetadata>();
  for (const entry of scored) {
    if (fuzzyMatched.has(entry.source) || !remainingDest.has(entry.destination)) {
      continue;
    }
    fuzzyMatched.add(entry.source);
    remainingDest.delete(entry.destination);
    pairs.push({
      source: entry.source,
      destination: entry.destination,
      matchedBy: 'fuzzy',
      confidence: entry.score,
    });
  }

  for (const source of fuzzySource) {
    if (!fuzzyMatched.has(source)) {
      unmatchedSource.push(source);
    }
  }

  return { pairs, unmatchedSource, unmatchedDestination: [...remainingDest] };
}

/** Field-level diff between two matched tables. */
export function diffFields(source: TableMetadata, destination: TableMetadata): {
  inBoth: number;
  diffs: FieldDiff[];
} {
  const diffs: FieldDiff[] = [];
  const destFields = new Map<string, FieldMetadata>();
  for (const f of destination.fields) {
    destFields.set(normalizeName(f.sqlColumn), f);
  }

  let inBoth = 0;
  const seenDest = new Set<FieldMetadata>();

  for (const sf of source.fields) {
    const df = destFields.get(normalizeName(sf.sqlColumn));
    if (!df) {
      diffs.push({
        fieldName: sf.sqlColumn,
        kind: 'missing-in-destination',
        sourceValue: sf.sqlTypeFull,
        destinationValue: null,
      });
      continue;
    }
    seenDest.add(df);
    inBoth += 1;
    if (sf.sqlTypeFull !== df.sqlTypeFull) {
      diffs.push({
        fieldName: sf.sqlColumn,
        kind: 'sql-type',
        sourceValue: sf.sqlTypeFull,
        destinationValue: df.sqlTypeFull,
      });
    }
    if ((sf.bcType ?? '') !== (df.bcType ?? '')) {
      diffs.push({
        fieldName: sf.sqlColumn,
        kind: 'bc-type',
        sourceValue: sf.bcType,
        destinationValue: df.bcType,
      });
    }
    if (sf.nullable !== df.nullable) {
      diffs.push({
        fieldName: sf.sqlColumn,
        kind: 'nullable',
        sourceValue: sf.nullable ? 'NULL' : 'NOT NULL',
        destinationValue: df.nullable ? 'NULL' : 'NOT NULL',
      });
    }
    if (sf.isPrimaryKey !== df.isPrimaryKey) {
      diffs.push({
        fieldName: sf.sqlColumn,
        kind: 'primary-key',
        sourceValue: sf.isPrimaryKey ? 'PK' : '—',
        destinationValue: df.isPrimaryKey ? 'PK' : '—',
      });
    }
  }

  for (const df of destination.fields) {
    if (!seenDest.has(df)) {
      diffs.push({
        fieldName: df.sqlColumn,
        kind: 'missing-in-source',
        sourceValue: null,
        destinationValue: df.sqlTypeFull,
      });
    }
  }

  return { inBoth, diffs };
}

/** Full comparison of two database metadata models. */
export function compareDatabases(
  source: DatabaseMetadata,
  destination: DatabaseMetadata
): ComparisonReport {
  const { pairs, unmatchedSource, unmatchedDestination } = matchTables(
    source.tables,
    destination.tables
  );

  const matched: TableComparison[] = pairs.map((pair) => {
    const { inBoth, diffs } = diffFields(pair.source, pair.destination);
    return {
      matchedBy: pair.matchedBy,
      confidence: pair.confidence,
      source: toRef(pair.source),
      destination: toRef(pair.destination),
      fieldsInBoth: inBoth,
      fieldDiffs: diffs,
    };
  });

  return {
    source: {
      connectionId: source.connectionId,
      connectionName: source.connectionName,
      database: source.database,
    },
    destination: {
      connectionId: destination.connectionId,
      connectionName: destination.connectionName,
      database: destination.database,
    },
    comparedAt: new Date().toISOString(),
    matched,
    // "Missing in source" = exists only in destination, and vice versa.
    missingInSource: unmatchedDestination.map(toRef),
    missingInDestination: unmatchedSource.map(toRef),
  };
}
