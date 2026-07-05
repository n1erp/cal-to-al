import * as vscode from 'vscode';
import {
  CMD_CAL_PRETTIER,
  CMD_DELTA_DETAILS,
  CMD_OPEN_WIZARD,
} from '../constants';

/** Stable ids for toolbox tree items (used as `contextValue`). */
export type ToolboxActionId =
  | 'calPrettier'
  | 'conversionWizard'
  | 'deltaDetails';

interface ToolboxAction {
  id: ToolboxActionId;
  label: string;
  /** Shown on hover only (not as inline sidebar text). */
  tooltip: string;
  command: string;
  icon: string;
}

const TOOLBOX_ACTIONS: ToolboxAction[] = [
  {
    id: 'calPrettier',
    label: 'C/Side Prettier',
    tooltip: 'Open a NAV C/AL .txt export for syntax highlighting.',
    command: CMD_CAL_PRETTIER,
    icon: 'symbol-color',
  },
  {
    id: 'conversionWizard',
    label: 'Conversion Wizard',
    tooltip: 'Open the conversion setup wizard',
    command: CMD_OPEN_WIZARD,
    icon: 'wand',
  },
  {
    id: 'deltaDetails',
    label: 'Delta Details',
    tooltip: 'Compare old vs new object exports in the VS Code diff editor',
    command: CMD_DELTA_DETAILS,
    icon: 'diff',
  },
];

/** Single clickable row in the Activity Bar toolbox tree. */
export class ToolboxTreeItem extends vscode.TreeItem {
  constructor(action: ToolboxAction) {
    super(action.label, vscode.TreeItemCollapsibleState.None);
    this.id = action.id;
    this.tooltip = action.tooltip;
    this.iconPath = new vscode.ThemeIcon(action.icon);
    this.contextValue = action.id;
    this.command = {
      command: action.command,
      title: action.label,
    };
  }
}

/** Flat list of toolbox actions for {@link TOOLBOX_VIEW_ID}. */
export class ToolboxTreeProvider implements vscode.TreeDataProvider<ToolboxTreeItem> {
  getTreeItem(element: ToolboxTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ToolboxTreeItem[] {
    return TOOLBOX_ACTIONS.map((action) => new ToolboxTreeItem(action));
  }
}
