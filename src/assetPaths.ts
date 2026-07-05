import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Relative paths to webview and icon assets under `assets/`.
 *
 * Folder layout mirrors `src/toolbox/` so contributors can find files quickly.
 */
export const AssetPaths = {
  root: 'assets',
  icons: {
    folder: 'assets/icons',
    logo: 'assets/icons/logo.png',
  },
  conversionWizard: {
    folder: 'assets/conversion-wizard',
    html: 'assets/conversion-wizard/wizard.html',
    css: 'assets/conversion-wizard/wizard.css',
    js: 'assets/conversion-wizard/wizard.js',
  },
} as const;

/**
 * Resolve a path relative to the extension install directory.
 */
export function extensionAssetUri(extensionUri: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, ...relativePath.split('/'));
}

/**
 * Same as {@link extensionAssetUri} but returns a filesystem path string.
 */
export function extensionAssetFsPath(extensionUri: vscode.Uri, relativePath: string): string {
  return path.join(extensionUri.fsPath, ...relativePath.split('/'));
}

/**
 * Convert an extension asset path into a URI the webview is allowed to load.
 */
export function webviewAssetUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  relativePath: string
): vscode.Uri {
  return webview.asWebviewUri(extensionAssetUri(extensionUri, relativePath));
}
