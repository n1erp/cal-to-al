/**
 * Conversion Wizard as an editor-area {@link vscode.WebviewPanel} (not a sidebar view).
 *
 * @module conversion-wizard/wizardPanel
 */

import * as vscode from 'vscode';
import {
  getWorkspaceRoot,
  getDefaultTargetPath,
  openConversionLog,
  runConversionFromWizard,
  validateWizardConversionInput,
} from '../../conversionService';
import { extensionAssetUri, AssetPaths } from '../../assetPaths';
import { buildWizardHtml } from './wizardHtml';
import { readWizardSettings, writeWizardSettings } from './wizardSettings';
import type {
  WizardInboundMessage,
  WizardConvertPayload,
  WizardBrowsePayload,
  WizardBrowseField,
} from './messages';
import type { WizardSettings } from './wizardSettings';

/** `createWebviewPanel` view type id (must be stable across sessions). */
export const WIZARD_PANEL_VIEW_TYPE = 'calToAl.conversionWizard';

const WIZARD_PANEL_TITLE = 'Conversion Wizard';

const SETTING_PATH_FIELDS = new Set<WizardBrowseField>([
  'txt2alPath',
  'logFilePath',
  'objectMappingPath',
  'dotNetAddInsPackage',
]);

let wizardPanel: vscode.WebviewPanel | undefined;

/** Post a JSON message to the wizard webview. */
function post(webview: vscode.Webview, message: unknown): void {
  void webview.postMessage(message);
}

/** Update the wizard status line (`info` | `success` | `error`). */
function postStatus(
  webview: vscode.Webview,
  level: 'info' | 'success' | 'error',
  text: string
): void {
  post(webview, { command: 'status', data: { level, text } });
}

/** Send default output path, workspace root, and current settings after the webview loads. */
function sendInit(webview: vscode.Webview): void {
  const workspaceRoot = getWorkspaceRoot() ?? '';
  const defaultOutput = workspaceRoot ? getDefaultTargetPath(workspaceRoot) : '';

  post(webview, {
    command: 'init',
    data: {
      defaultOutput,
      workspaceRoot,
      settings: readWizardSettings(),
    },
  });
}

/** Run the full wizard pipeline from webview `convert` payload. */
async function handleConvert(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  data: WizardConvertPayload | undefined
): Promise<void> {
  if (!data) {
    postStatus(webview, 'error', 'Missing conversion parameters.');
    return;
  }

  const validation = validateWizardConversionInput(data);
  if (!validation.ok) {
    postStatus(webview, 'error', validation.message ?? 'Invalid input.');
    return;
  }

  postStatus(webview, 'info', 'Generating Delta…');
  post(webview, { command: 'converting', data: { active: true } });

  const ok = await runConversionFromWizard(context, data, (message) => {
    postStatus(webview, 'info', message);
  });

  post(webview, { command: 'converting', data: { active: false } });
  postStatus(
    webview,
    ok ? 'success' : 'error',
    ok ? 'Done! AL extension generated successfully.' : 'Pipeline failed. Check the log for details.'
  );
}

/** Persist settings from the Settings tab to workspace configuration. */
async function handleSaveSettings(
  webview: vscode.Webview,
  data: WizardSettings | undefined
): Promise<void> {
  if (!data) {
    postStatus(webview, 'error', 'Missing settings data.');
    return;
  }

  try {
    await writeWizardSettings(data);
    post(webview, { command: 'settingsSaved' });
  } catch (err) {
    postStatus(webview, 'error', `Could not save settings: ${String(err)}`);
  }
}

/** Open a native file/folder dialog and post the chosen path back to the webview. */
async function handleBrowse(
  webview: vscode.Webview,
  data: WizardBrowsePayload | undefined
): Promise<void> {
  if (!data?.field) {
    return;
  }

  const { field } = data;

  if (field === 'outputFile') {
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select output folder',
    });
    if (folders?.[0]) {
      post(webview, {
        command: 'pathSelected',
        data: { field, path: folders[0].fsPath },
      });
    }
    return;
  }

  if (SETTING_PATH_FIELDS.has(field)) {
    let filters: Record<string, string[]>;
    if (field === 'txt2alPath') {
      filters = { Executable: ['exe'] };
    } else if (field === 'objectMappingPath') {
      filters = { JSON: ['json'] };
    } else if (field === 'dotNetAddInsPackage') {
      filters = { AL: ['al'] };
    } else {
      filters = { 'Log files': ['log', 'txt'], 'All files': ['*'] };
    }

    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters,
      openLabel: 'Select file',
    });
    if (files?.[0]) {
      post(webview, {
        command: 'pathSelected',
        data: { field, path: files[0].fsPath },
      });
    }
    return;
  }

  const files = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'NAV C/AL export (.txt)': ['txt'] },
    openLabel: 'Select .txt export file',
    title:
      field === 'inputStandard'
        ? 'Standard NAV Objects (.txt)'
        : 'Customized NAV Objects (.txt)',
  });
  if (files?.[0]) {
    const selected = files[0].fsPath;
    if (!selected.toLowerCase().endsWith('.txt')) {
      vscode.window.showWarningMessage('Please select a .txt NAV export file.');
      return;
    }
    post(webview, {
      command: 'pathSelected',
      data: { field, path: selected },
    });
  }
}

/** Route inbound webview messages to handlers. */
async function onMessage(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  raw: unknown
): Promise<void> {
  const message = raw as WizardInboundMessage;
  if (!message?.command) {
    return;
  }

  switch (message.command) {
    case 'ready':
      sendInit(webview);
      break;
    case 'convert':
      await handleConvert(context, webview, message.data as WizardConvertPayload);
      break;
    case 'saveSettings':
      await handleSaveSettings(webview, message.data as WizardSettings);
      break;
    case 'viewLog':
      await openConversionLog();
      break;
    case 'close':
      wizardPanel?.dispose();
      break;
    case 'browse':
      await handleBrowse(webview, message.data as WizardBrowsePayload);
      break;
    default:
      break;
  }
}

/**
 * Open or focus the Conversion Wizard in the main editor area.
 *
 * @param context - Extension context for bundled assets and conversion.
 */
export function openConversionWizard(context: vscode.ExtensionContext): void {
  if (wizardPanel) {
    wizardPanel.reveal(vscode.ViewColumn.One, false);
    return;
  }

  wizardPanel = vscode.window.createWebviewPanel(
    WIZARD_PANEL_VIEW_TYPE,
    WIZARD_PANEL_TITLE,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        extensionAssetUri(context.extensionUri, AssetPaths.conversionWizard.folder),
        extensionAssetUri(context.extensionUri, AssetPaths.icons.folder),
      ],
    }
  );

  wizardPanel.iconPath = new vscode.ThemeIcon('wand');

  const { webview } = wizardPanel;
  webview.html = buildWizardHtml(webview, context.extensionUri);

  const messageDisposable = webview.onDidReceiveMessage((message) =>
    onMessage(context, webview, message)
  );

  wizardPanel.onDidDispose(() => {
    messageDisposable.dispose();
    wizardPanel = undefined;
  });
}
