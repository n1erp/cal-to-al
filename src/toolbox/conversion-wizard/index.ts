/**
 * Conversion Wizard toolbox module.
 *
 * Opens the wizard in an **editor tab** ({@link openConversionWizard}), not the sidebar.
 *
 * @module conversion-wizard
 */

import * as vscode from 'vscode';
import { CMD_OPEN_WIZARD } from '../../constants';
import { openConversionWizard } from './wizardPanel';

/**
 * Register the command that opens the wizard editor panel.
 */
export function registerConversionWizard(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_OPEN_WIZARD, () => openConversionWizard(context))
  );
}
