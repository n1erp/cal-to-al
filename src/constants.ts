/**
 * Shared identifiers for commands, views, paths, and VS Code setting keys.
 *
 * Keep values in sync with `package.json` (`contributes.commands`, `views`, `configuration`).
 */

/** VS Code settings namespace (`calToAl.*`). */
export const CONFIG_NAMESPACE = 'calToAl';

/** Toolbox TreeView id — must match `package.json` → `contributes.views`. */
export const TOOLBOX_VIEW_ID = 'calToAl.toolbox';

/** SQL Explorer TreeView id — must match `package.json` → `contributes.views`. */
export const SQL_EXPLORER_VIEW_ID = 'calToAl.sqlExplorer';

/** TextMate language id for NAV C/AL `.txt` exports (C/Side Prettier). */
export const CSIDE_NAV_LANGUAGE_ID = 'cside-nav';

// ── Command ids (must match package.json → contributes.commands) ──────────────

export const CMD_OPEN_WIZARD = 'calToAl.openWizard';
export const CMD_CAL_PRETTIER = 'calToAl.runCalPrettier';
export const CMD_DELTA_DETAILS = 'calToAl.deltaDetails';
/** Explorer context menu: convert selected `.txt` files or folders. */
export const CMD_CONVERT_FROM_EXPLORER = 'calToAl.convertFromExplorer';

// ── Data Migration Studio (v4) command ids ────────────────────────────────────

export const CMD_SQL_OPEN_EXPLORER = 'calToAl.sql.openExplorer';
export const CMD_SQL_ADD_CONNECTION = 'calToAl.sql.addConnection';
export const CMD_SQL_EDIT_CONNECTION = 'calToAl.sql.editConnection';
export const CMD_SQL_DELETE_CONNECTION = 'calToAl.sql.deleteConnection';
export const CMD_SQL_REFRESH_EXPLORER = 'calToAl.sql.refreshExplorer';
export const CMD_SQL_PREVIEW_TABLE = 'calToAl.sql.previewTable';
export const CMD_SQL_EXPORT_TABLE = 'calToAl.sql.exportTable';
export const CMD_SQL_COMPARE_DATABASES = 'calToAl.sql.compareDatabases';
export const CMD_SQL_CREATE_COMPARISON = 'calToAl.sql.createDatabaseComparison';
export const CMD_SQL_OPEN_DASHBOARD = 'calToAl.sql.openMigrationDashboard';
export const CMD_SQL_CREATE_PLAN = 'calToAl.sql.createMigrationPlan';

/** `dataMigration.*` settings keys. */
export const MIGRATION_CONFIG_NAMESPACE = 'dataMigration';
export const MIGRATION_SETTINGS = {
  batchSize: 'batchSize',
  queryTimeoutSeconds: 'queryTimeoutSeconds',
  planFolder: 'planFolder',
} as const;

/** Workspace-relative folder for migration artifacts (plan + mappings). */
export const MIGRATION_DIR = '.cal2al';
export const MIGRATION_PLAN_FILE = 'migration-plan.json';
export const MIGRATION_MAPPINGS_FILE = 'mappings.json';
export const MIGRATION_COMPARISON_FILE = 'database-comparison.json';

// ── Bundled tool file names ───────────────────────────────────────────────────

export const EXECUTABLE_NAMES = {
  TXT2AL_WINDOWS: 'Txt2Al.exe',
} as const;

// ── Directory and file names used at runtime ──────────────────────────────────

export const DIRECTORY_NAMES = {
  /** Workspace-relative folder searched for Txt2Al.exe and object-mapping.json. */
  WORKSPACE_BIN: 'bin',
  /** Default AL output folder under the workspace root. */
  AL_OUTPUT: 'src-cal-to-al',
  /** Staging folder for explorer multi-file conversions (removed after run). */
  TEMP_CONVERSION: '.caltoal-temp',
  OBJECT_MAPPING_FILE: 'object-mapping.json',
  /** Bundled Txt2Al.exe folder under the extension `bin/` directory. */
  TXT2AL_TOOLS: 'txt2al',
  /** Bundled NAV 2016 Model Tools (PowerShell delta comparison). */
  NAV_MODEL_TOOLS: '90',
  /** Wizard temp root under the OS temp directory. */
  WIZARD_TEMP_ROOT: 'cal-to-al',
  /** Delta subfolder produced by Compare-NAVApplicationObject. */
  WIZARD_DELTA: 'Delta',
} as const;

export const NAV_MODEL_TOOLS = {
  SCRIPT: 'NavModelTools.ps1',
} as const;

export const FILE_NAMES = {
  CONVERSION_LOG: '_conversion.log',
} as const;

/**
 * Keys for `vscode.workspace.getConfiguration(CONFIG_NAMESPACE)`.
 *
 * Each key maps to a `calToAl.<key>` setting and (when applicable) a txt2al CLI flag.
 */
export const CONVERSION_SETTINGS = {
  type: 'type',
  extensionStartId: 'extensionStartId',
  injectDotNetAddIns: 'injectDotNetAddIns',
  dotNetAddInsPackage: 'dotNetAddInsPackage',
  dotNetTypePrefix: 'dotNetTypePrefix',
  addLegacyTranslationInfo: 'addLegacyTranslationInfo',
  runtime: 'runtime',
  objectFileNamePattern: 'objectFileNamePattern',
  extensionObjectFileNamePattern: 'extensionObjectFileNamePattern',
  dataClassificationDefaulting: 'dataClassificationDefaulting',
  tableDataOnly: 'tableDataOnly',
  txt2alPath: 'txt2alPath',
  logFilePath: 'logFilePath',
  objectMappingPath: 'objectMappingPath',
  verboseLogging: 'verboseLogging',
} as const;
