/**
 * Migration feature module: mapping engine, plan store, execution engine,
 * and dashboard registration.
 *
 * @module migration
 */

import * as vscode from 'vscode';
import { CMD_SQL_CREATE_COMPARISON, CMD_SQL_CREATE_PLAN, CMD_SQL_OPEN_DASHBOARD } from '../../constants';
import type { SqlServices } from '../../sql';
import type { ComparisonStore } from '../db-compare/comparisonStore';
import { openMigrationDashboard } from './dashboardPanel';
import { ExecutionEngine } from './executionEngine';
import { createMigrationPlanFromComparison } from './planFromComparison';
import { PlanStore } from './planStore';

export interface MigrationModule {
  planStore: PlanStore;
  engine: ExecutionEngine;
  createPlanFromComparison: () => Promise<boolean>;
}

export function registerMigration(
  context: vscode.ExtensionContext,
  services: SqlServices,
  comparisonStore: ComparisonStore
): MigrationModule {
  const planStore = new PlanStore();
  const engine = new ExecutionEngine(services, planStore);
  context.subscriptions.push(planStore, engine);

  void planStore.load();

  const createPlanFromComparison = async (): Promise<boolean> => {
    if (!comparisonStore.getReport()) {
      await comparisonStore.load();
    }
    const report = comparisonStore.getReport();
    if (!report) {
      const pick = await vscode.window.showWarningMessage(
        'No database comparison found. Run CAL to AL: Create Database Comparison first.',
        'Create Database Comparison',
        'Cancel'
      );
      if (pick === 'Create Database Comparison') {
        await vscode.commands.executeCommand(CMD_SQL_CREATE_COMPARISON);
      }
      return false;
    }
    const ok = await createMigrationPlanFromComparison(services, planStore, report);
    if (ok) {
      openMigrationDashboard(
        context,
        services,
        planStore,
        engine,
        comparisonStore,
        createPlanFromComparison
      );
    }
    return ok;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_SQL_OPEN_DASHBOARD, async () => {
      if (!planStore.getPlan()) {
        await planStore.load();
      }
      if (!comparisonStore.getReport()) {
        await comparisonStore.load();
      }
      openMigrationDashboard(
        context,
        services,
        planStore,
        engine,
        comparisonStore,
        createPlanFromComparison
      );
    }),

    vscode.commands.registerCommand(CMD_SQL_CREATE_PLAN, () => createPlanFromComparison())
  );

  return { planStore, engine, createPlanFromComparison };
}
