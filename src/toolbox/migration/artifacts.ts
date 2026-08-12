/**
 * Workspace migration artifact helpers: `.cal2al/` folder resolution and
 * atomic JSON writes (temp file + rename) so plan/mapping files are never
 * observed half-written.
 *
 * @module migration/artifacts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MIGRATION_CONFIG_NAMESPACE,
  MIGRATION_DIR,
  MIGRATION_COMPARISON_FILE,
  MIGRATION_MAPPINGS_FILE,
  MIGRATION_PLAN_FILE,
  MIGRATION_SETTINGS,
} from '../../constants';

/** Resolve (and create) the migration artifacts folder. */
export function migrationDir(): string {
  const config = vscode.workspace.getConfiguration(MIGRATION_CONFIG_NAMESPACE);
  const custom = config.get<string>(MIGRATION_SETTINGS.planFolder, '');
  let dir: string;
  if (custom && custom.trim() !== '') {
    dir = custom;
  } else {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error('Open a workspace folder to store migration files.');
    }
    dir = path.join(root, MIGRATION_DIR);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function planFilePath(): string {
  return path.join(migrationDir(), MIGRATION_PLAN_FILE);
}

export function mappingsFilePath(): string {
  return path.join(migrationDir(), MIGRATION_MAPPINGS_FILE);
}

export function comparisonFilePath(): string {
  return path.join(migrationDir(), MIGRATION_COMPARISON_FILE);
}

/** Write JSON atomically: write to a temp sibling, then rename over the target. */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const text = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tempPath, text, 'utf8');
  try {
    await fs.promises.rename(tempPath, filePath);
  } catch {
    // Windows can fail rename over an open file; fall back to copy semantics.
    await fs.promises.writeFile(filePath, text, 'utf8');
    await fs.promises.unlink(tempPath).catch(() => undefined);
  }
}

export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
