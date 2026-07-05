import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  extensionAssetFsPath,
  extensionAssetUri,
  AssetPaths,
  webviewAssetUri,
} from '../../assetPaths';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Build the Conversion Wizard webview HTML for an editor-area {@link vscode.WebviewPanel}.
 */
export function buildWizardHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const styleUri = webviewAssetUri(webview, extensionUri, AssetPaths.conversionWizard.css);
  const scriptUri = webviewAssetUri(webview, extensionUri, AssetPaths.conversionWizard.js);

  const logoPath = extensionAssetFsPath(extensionUri, AssetPaths.icons.logo);
  let logoTag = '';
  if (fs.existsSync(logoPath)) {
    const logoUri = webview.asWebviewUri(extensionAssetUri(extensionUri, AssetPaths.icons.logo));
    logoTag = `<img class="logo" src="${logoUri}" alt="" />`;
  }

  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https:`,
  ].join('; ');

  const htmlPath = extensionAssetFsPath(extensionUri, AssetPaths.conversionWizard.html);
  let body = '';
  try {
    body = fs.readFileSync(htmlPath, 'utf8');
  } catch {
    body =
      '<main><p class="error">wizard.html not found in assets/conversion-wizard/.</p></main>';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Conversion Wizard</title>
</head>
<body>
  ${logoTag}
  ${body}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
