/**
 * HTML shell for the SSMS-style Connect to Server webview.
 *
 * @module sql-explorer/connectHtml
 */

import * as vscode from 'vscode';
import { AssetPaths } from '../../assetPaths';
import { buildWebviewHtml } from '../webviewHtml';

export function buildConnectHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return buildWebviewHtml(webview, extensionUri, AssetPaths.sqlConnect, 'Connect to Server');
}
