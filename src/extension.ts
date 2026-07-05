/**
 * VS Code extension entry point for CAL to AL.
 *
 * Wires conversion commands, the Activity Bar toolbox, and lifecycle cleanup.
 *
 * @module extension
 */

import * as vscode from 'vscode';
import { CMD_CONVERT_FROM_EXPLORER } from './constants';
import {
  initializeConversionService,
  killActiveChild,
  runConversionFromResources,
} from './conversionService';
import { registerToolbox } from './toolbox';

/**
 * Called when the extension is activated (first matching `activationEvents` command or view).
 *
 * Registers:
 * - Explorer context-menu conversion (`calToAl.convertFromExplorer`)
 * - Activity Bar toolbox and its sub-commands
 */
export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('C/AL to AL');
  initializeConversionService(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD_CONVERT_FROM_EXPLORER,
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const resources = uris && uris.length > 0 ? uris : uri ? [uri] : [];
        if (resources.length === 0) {
          vscode.window.showErrorMessage('No file or folder selected for conversion.');
          return;
        }
        return runConversionFromResources(context, resources);
      }
    )
  );

  registerToolbox(context);

  context.subscriptions.push(outputChannel);
}

/**
 * Called when the extension deactivates. Stops any running txt2al process.
 */
export function deactivate(): void {
  killActiveChild();
}
