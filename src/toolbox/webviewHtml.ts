/**
 * Shared webview HTML shell builder used by the v4 SQL webviews
 * (table preview, database comparison, migration dashboard).
 *
 * @module toolbox/webviewHtml
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { extensionAssetFsPath, webviewAssetUri } from '../assetPaths';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export interface WebviewAssetSpec {
  html: string;
  css: string;
  js: string;
}

/** Build a CSP-safe HTML document from an `assets/<feature>/` triple. */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  assets: WebviewAssetSpec,
  title: string
): string {
  const styleUri = webviewAssetUri(webview, extensionUri, assets.css);
  const scriptUri = webviewAssetUri(webview, extensionUri, assets.js);
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  let body = '';
  try {
    body = fs.readFileSync(extensionAssetFsPath(extensionUri, assets.html), 'utf8');
  } catch {
    body = `<main><p class="error">${assets.html} not found.</p></main>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>${title}</title>
</head>
<body>
  ${body}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
