/**
 * User-facing C/Side Prettier command — applies `cside-nav` syntax highlighting.
 *
 * @module cside-prettier/command
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CSIDE_NAV_LANGUAGE_ID } from '../../constants';

/**
 * Open a `.txt` NAV export and switch it to `cside-nav` for TextMate highlighting.
 *
 * Shows a file picker, validates extension, sets language id, and opens the editor.
 * Does not modify file contents.
 */
export async function runCalPrettier(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'NAV C/AL export (.txt)': ['txt'] },
    openLabel: 'Select C/AL .txt file',
    title: 'C/Side Prettier — choose file to highlight',
  });

  if (!picked?.[0]) {
    return;
  }

  const uri = picked[0];
  if (!uri.fsPath.toLowerCase().endsWith('.txt')) {
    vscode.window.showWarningMessage('C/Side Prettier only supports .txt NAV export files.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, CSIDE_NAV_LANGUAGE_ID);
  await vscode.window.showTextDocument(doc, { preview: false });

  vscode.window.showInformationMessage(
    `C/Side Prettier: ${path.basename(uri.fsPath)} (syntax highlighting)`
  );
}
