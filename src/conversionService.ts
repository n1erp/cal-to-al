/**
 * txt2al conversion orchestration for the CAL to AL extension.
 *
 * Responsibilities:
 * - Locate `Txt2Al.exe` and `object-mapping.json`
 * - Build CLI arguments from `calToAl.*` settings
 * - Run the conversion process with progress in the status bar
 * - Append structured logs and post-process AL files (object name resolver)
 *
 * @packageDocumentation
 * @module conversionService
 * @see ./conversionService.README.md
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import {
  CONFIG_NAMESPACE,
  EXECUTABLE_NAMES,
  DIRECTORY_NAMES,
  FILE_NAMES,
  CONVERSION_SETTINGS,
  NAV_MODEL_TOOLS,
} from './constants';

/** Output channel for conversion stdout/stderr and resolver messages. */
let outputChannel: vscode.OutputChannel;

/** Active txt2al child process; killed on extension deactivate if still running. */
let activeChild: ChildProcess | undefined;

/** Most recent AL output directory (wizard or explorer) for “View log” without re-entering paths. */
let lastTargetPath: string | undefined;

/** When `true`, writes extra traces to the extension host debug console. */
const DEVELOPMENT_MODE = false;

/**
 * Write a debug-only log line (no-op when {@link DEVELOPMENT_MODE} is false).
 *
 * @param message - Text prefixed with `[calToAl DEBUG]`.
 */
function debugLog(message: string): void {
  if (!DEVELOPMENT_MODE) return;
  console.log(`[calToAl DEBUG] ${message}`);
}

/**
 * Bind the shared “C/AL to AL” output channel used during conversion.
 *
 * Must be called once from `extension.ts` during `activate`.
 *
 * @param channel - Channel created in {@link extension.activate}.
 */
export function initializeConversionService(channel: vscode.OutputChannel): void {
  outputChannel = channel;
}

/**
 * Terminate the active txt2al process and clear the handle.
 *
 * Safe to call when no conversion is running. Used in `deactivate`.
 */
export function killActiveChild(): void {
  if (activeChild) {
    activeChild.kill();
    activeChild = undefined;
  }
}

/**
 * Get the root directory of the active workspace.
 *
 * @returns First workspace folder path, or `undefined` when no folder is open.
 * @remarks Multi-root workspaces: only the **first** root is used.
 */
export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/**
 * Default AL output folder under the workspace.
 *
 * @param workspaceRoot - Absolute workspace path.
 * @returns `<workspaceRoot>/src-cal-to-al` (see {@link DIRECTORY_NAMES.AL_OUTPUT}).
 */
export function getDefaultTargetPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, DIRECTORY_NAMES.AL_OUTPUT);
}

/**
 * Resolve the conversion log file path for a given output folder.
 *
 * Uses `calToAl.logFilePath` when set; otherwise `<targetPath>/_conversion.log`.
 *
 * @param targetPath - AL output directory.
 */
export function resolveLogPath(targetPath: string): string {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configured = (cfg.get<string>(CONVERSION_SETTINGS.logFilePath) || '').trim();
  return configured || path.join(targetPath, FILE_NAMES.CONVERSION_LOG);
}

/**
 * Open the conversion log in the editor.
 *
 * @param targetPath - Optional output folder; uses the last conversion output or `src-cal-to-al` when omitted.
 */
export async function openConversionLog(targetPath?: string): Promise<void> {
  const resolvedTarget = targetPath || lastTargetPath;
  if (!resolvedTarget) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace is open.');
      return;
    }
    lastTargetPath = getDefaultTargetPath(workspaceRoot);
  }

  const logPath = resolveLogPath(targetPath || lastTargetPath!);
  if (!fs.existsSync(logPath)) {
    vscode.window.showWarningMessage(
      `Log file not found: ${logPath}. Run a conversion first.`
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
  await vscode.window.showTextDocument(doc);
}

/**
 * Input payload from the Conversion Wizard webview (`convert` message).
 */
export interface WizardConversionInput {
  /** Path to migration baseline NAV export (.txt file). */
  inputStandard: string;
  /** Path to customized NAV export (.txt file). */
  inputCustomized: string;
  /** AL output folder (required). */
  outputFile: string;
}

/** Result of {@link validateWizardConversionInput}. */
export interface WizardValidationResult {
  ok: boolean;
  message?: string;
}

/**
 * Validate Conversion Wizard fields before running txt2al.
 *
 * Requires baseline .txt, customized .txt, and an output folder path.
 */
export function validateWizardConversionInput(
  input: WizardConversionInput
): WizardValidationResult {
  const baseline = input.inputStandard.trim();
  const customized = input.inputCustomized.trim();
  const output = input.outputFile.trim();

  if (!baseline) {
    return { ok: false, message: 'Standard NAV objects export (.txt) is required.' };
  }
  if (!customized) {
    return { ok: false, message: 'Customized NAV objects export (.txt) is required.' };
  }
  if (!output) {
    return { ok: false, message: 'Output folder is required.' };
  }
  if (!baseline.toLowerCase().endsWith('.txt')) {
    return { ok: false, message: 'Standard objects export must be a .txt file.' };
  }
  if (!customized.toLowerCase().endsWith('.txt')) {
    return { ok: false, message: 'Customized objects export must be a .txt file.' };
  }

  if (!fs.existsSync(baseline)) {
    return { ok: false, message: `Standard objects file not found: ${baseline}` };
  }
  if (!fs.existsSync(customized)) {
    return { ok: false, message: `Customized objects file not found: ${customized}` };
  }

  const baselineStat = fs.statSync(baseline);
  const customizedStat = fs.statSync(customized);
  if (!baselineStat.isFile()) {
    return { ok: false, message: 'Standard objects export must be a file, not a folder.' };
  }
  if (!customizedStat.isFile()) {
    return { ok: false, message: 'Customized objects export must be a file, not a folder.' };
  }

  if (fs.existsSync(output)) {
    const outputStat = fs.statSync(output);
    if (!outputStat.isDirectory()) {
      return { ok: false, message: 'Output path must be a folder.' };
    }
  }

  return { ok: true };
}

/**
 * Resolve wizard output directory from the user’s output field.
 *
 * @param workspaceRoot - Workspace root for defaults.
 * @param outputFile - Folder path, file path (uses parent dir), or empty for default.
 * @returns Absolute target directory for txt2al `--target`.
 */
export function resolveWizardTargetPath(workspaceRoot: string, outputFile: string): string {
  const trimmed = (outputFile || '').trim();
  if (!trimmed) {
    return getDefaultTargetPath(workspaceRoot);
  }

  if (fs.existsSync(trimmed)) {
    const stat = fs.statSync(trimmed);
    if (stat.isFile()) {
      return path.dirname(trimmed);
    }
    return trimmed;
  }

  return trimmed;
}

/**
 * Create `dir` recursively if it does not exist.
 *
 * @param dir - Absolute directory path.
 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve path to `Txt2Al.exe` (settings override, then search order).
 *
 * Search order when `calToAl.txt2alPath` is missing or invalid:
 * 1. `<workspace>/bin/Txt2Al.exe`
 * 2. `<parent-of-workspace>/bin/Txt2Al.exe`
 * 3. `<extension>/bin/txt2al/Txt2Al.exe` (bundled copy)
 *
 * @param context - Extension context for `extensionPath`.
 * @param workspaceRoot - Active workspace root.
 * @returns Absolute path to the executable, or `undefined` if not found.
 */
function resolveTxt2AlPath(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): string | undefined {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configured = (cfg.get<string>(CONVERSION_SETTINGS.txt2alPath) || '').trim();

  if (configured) {
    if (fs.existsSync(configured)) return configured;
    vscode.window.showWarningMessage(
      `Configured txt2al path not found: "${configured}". Falling back to default locations.`
    );
  }

  const wsPrimary = path.join(workspaceRoot, DIRECTORY_NAMES.WORKSPACE_BIN, EXECUTABLE_NAMES.TXT2AL_WINDOWS);
  if (fs.existsSync(wsPrimary)) return wsPrimary;

  const parent = path.dirname(workspaceRoot);
  if (parent && parent !== workspaceRoot) {
    const wsParent = path.join(parent, DIRECTORY_NAMES.WORKSPACE_BIN, EXECUTABLE_NAMES.TXT2AL_WINDOWS);
    if (fs.existsSync(wsParent)) return wsParent;
  }

  const extPath = path.join(
    context.extensionPath,
    DIRECTORY_NAMES.WORKSPACE_BIN,
    DIRECTORY_NAMES.TXT2AL_TOOLS,
    EXECUTABLE_NAMES.TXT2AL_WINDOWS
  );
  if (fs.existsSync(extPath)) return extPath;

  return undefined;
}

/**
 * Resolve path to `object-mapping.json` for post-conversion reference replacement.
 *
 * Search order when `calToAl.objectMappingPath` is missing or invalid:
 * 1. `<workspace>/bin/object-mapping.json`
 * 2. `<parent-of-workspace>/bin/object-mapping.json`
 * 3. `<extension>/bin/object-mapping.json`
 * 4. `<workspace>/object-mapping.json`
 *
 * @param context - Extension context.
 * @param workspaceRoot - Active workspace root.
 */
function resolveObjectMappingPath(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): string | undefined {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configured = (cfg.get<string>(CONVERSION_SETTINGS.objectMappingPath) || '').trim();

  if (configured) {
    if (fs.existsSync(configured)) return configured;
    vscode.window.showWarningMessage(
      `Configured object-mapping path not found: "${configured}". Falling back to default locations.`
    );
  }

  const wsPrimary = path.join(workspaceRoot, DIRECTORY_NAMES.WORKSPACE_BIN, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);
  if (fs.existsSync(wsPrimary)) return wsPrimary;

  const parent = path.dirname(workspaceRoot);
  if (parent && parent !== workspaceRoot) {
    const wsParent = path.join(parent, DIRECTORY_NAMES.WORKSPACE_BIN, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);
    if (fs.existsSync(wsParent)) return wsParent;
  }

  const extPath = path.join(context.extensionPath, DIRECTORY_NAMES.WORKSPACE_BIN, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);
  if (fs.existsSync(extPath)) return extPath;

  const rootPath = path.join(workspaceRoot, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);
  if (fs.existsSync(rootPath)) return rootPath;

  return undefined;
}

function formatLogTimestamp(label: string): string {
  return `[${new Date().toISOString()}] ${label}`;
}

/**
 * Append a titled section with timestamped lines to `_conversion.log`.
 *
 * @param targetPath - AL output folder containing the log.
 * @param sectionTitle - Section heading (also timestamped).
 * @param lines - Body lines (each timestamped).
 */
export async function appendConversionLog(
  targetPath: string,
  sectionTitle: string,
  lines: string[]
): Promise<void> {
  ensureDir(targetPath);
  const logPath = resolveLogPath(targetPath);
  const output: string[] = [formatLogTimestamp(sectionTitle)];
  for (const line of lines) {
    output.push(formatLogTimestamp(line));
  }
  output.push('');

  try {
    await fs.promises.appendFile(logPath, output.join('\n'), 'utf8');
    debugLog(`[INFO] Log written to: ${logPath}`);
  } catch (err) {
    debugLog(`[WARN] Could not write log file: ${err}`);
  }
}

/**
 * Append a timestamped conversion run to `_conversion.log`.
 *
 * @param targetPath - AL output folder containing the log.
 * @param stdout - Collected stdout from txt2al.
 * @param stderr - Collected stderr from txt2al.
 * @param exitCode - Process exit code.
 */
async function writeConversionLog(
  targetPath: string,
  stdout: string,
  stderr: string,
  exitCode: number
): Promise<void> {
  const lines: string[] = [];

  if (stdout.trim()) {
    lines.push(...stdout.trim().split(/\r?\n/));
  }

  if (stderr.trim()) {
    lines.push(...stderr.trim().split(/\r?\n/).map(line => `[WARN/ERR] ${line}`));
  }

  lines.push(`Process exited with code: ${exitCode}`);

  await appendConversionLog(targetPath, '=== txt2al conversion ended ===', lines);
}

/**
 * Load `object-mapping.json` into a case-insensitive lookup map.
 *
 * @param context - Extension context for path resolution.
 * @param workspaceRoot - Active workspace root.
 * @returns Map of search string → replacement string; empty map if file missing or invalid.
 */
async function loadObjectMapping(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<Map<string, string>> {
  const mappingPath = resolveObjectMappingPath(context, workspaceRoot);
  if (!mappingPath) {
    debugLog('object-mapping.json not found in configured or default locations.');
    return new Map();
  }

  debugLog(`object-mapping.json resolved to: ${mappingPath}`);

  try {
    const raw = await fs.promises.readFile(mappingPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      debugLog(`[WARN] object-mapping.json must be a flat key/value object. Resolver skipped.`);
      return new Map();
    }

    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        map.set(key, value);
      } else {
        debugLog(`[WARN] Skipping non-string mapping value for key: "${key}"`);
      }
    }

    debugLog(`[INFO] Loaded ${map.size} object name mapping(s) from: ${mappingPath}`);
    return map;
  } catch (err) {
    debugLog(`[WARN] Could not parse object-mapping.json: ${err}. Resolver skipped.`);
    return new Map();
  }
}

/**
 * Replace numeric object references in generated `.al` files using the mapping table.
 *
 * Also scans for remaining `Record "123"`-style references and logs unmapped entries.
 *
 * @param targetPath - AL output directory.
 * @param mapping - Keys/replacements from {@link loadObjectMapping}.
 * @param logPath - Log file to append resolver output.
 */
async function resolveObjectReferences(
  targetPath: string,
  mapping: Map<string, string>,
  logPath: string
): Promise<void> {
  if (mapping.size === 0) return;

  const escapedKeys = Array.from(mapping.keys()).map(k =>
    k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );

  const pattern = new RegExp(escapedKeys.join('|'), 'gi');
  const unmappedPattern = /\b(Record|Page|Query|Codeunit|Report|XmlPort|Enum|Table)\s+"(\d+)"/gi;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
  } catch {
    debugLog(`[WARN] Could not read output directory for resolver: ${targetPath}`);
    return;
  }

  const alFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.al'));
  if (alFiles.length === 0) return;

  const timestamp = (label: string) => `[${new Date().toISOString()}] ${label}`;
  const logLines: string[] = [timestamp('=== Object reference resolver ===')];

  let totalFiles = 0;
  let totalReplacements = 0;
  const unmappedRefs = new Set<string>();

  for (const entry of alFiles) {
    const filePath = path.join(targetPath, entry.name);

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      const msg = `[WARN] Could not read ${entry.name}: ${err}`;
      debugLog(msg);
      logLines.push(timestamp(msg));
      continue;
    }

    let fileReplacements = 0;
    const fileLog: string[] = [];

    const updated = content.replace(pattern, (match) => {
      const key = Array.from(mapping.keys()).find(
        k => k.toLowerCase() === match.toLowerCase()
      );
      if (key === undefined) return match;
      const replacement = mapping.get(key)!;
      fileReplacements++;
      fileLog.push(timestamp(`  ${entry.name}: "${match}" → "${replacement}"`));
      return replacement;
    });

    let unmatchedResult: RegExpExecArray | null;
    unmappedPattern.lastIndex = 0;
    while ((unmatchedResult = unmappedPattern.exec(updated)) !== null) {
      unmappedRefs.add(unmatchedResult[0]);
    }

    if (fileReplacements === 0) continue;

    try {
      await fs.promises.writeFile(filePath, updated, 'utf8');
      totalFiles++;
      totalReplacements += fileReplacements;

      const summary = `[RESOLVER] ${entry.name}: ${fileReplacements} replacement(s)`;
      debugLog(summary);
      logLines.push(timestamp(summary));
      fileLog.forEach(l => {
        debugLog(l);
        logLines.push(l);
      });
    } catch (err) {
      const msg = `[WARN] Could not write ${entry.name}: ${err}`;
      debugLog(msg);
      logLines.push(timestamp(msg));
    }
  }

  const summary = `[RESOLVER] Done — ${totalReplacements} replacement(s) across ${totalFiles} file(s).`;
  debugLog(summary);
  logLines.push(timestamp(summary));

  if (unmappedRefs.size > 0) {
    const unmappedHeader = `[RESOLVER] ${unmappedRefs.size} unmapped numeric reference(s) found:`;
    debugLog(unmappedHeader);
    logLines.push(timestamp(unmappedHeader));
    outputChannel.show(true);

    for (const ref of [...unmappedRefs].sort()) {
      const line = `  ${ref}`;
      debugLog(line);
      logLines.push(timestamp(line));
    }
  }

  logLines.push('');

  try {
    await fs.promises.appendFile(logPath, logLines.join('\n'), 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Build txt2al CLI argument list from workspace settings (`calToAl.*`).
 *
 * Always includes `--multithreaded`, `--rename`, and `--format`.
 * Adds `--stacktrace` when `calToAl.verboseLogging` is true.
 *
 * @param source - `--source` folder (C/AL `.txt` exports).
 * @param target - `--target` folder (AL output).
 */
function buildArgs(source: string, target: string): string[] {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const args: string[] = ['--source', source, '--target', target];

  const verbose = cfg.get<boolean>(CONVERSION_SETTINGS.verboseLogging);
  if (verbose) args.push('--stacktrace');

  args.push('--multithreaded');
  args.push('--rename');
  args.push('--format');

  if (cfg.get<boolean>(CONVERSION_SETTINGS.injectDotNetAddIns)) args.push('--injectDotNetAddIns');
  if (cfg.get<boolean>(CONVERSION_SETTINGS.addLegacyTranslationInfo)) args.push('--addLegacyTranslationInfo');
  if (cfg.get<boolean>(CONVERSION_SETTINGS.tableDataOnly)) args.push('--tableDataOnly');

  const type = (cfg.get<string>(CONVERSION_SETTINGS.type) || '').trim();
  if (type) args.push('--type', type);

  const startId = cfg.get<number>(CONVERSION_SETTINGS.extensionStartId);
  if (startId != null && startId > 0) args.push('--extensionStartId', String(startId));

  const addInsPkg = (cfg.get<string>(CONVERSION_SETTINGS.dotNetAddInsPackage) || '').trim();
  if (addInsPkg) args.push('--dotNetAddInsPackage', addInsPkg);

  const typePrefix = (cfg.get<string>(CONVERSION_SETTINGS.dotNetTypePrefix) || '').trim();
  if (typePrefix) args.push('--dotNetTypePrefix', typePrefix);

  const runtime = (cfg.get<string>(CONVERSION_SETTINGS.runtime) || '').trim();
  if (runtime) args.push('--runtime', runtime);

  const objPattern = (cfg.get<string>(CONVERSION_SETTINGS.objectFileNamePattern) || '').trim();
  if (objPattern) args.push('--objectFileNamePattern', objPattern);

  const extObjPattern = (cfg.get<string>(CONVERSION_SETTINGS.extensionObjectFileNamePattern) || '').trim();
  if (extObjPattern) args.push('--extensionObjectFileNamePattern', extObjPattern);

  const dataClass = (cfg.get<string>(CONVERSION_SETTINGS.dataClassificationDefaulting) || '').trim();
  if (dataClass) args.push('--dataClassificationDefaulting', dataClass);

  return args;
}

/** Options for {@link executeConversion}. */
export interface ExecuteConversionOptions {
  /** Notification progress title (default: `C/AL → AL`). */
  progressTitle?: string;
  /** Initial progress message. */
  progressMessage?: string;
  /** When set, suppresses the success information toast (wizard shows its own). */
  suppressSuccessToast?: boolean;
  /** When set, skips the VS Code notification progress UI (wizard provides its own). */
  suppressProgressNotification?: boolean;
  /** Receives progress message updates (wizard status line). */
  onProgress?: (message: string) => void;
}

/**
 * Resolve a root directory used to locate bundled tools when no workspace is open.
 *
 * Prefers the active workspace root, then the AL output folder, then the extension install path.
 */
export function resolveConversionContextRoot(
  context: vscode.ExtensionContext,
  preferredPath?: string
): string {
  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    return workspaceRoot;
  }
  const trimmed = (preferredPath || '').trim();
  if (trimmed) {
    return trimmed;
  }
  return context.extensionPath;
}

/**
 * Run txt2al, stream progress, write logs, and optionally resolve object references.
 *
 * @param context - Extension context (exe and mapping resolution).
 * @param workspaceRoot - Root used to resolve txt2al and object-mapping paths.
 * @param sourcePath - Folder passed to txt2al `--source`.
 * @param targetPath - Folder passed to txt2al `--target`.
 * @param tempSourceDir - If set, removed after conversion (wizard temp copy).
 * @param successOutputLabel - Short name shown in the success toast (e.g. `src-cal-to-al`).
 * @param options - Optional progress and notification overrides.
 * @returns `true` when txt2al exits with code 0; otherwise `false`.
 */
async function executeConversion(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  sourcePath: string,
  targetPath: string,
  tempSourceDir: string | undefined,
  successOutputLabel: string,
  options: ExecuteConversionOptions = {}
): Promise<boolean> {
  ensureDir(targetPath);
  lastTargetPath = targetPath;

  const exePath = resolveTxt2AlPath(context, workspaceRoot);
  if (!exePath) {
    vscode.window.showErrorMessage(
      'txt2al.exe not found. Set calToAl.txt2alPath or place Txt2Al.exe in bin.'
    );
    return false;
  }

  const logPath = resolveLogPath(targetPath);
  const objectMapping = await loadObjectMapping(context, workspaceRoot);

  debugLog(`objectMapping size: ${objectMapping.size}`);

  try {
    let succeeded = false;

    const reportProgress = (message: string): void => {
      options.onProgress?.(message);
    };

    const runConversion = async (
      report: (message: string) => void
    ): Promise<void> => {
      const initialMessage = options.progressMessage ?? 'Starting conversion…';
      report(initialMessage);

      const args = buildArgs(sourcePath, targetPath);
      const child = spawn(exePath, args, {
        cwd: path.dirname(exePath),
        windowsHide: true,
        shell: false,
      });

      activeChild = child;

      let stdoutBuf = '';
      let stderrBuf = '';
      let convertedCount = 0;

      const rl = readline.createInterface({ input: child.stdout, terminal: false });

      rl.on('line', (line: string) => {
        stdoutBuf += `${line}\n`;

        if (line.startsWith('Writing:') || line.startsWith('Overwriting:')) {
          convertedCount++;
          const prefix = line.startsWith('Writing:') ? 'Writing:' : 'Overwriting:';
          const writtenFile = path.basename(line.slice(prefix.length).trim());
          report(`${convertedCount} — ${writtenFile}`);
        }
      });

      child.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString(); });

      const exitCode: number = await new Promise(resolve => {
        let code: number | undefined;
        let rlClosed = false;
        let processClosed = false;

        function tryResolve() {
          if (rlClosed && processClosed) {
            resolve(code ?? -1);
          }
        }

        rl.on('close', () => {
          rlClosed = true;
          tryResolve();
        });

        child.on('close', c => {
          report('Ending conversion…');
          code = c ?? -1;
          processClosed = true;
          tryResolve();
        });

        child.on('error', () => {
          code = -1;
          processClosed = true;
          rlClosed = true;
          tryResolve();
        });
      });

      activeChild = undefined;

      if (tempSourceDir) {
        await fs.promises.rm(tempSourceDir, { recursive: true, force: true }).catch(() => undefined);
      }

      await writeConversionLog(targetPath, stdoutBuf, stderrBuf, exitCode);

      if (exitCode !== 0) {
        const errMsg = stderrBuf.trim() || 'Conversion failed with no output.';
        debugLog(`[ERROR] txt2al exited with code ${exitCode}`);
        debugLog(errMsg);
        outputChannel.show(true);

        if (!options.suppressSuccessToast) {
          if (convertedCount === 0) {
            vscode.window.showErrorMessage(
              `Conversion failed — 0 objects converted. See "${FILE_NAMES.CONVERSION_LOG}" for details.`
            );
          } else {
            vscode.window.showErrorMessage(
              errMsg.length > 800 ? errMsg.slice(0, 800) + '…' : errMsg
            );
          }
        }
        succeeded = false;
        return;
      }

      if (objectMapping.size > 0) {
        await resolveObjectReferences(targetPath, objectMapping, logPath);
      }

      if (!options.suppressSuccessToast) {
        vscode.window.showInformationMessage(
          `C/AL → AL: ${convertedCount} object(s) converted. ` +
          `Output: "${successOutputLabel}" — Log: "${FILE_NAMES.CONVERSION_LOG}".`
        );
      }
      succeeded = true;
    };

    if (options.suppressProgressNotification) {
      await runConversion(reportProgress);
    } else {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: options.progressTitle ?? 'C/AL → AL',
        cancellable: true,
      }, async (progress) => {
        await runConversion((message) => {
          progress.report({ message });
          reportProgress(message);
        });
      });
    }

    return succeeded;
  } catch (err) {
    debugLog(`[EXCEPTION] Conversion threw: ${String(err)}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(
      `Conversion crashed. See "${FILE_NAMES.CONVERSION_LOG}" for details.`
    );
    return false;
  }
}

/**
 * Recursively collect `.txt` files under a directory.
 *
 * @param dir - Absolute directory to scan.
 * @returns Absolute paths of every `.txt` file found (any depth).
 */
async function collectTxtFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.promises
    .readdir(dir, { withFileTypes: true })
    .catch(() => [] as fs.Dirent[]);

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectTxtFiles(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
      out.push(full);
    }
  }

  return out;
}

/**
 * Convert from an explorer-selected file (copies single files into temp source).
 *
 * Output always goes to {@link getDefaultTargetPath}. Used by the explorer
 * right-click command.
 *
 * @param context - Extension context.
 * @param resource - Selected URI (file or directory).
 */
export async function runConversionFromUri(
  context: vscode.ExtensionContext,
  resource: vscode.Uri
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace is open.');
    return;
  }

  let sourcePath = resource.fsPath;
  const stat = await fs.promises.stat(sourcePath).catch(() => undefined);
  if (!stat) {
    vscode.window.showErrorMessage('Selected path is invalid.');
    return;
  }

  let tempSourceDir: string | undefined;
  if (stat.isFile()) {
    tempSourceDir = path.join(workspaceRoot, DIRECTORY_NAMES.TEMP_CONVERSION);
    ensureDir(tempSourceDir);
    const destFile = path.join(tempSourceDir, path.basename(sourcePath));
    await fs.promises.copyFile(sourcePath, destFile);
    sourcePath = tempSourceDir;
  }

  const targetPath = getDefaultTargetPath(workspaceRoot);

  await executeConversion(
    context,
    workspaceRoot,
    sourcePath,
    targetPath,
    tempSourceDir,
    DIRECTORY_NAMES.AL_OUTPUT
  );
}

/**
 * Convert one or more explorer-selected resources (files and/or folders).
 *
 * A single selection defers to {@link runConversionFromUri}. For a multi-select,
 * all `.txt` files (found directly or recursively inside selected folders) are
 * copied into a temp source dir and converted in one run. Output always goes to
 * {@link getDefaultTargetPath}.
 *
 * @param context - Extension context.
 * @param resources - Selected URIs from the explorer context menu.
 */
export async function runConversionFromResources(
  context: vscode.ExtensionContext,
  resources: vscode.Uri[]
): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace is open.');
    return;
  }

  const unique = Array.from(new Set(resources.map(r => r.fsPath)));
  if (unique.length === 0) {
    vscode.window.showErrorMessage('No file or folder selected for conversion.');
    return;
  }

  if (unique.length === 1) {
    await runConversionFromUri(context, vscode.Uri.file(unique[0]));
    return;
  }

  const txtFiles = new Set<string>();
  for (const p of unique) {
    const stat = await fs.promises.stat(p).catch(() => undefined);
    if (!stat) continue;
    if (stat.isDirectory()) {
      (await collectTxtFiles(p)).forEach(f => txtFiles.add(f));
    } else if (stat.isFile() && p.toLowerCase().endsWith('.txt')) {
      txtFiles.add(p);
    }
  }

  if (txtFiles.size === 0) {
    vscode.window.showErrorMessage('No .txt C/AL export files found in the selection.');
    return;
  }

  const tempSourceDir = path.join(workspaceRoot, DIRECTORY_NAMES.TEMP_CONVERSION);
  await fs.promises.rm(tempSourceDir, { recursive: true, force: true }).catch(() => undefined);
  ensureDir(tempSourceDir);

  try {
    let index = 0;
    const usedNames = new Set<string>();
    for (const file of txtFiles) {
      let base = path.basename(file);
      // Disambiguate identical file names coming from different folders.
      if (usedNames.has(base.toLowerCase())) {
        const parsed = path.parse(base);
        base = `${parsed.name}_${index}${parsed.ext}`;
      }
      usedNames.add(base.toLowerCase());
      await fs.promises.copyFile(file, path.join(tempSourceDir, base));
      index++;
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Could not prepare conversion source: ${err}`);
    await fs.promises.rm(tempSourceDir, { recursive: true, force: true }).catch(() => undefined);
    return;
  }

  const targetPath = getDefaultTargetPath(workspaceRoot);
  await executeConversion(
    context,
    workspaceRoot,
    tempSourceDir,
    targetPath,
    tempSourceDir,
    DIRECTORY_NAMES.AL_OUTPUT
  );
}

/**
 * Convert a source folder (e.g. delta files) into AL at a target folder.
 *
 * Reuses the same txt2al pipeline as the explorer "Convert C/AL to AL" command.
 *
 * @param context - Extension context.
 * @param sourcePath - Folder containing .txt delta or export files.
 * @param targetPath - AL output folder.
 * @param contextRoot - Root for resolving txt2al and object-mapping paths.
 * @param options - Optional progress overrides.
 * @returns `true` when conversion completes successfully.
 */
export async function runConversionFromSourceFolder(
  context: vscode.ExtensionContext,
  sourcePath: string,
  targetPath: string,
  contextRoot: string,
  options: ExecuteConversionOptions & {
    tempSourceDir?: string;
    successOutputLabel?: string;
  } = {}
): Promise<boolean> {
  const outputLabel = options.successOutputLabel ?? path.basename(targetPath);
  await appendConversionLog(targetPath, '=== txt2al conversion started ===', [
    `Source: ${sourcePath}`,
    `Target: ${targetPath}`,
  ]);

  return executeConversion(
    context,
    contextRoot,
    sourcePath,
    targetPath,
    options.tempSourceDir,
    outputLabel,
    options
  );
}

/** Callback for wizard pipeline progress updates. */
export type WizardProgressCallback = (message: string) => void;

/**
 * Run conversion from Conversion Wizard input (standard/customized exports + output path).
 *
 * Orchestrates Compare-NAVApplicationObject (delta generation) then reuses txt2al conversion.
 *
 * @param context - Extension context.
 * @param input - Paths from the wizard webview.
 * @param onProgress - Optional status callback for the wizard UI.
 * @returns `true` when the full pipeline completes successfully.
 */
export async function runConversionFromWizard(
  context: vscode.ExtensionContext,
  input: WizardConversionInput,
  onProgress?: WizardProgressCallback
): Promise<boolean> {
  const validation = validateWizardConversionInput(input);
  if (!validation.ok) {
    vscode.window.showErrorMessage(validation.message ?? 'Invalid conversion wizard input.');
    return false;
  }

  const targetPath = resolveWizardTargetPath(
    getWorkspaceRoot() ?? input.outputFile.trim(),
    input.outputFile
  );
  const contextRoot = resolveConversionContextRoot(context, targetPath);
  const outputLabel = path.basename(targetPath);

  const workDir = path.join(os.tmpdir(), DIRECTORY_NAMES.WIZARD_TEMP_ROOT);
  const deltaPath = path.join(workDir, DIRECTORY_NAMES.WIZARD_DELTA);
  const navToolsPath = path.join(
    context.extensionPath,
    DIRECTORY_NAMES.WORKSPACE_BIN,
    DIRECTORY_NAMES.NAV_MODEL_TOOLS,
    NAV_MODEL_TOOLS.SCRIPT
  );

  if (!fs.existsSync(navToolsPath)) {
    const message = `NAV Model Tools not found: ${navToolsPath}`;
    vscode.window.showErrorMessage(message);
    onProgress?.(message);
    return false;
  }

  await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  ensureDir(deltaPath);

  await appendConversionLog(targetPath, '=== Conversion Wizard started ===', [
    `Standard objects: ${input.inputStandard.trim()}`,
    `Customized objects: ${input.inputCustomized.trim()}`,
    `Delta folder: ${deltaPath}`,
    `Output folder: ${targetPath}`,
  ]);

  const report = (message: string): void => {
    onProgress?.(message);
  };

  let pipelineSucceeded = false;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Conversion Wizard',
        cancellable: false,
      },
      async progress => {
        progress.report({ message: 'Generating Delta…' });
        report('Generating Delta…');

        const { quotePowerShellPath, runPowerShellCommand } = await import('./powershellRunner');

        const standardPath = quotePowerShellPath(input.inputStandard.trim());
        const customizedPath = quotePowerShellPath(input.inputCustomized.trim());
        const deltaPathQuoted = quotePowerShellPath(deltaPath);

        const compareScript = [
          '$ErrorActionPreference = "Stop"',
          `Import-Module ${quotePowerShellPath(navToolsPath)} -Force`,
          `Compare-NAVApplicationObject -OriginalPath ${standardPath} -ModifiedPath ${customizedPath} -DeltaPath ${deltaPathQuoted} -Force`,
        ].join('; ');

        const compareResult = await runPowerShellCommand(
          compareScript,
          targetPath,
          '=== PowerShell: Compare-NAVApplicationObject ==='
        );

        if (!compareResult.success) {
          const errText =
            compareResult.stderr.trim() ||
            compareResult.stdout.trim() ||
            `Compare-NAVApplicationObject failed with exit code ${compareResult.exitCode}.`;
          const message =
            errText.length > 800 ? `${errText.slice(0, 800)}…` : errText;
          vscode.window.showErrorMessage(message);
          report(message);
          await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
          return;
        }

        progress.report({ message: 'Converting Delta to AL…' });
        report('Converting Delta to AL…');

        const converted = await runConversionFromSourceFolder(
          context,
          deltaPath,
          targetPath,
          contextRoot,
          {
            progressTitle: 'Conversion Wizard',
            progressMessage: 'Converting Delta to AL…',
            suppressSuccessToast: true,
            suppressProgressNotification: true,
            onProgress: report,
            tempSourceDir: workDir,
            successOutputLabel: outputLabel,
          }
        );

        if (!converted) {
          report('Conversion failed. Check the log for details.');
          return;
        }

        progress.report({ message: 'Generating Extension…' });
        report('Generating Extension…');

        await openGeneratedFolder(targetPath);

        progress.report({ message: 'Done!' });
        report('Done!');
        pipelineSucceeded = true;
      }
    );
  } catch (err) {
    const message = `Conversion Wizard failed: ${String(err)}`;
    vscode.window.showErrorMessage(message);
    onProgress?.(message);
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }

  if (pipelineSucceeded) {
    vscode.window.showInformationMessage(
      `Conversion Wizard: AL extension generated in "${outputLabel}". ` +
      `Log: "${FILE_NAMES.CONVERSION_LOG}".`
    );
  }

  return pipelineSucceeded;
}

/**
 * Reveal or open the generated AL output folder inside VS Code.
 */
async function openGeneratedFolder(targetPath: string): Promise<void> {
  const uri = vscode.Uri.file(targetPath);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }

  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
}
