/**
 * Delta Details toolbox module — compare two NAV object exports in the diff editor.
 *
 * @module delta-details
 */

import * as vscode from 'vscode';
import { CMD_DELTA_DETAILS } from '../../constants';
import { runDeltaDetails } from './deltaDetails';

/** Register the Delta Details toolbox command. */
export function registerDelta(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_DELTA_DETAILS, () => runDeltaDetails())
  );
}
