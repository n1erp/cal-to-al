/**
 * Builds a migration plan aligned with a saved database comparison report.
 *
 * @module migration/planFromComparison
 */

import * as vscode from 'vscode';
import type { ComparisonReport, TableComparison } from '../db-compare/comparisonEngine';
import type { SqlServices } from '../../sql';
import type { DatabaseMetadata } from '../../sql/types';
import { buildMappingSet, type TableMapping } from './mappingEngine';
import type { PlanStore } from './planStore';

function tablePairKey(
  sourceSchema: string,
  sourceTable: string,
  destSchema: string,
  destTable: string
): string {
  return `${sourceSchema}.${sourceTable}|${destSchema}.${destTable}`;
}

function comparisonMetaMap(report: ComparisonReport): Map<string, TableComparison> {
  const map = new Map<string, TableComparison>();
  for (const row of report.matched) {
    map.set(
      tablePairKey(
        row.source.schema,
        row.source.tableName,
        row.destination.schema,
        row.destination.tableName
      ),
      row
    );
  }
  return map;
}

function endpointsMatchReport(
  source: DatabaseMetadata,
  destination: DatabaseMetadata,
  report: ComparisonReport
): boolean {
  return (
    source.connectionId === report.source.connectionId &&
    source.database === report.source.database &&
    destination.connectionId === report.destination.connectionId &&
    destination.database === report.destination.database
  );
}

/**
 * Scan the databases referenced in the comparison, map only matched tables,
 * and attach field-diff metadata from the report to each plan entry.
 */
export async function createMigrationPlanFromComparison(
  services: SqlServices,
  planStore: PlanStore,
  report: ComparisonReport
): Promise<boolean> {
  if (report.matched.length === 0) {
    vscode.window.showWarningMessage(
      'The comparison has no tables in both databases. Nothing to migrate.'
    );
    return false;
  }

  let source: DatabaseMetadata;
  let destination: DatabaseMetadata;
  try {
    [source, destination] = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Scanning databases for migration plan…',
      },
      () =>
        Promise.all([
          services.scanner.scan(report.source.connectionId, report.source.database),
          services.scanner.scan(report.destination.connectionId, report.destination.database),
        ])
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not scan databases: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }

  if (!endpointsMatchReport(source, destination, report)) {
    const refresh = await vscode.window.showWarningMessage(
      'The saved comparison does not match the current database connections. Re-run ' +
        'Create Database Comparison, or continue with a plan from the latest scan?',
      'Continue',
      'Cancel'
    );
    if (refresh !== 'Continue') {
      return false;
    }
  }

  const metaByTable = comparisonMetaMap(report);
  const allowedKeys = new Set(metaByTable.keys());

  const mappingSet = buildMappingSet(source, destination);
  mappingSet.mappings = mappingSet.mappings.filter((m) =>
    allowedKeys.has(
      tablePairKey(m.source.schema, m.source.table, m.destination.schema, m.destination.table)
    )
  );

  const mapped = mappingSet.mappings.filter((m) => m.enabled).length;
  if (mapped === 0) {
    vscode.window.showWarningMessage(
      'No table mappings could be built from the comparison matched tables.'
    );
    return false;
  }

  await planStore.createFromMappings(mappingSet, destination, {
    comparisonComparedAt: report.comparedAt,
    resolveComparisonMeta: (mapping: TableMapping) => {
      const comp = metaByTable.get(
        tablePairKey(
          mapping.source.schema,
          mapping.source.table,
          mapping.destination.schema,
          mapping.destination.table
        )
      );
      const fieldDiffs = comp?.fieldDiffs ?? [];
      return {
        field_diff_count: fieldDiffs.length,
        field_diffs: fieldDiffs,
        table_matched_by: comp?.matchedBy ?? mapping.matchedBy,
        mapping_complete:
          fieldDiffs.length === 0 && mapping.unmappedDestinationColumns.length === 0,
      };
    },
  });

  services.output.appendLine(
    `[plan] Created from comparison (${report.comparedAt}): ${mapped} table(s), ` +
      `${source.database} → ${destination.database}`
  );
  vscode.window.showInformationMessage(
    `Migration plan created from comparison (${mapped} matched tables).`
  );
  return true;
}
