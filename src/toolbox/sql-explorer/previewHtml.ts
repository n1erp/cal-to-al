/**
 * HTML shell for the table preview webview.
 *
 * @module sql-explorer/previewHtml
 */

import * as vscode from 'vscode';
import { AssetPaths } from '../../assetPaths';
import { buildWebviewHtml } from '../webviewHtml';

export function buildPreviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return buildWebviewHtml(webview, extensionUri, AssetPaths.sqlExplorer, 'Table Preview');
}
