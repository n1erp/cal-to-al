/**
 * Messages sent between the Conversion Wizard webview and the extension host.
 *
 * @see wizardPanel.ts
 */

import type { WizardSettings } from './wizardSettings';

export type WizardInboundCommand =
  | 'ready'
  | 'convert'
  | 'viewLog'
  | 'close'
  | 'browse'
  | 'saveSettings';

export interface WizardConvertPayload {
  inputStandard: string;
  inputCustomized: string;
  outputFile: string;
}

export type WizardBrowseField =
  | 'inputStandard'
  | 'inputCustomized'
  | 'outputFile'
  | 'txt2alPath'
  | 'logFilePath'
  | 'objectMappingPath'
  | 'dotNetAddInsPackage';

export interface WizardBrowsePayload {
  field: WizardBrowseField;
}

export interface WizardInboundMessage {
  command: WizardInboundCommand;
  data?: WizardConvertPayload | WizardBrowsePayload | WizardSettings;
}

export type WizardOutboundCommand =
  | 'init'
  | 'status'
  | 'pathSelected'
  | 'converting'
  | 'settingsSaved';

export interface WizardInitPayload {
  defaultOutput: string;
  workspaceRoot: string;
  settings: WizardSettings;
}

export interface WizardStatusPayload {
  level: 'info' | 'success' | 'error';
  text: string;
}

export interface WizardPathSelectedPayload {
  field: WizardBrowseField;
  path: string;
}

export interface WizardOutboundMessage {
  command: WizardOutboundCommand;
  data?: WizardInitPayload | WizardStatusPayload | WizardPathSelectedPayload;
}
