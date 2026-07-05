/**
 * C/Side Prettier — applies `cside-nav` TextMate syntax highlighting to NAV `.txt` exports.
 *
 * @module cside-prettier
 * @see ./README.md
 */

import * as vscode from 'vscode';
import { CMD_CAL_PRETTIER } from '../../constants';
import { runCalPrettier } from './command';

/**
 * Wire C/Side Prettier into `context.subscriptions`.
 *
 * Called from {@link ../index.registerToolbox} during extension activate.
 *
 * @param context - Extension context for disposables.
 */
export function registerCsidePrettier(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_CAL_PRETTIER, () => runCalPrettier())
  );
}
