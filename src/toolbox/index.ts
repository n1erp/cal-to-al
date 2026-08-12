import * as vscode from 'vscode';
import { TOOLBOX_VIEW_ID } from '../constants';
import { createSqlServices } from '../sql';
import { ToolboxTreeProvider } from './treeProvider';
import { registerConversionWizard } from './conversion-wizard';
import { registerCsidePrettier } from './cside-prettier';
import { registerDbCompare, ComparisonStore } from './db-compare';
import { registerDelta } from './delta-details';
import { registerMigration } from './migration';
import { registerSqlExplorer } from './sql-explorer';

/**
 * Registers the Activity Bar toolbox and all toolbox feature modules.
 * Each subfolder owns one toolbox action (tree item + command + providers).
 */
export function registerToolbox(context: vscode.ExtensionContext): void {
  const toolboxProvider = new ToolboxTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(TOOLBOX_VIEW_ID, toolboxProvider)
  );

  registerConversionWizard(context);
  registerCsidePrettier(context);
  registerDelta(context);

  // Data Migration Studio (v4): shared SQL services + feature modules.
  const services = createSqlServices(context);
  registerSqlExplorer(context, services);
  const comparisonStore = new ComparisonStore();
  void comparisonStore.load();
  const migration = registerMigration(context, services, comparisonStore);
  registerDbCompare(context, services, comparisonStore);
}
