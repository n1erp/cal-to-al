import * as vscode from 'vscode';
import * as path from 'path';

/**
 * @module delta-details/deltaDetails
 */

/** Show a file picker filtered to `.txt` / `.al` exports. */
async function pickFile(title: string): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      'Text files': ['txt', 'al'],
      'All files': ['*'],
    },
    openLabel: title,
    title,
  });
  return picked?.[0];
}

/**
 * Compare two object export files in the native VS Code diff editor.
 */
export async function runDeltaDetails(): Promise<void> {
  const oldUri = await pickFile('Select OLD file (baseline)');
  if (!oldUri) {
    return;
  }

  const newUri = await pickFile('Select NEW file (current)');
  if (!newUri) {
    return;
  }

  const title = `${path.basename(oldUri.fsPath)} ↔ ${path.basename(newUri.fsPath)}`;
  await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, { preview: false });
}
