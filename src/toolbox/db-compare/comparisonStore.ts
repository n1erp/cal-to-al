/**
 * Persists the latest database comparison report under `.cal2al/` and
 * notifies the comparison dashboard when the file changes.
 *
 * @module db-compare/comparisonStore
 */

import * as vscode from 'vscode';
import { comparisonFilePath, readJson, writeJsonAtomic } from '../migration/artifacts';
import type { ComparisonReport } from './comparisonEngine';

export class ComparisonStore implements vscode.Disposable {
  private report: ComparisonReport | undefined;
  private readonly emitter = new vscode.EventEmitter<ComparisonReport | undefined>();
  readonly onDidChange = this.emitter.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private writing = false;

  getReport(): ComparisonReport | undefined {
    return this.report;
  }

  async load(): Promise<ComparisonReport | undefined> {
    this.report = await readJson<ComparisonReport>(comparisonFilePath());
    this.ensureWatcher();
    this.emitter.fire(this.report);
    return this.report;
  }

  async saveFromReport(report: ComparisonReport): Promise<ComparisonReport> {
    this.report = report;
    await this.persist();
    this.ensureWatcher();
    this.emitter.fire(this.report);
    return this.report;
  }

  async save(): Promise<void> {
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.report) {
      return;
    }
    this.writing = true;
    try {
      await writeJsonAtomic(comparisonFilePath(), this.report);
    } finally {
      setTimeout(() => {
        this.writing = false;
      }, 500);
    }
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    let pattern: vscode.RelativePattern;
    try {
      pattern = new vscode.RelativePattern(
        comparisonFilePath().replace(/[\\/][^\\/]+$/, ''),
        '*.json'
      );
    } catch {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const reload = async () => {
      if (this.writing) {
        return;
      }
      this.report = await readJson<ComparisonReport>(comparisonFilePath());
      this.emitter.fire(this.report);
    };
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(async () => {
      if (this.writing) {
        return;
      }
      this.report = undefined;
      this.emitter.fire(this.report);
    });
  }

  dispose(): void {
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}
