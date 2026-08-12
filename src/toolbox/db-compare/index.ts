/**
 * Database comparison feature module.
 *
 * @module db-compare
 */

import type * as vscode from 'vscode';
import { CMD_SQL_COMPARE_DATABASES } from '../../constants';
import type { SqlServices } from '../../sql';
import { ComparisonStore } from './comparisonStore';
import { registerComparisonDashboardCommands } from './comparePanel';

export { compareDatabases } from './comparisonEngine';
export type { ComparisonReport } from './comparisonEngine';
export { ComparisonStore } from './comparisonStore';

export function registerDbCompare(
  context: vscode.ExtensionContext,
  services: SqlServices,
  store: ComparisonStore
): ComparisonStore {
  context.subscriptions.push(store);
  registerComparisonDashboardCommands(context, services, store, CMD_SQL_COMPARE_DATABASES);
  return store;
}
