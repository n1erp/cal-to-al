import * as vscode from 'vscode';
import { TOOLBOX_VIEW_ID } from '../constants';
import { ToolboxTreeProvider } from './treeProvider';
import { registerConversionWizard } from './conversion-wizard';
import { registerCsidePrettier } from './cside-prettier';
import { registerDelta } from './delta-details';

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
}
