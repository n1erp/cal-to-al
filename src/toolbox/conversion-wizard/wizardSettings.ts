/**
 * Read and persist `calToAl.*` workspace settings from the Conversion Wizard.
 *
 * @module conversion-wizard/wizardSettings
 */

import * as vscode from 'vscode';
import { CONFIG_NAMESPACE, CONVERSION_SETTINGS } from '../../constants';

/** Snapshot of conversion settings shown in the wizard Settings tab. */
export interface WizardSettings {
  type: string;
  extensionStartId: number;
  objectFileNamePattern: string;
  extensionObjectFileNamePattern: string;
  injectDotNetAddIns: boolean;
  dotNetAddInsPackage: string;
  dotNetTypePrefix: string;
  addLegacyTranslationInfo: boolean;
  runtime: string;
  dataClassificationDefaulting: string;
  tableDataOnly: boolean;
  verboseLogging: boolean;
  txt2alPath: string;
  logFilePath: string;
  objectMappingPath: string;
}

/** Load current `calToAl.*` values from the workspace configuration. */
export function readWizardSettings(): WizardSettings {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

  return {
    type: (cfg.get<string>(CONVERSION_SETTINGS.type) ?? '').trim(),
    extensionStartId: cfg.get<number>(CONVERSION_SETTINGS.extensionStartId) ?? 50000,
    objectFileNamePattern:
      (cfg.get<string>(CONVERSION_SETTINGS.objectFileNamePattern) ?? '{type}-{id}.{name}').trim(),
    extensionObjectFileNamePattern:
      (cfg.get<string>(CONVERSION_SETTINGS.extensionObjectFileNamePattern) ?? '{type}-{id}.{name}').trim(),
    injectDotNetAddIns: cfg.get<boolean>(CONVERSION_SETTINGS.injectDotNetAddIns) ?? false,
    dotNetAddInsPackage: (cfg.get<string>(CONVERSION_SETTINGS.dotNetAddInsPackage) ?? '').trim(),
    dotNetTypePrefix: (cfg.get<string>(CONVERSION_SETTINGS.dotNetTypePrefix) ?? '').trim(),
    addLegacyTranslationInfo: cfg.get<boolean>(CONVERSION_SETTINGS.addLegacyTranslationInfo) ?? false,
    runtime: (cfg.get<string>(CONVERSION_SETTINGS.runtime) ?? '').trim(),
    dataClassificationDefaulting:
      (cfg.get<string>(CONVERSION_SETTINGS.dataClassificationDefaulting) ?? '').trim(),
    tableDataOnly: cfg.get<boolean>(CONVERSION_SETTINGS.tableDataOnly) ?? false,
    verboseLogging: cfg.get<boolean>(CONVERSION_SETTINGS.verboseLogging) ?? true,
    txt2alPath: (cfg.get<string>(CONVERSION_SETTINGS.txt2alPath) ?? '').trim(),
    logFilePath: (cfg.get<string>(CONVERSION_SETTINGS.logFilePath) ?? '').trim(),
    objectMappingPath: (cfg.get<string>(CONVERSION_SETTINGS.objectMappingPath) ?? '').trim(),
  };
}

/**
 * Persist wizard settings to the workspace (or user scope when no folder is open).
 */
export async function writeWizardSettings(settings: WizardSettings): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  const updates: Array<[keyof typeof CONVERSION_SETTINGS, unknown]> = [
    [CONVERSION_SETTINGS.type, settings.type],
    [CONVERSION_SETTINGS.extensionStartId, settings.extensionStartId],
    [CONVERSION_SETTINGS.objectFileNamePattern, settings.objectFileNamePattern],
    [CONVERSION_SETTINGS.extensionObjectFileNamePattern, settings.extensionObjectFileNamePattern],
    [CONVERSION_SETTINGS.injectDotNetAddIns, settings.injectDotNetAddIns],
    [CONVERSION_SETTINGS.dotNetAddInsPackage, settings.dotNetAddInsPackage],
    [CONVERSION_SETTINGS.dotNetTypePrefix, settings.dotNetTypePrefix],
    [CONVERSION_SETTINGS.addLegacyTranslationInfo, settings.addLegacyTranslationInfo],
    [CONVERSION_SETTINGS.runtime, settings.runtime],
    [CONVERSION_SETTINGS.dataClassificationDefaulting, settings.dataClassificationDefaulting],
    [CONVERSION_SETTINGS.tableDataOnly, settings.tableDataOnly],
    [CONVERSION_SETTINGS.verboseLogging, settings.verboseLogging],
    [CONVERSION_SETTINGS.txt2alPath, settings.txt2alPath],
    [CONVERSION_SETTINGS.logFilePath, settings.logFilePath],
    [CONVERSION_SETTINGS.objectMappingPath, settings.objectMappingPath],
  ];

  for (const [key, value] of updates) {
    await cfg.update(key, value, target);
  }
}
