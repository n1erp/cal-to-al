/**
 * Migration plan persistence: one JSON entry per table following the spec
 * schema, written atomically on every state change so the file doubles as
 * the live execution log. Watches for external edits.
 *
 * @module migration/planStore
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { DatabaseMetadata } from '../../sql/types';
import type { FieldDiff } from '../db-compare/comparisonEngine';
import { mappingsFilePath, planFilePath, readJson, writeJsonAtomic } from './artifacts';
import type { DatabaseEndpoint, MappingSet, TableMapping } from './mappingEngine';
import { generateQueries } from './queryGenerator';

export type PlanEntryStatus = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Stopped';

/** One migration plan entry (spec schema + internal bookkeeping fields). */
export interface PlanEntry {
  /** Internal stable id. */
  id: string;
  /** Internal: execution strategy chosen for this entry. */
  mode: 'insert-select' | 'bulk-copy';
  /** Internal: id of the table mapping this entry was generated from. */
  mapping_id: string;
  table_trgt: string;
  table_src: string;
  query: string;
  rows: number;
  executed: boolean;
  status: PlanEntryStatus;
  error_code: string | number | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  retry_count: number;
  is_retry: boolean;
  /** Rows actually written by the last execution. */
  executed_rows: number | null;
  /** Field-level schema diffs from the linked database comparison. */
  field_diff_count: number;
  field_diffs: FieldDiff[];
  /** False when comparison or mapping reports unmatched destination columns. */
  mapping_complete: boolean;
  table_matched_by: 'bc-id' | 'name' | 'fuzzy' | 'manual' | null;
}

export interface MigrationPlan {
  version: 1;
  createdAt: string;
  updatedAt: string;
  source: DatabaseEndpoint;
  destination: DatabaseEndpoint;
  /** `comparedAt` from `.cal2al/database-comparison.json` when plan was built from it. */
  comparisonComparedAt: string | null;
  entries: PlanEntry[];
}

export interface CreatePlanFromMappingsOptions {
  comparisonComparedAt?: string | null;
  resolveComparisonMeta?: (mapping: TableMapping) => {
    field_diff_count: number;
    field_diffs: FieldDiff[];
    mapping_complete: boolean;
    table_matched_by: PlanEntry['table_matched_by'];
  };
}

export class PlanStore implements vscode.Disposable {
  private plan: MigrationPlan | undefined;
  private mappingSet: MappingSet | undefined;
  private readonly emitter = new vscode.EventEmitter<MigrationPlan | undefined>();
  readonly onDidChange = this.emitter.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  /** Set while we are writing, so our own saves don't loop through the watcher. */
  private writing = false;

  getPlan(): MigrationPlan | undefined {
    return this.plan;
  }

  getMappingSet(): MappingSet | undefined {
    return this.mappingSet;
  }

  getEntry(id: string): PlanEntry | undefined {
    return this.plan?.entries.find((e) => e.id === id);
  }

  /** Load plan + mappings from disk (no-op when files are absent). */
  async load(): Promise<MigrationPlan | undefined> {
    this.plan = await readJson<MigrationPlan>(planFilePath());
    if (this.plan) {
      this.plan.comparisonComparedAt ??= null;
      for (const entry of this.plan.entries) {
        entry.field_diff_count ??= 0;
        entry.field_diffs ??= [];
        entry.mapping_complete ??= true;
        entry.table_matched_by ??= null;
      }
    }
    this.mappingSet = await readJson<MappingSet>(mappingsFilePath());
    this.ensureWatcher();
    this.emitter.fire(this.plan);
    return this.plan;
  }

  /** Build a fresh plan from a mapping set and persist plan + mappings. */
  async createFromMappings(
    mappingSet: MappingSet,
    destinationMeta?: DatabaseMetadata,
    options: CreatePlanFromMappingsOptions = {}
  ): Promise<MigrationPlan> {
    const sameServer = mappingSet.source.connectionId === mappingSet.destination.connectionId;
    const generated = generateQueries(mappingSet, destinationMeta);

    const entries: PlanEntry[] = generated.map(({ mapping, query }) => {
      const comparisonMeta = options.resolveComparisonMeta?.(mapping);
      return {
        id: crypto.randomUUID(),
        mode: sameServer ? 'insert-select' : 'bulk-copy',
        mapping_id: mapping.id,
        table_trgt: query.targetTable,
        table_src: query.sourceTable,
        query: query.sql,
        rows: query.estimatedRows,
        executed: false,
        status: 'Pending',
        error_code: null,
        error_message: null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        retry_count: 0,
        is_retry: false,
        executed_rows: null,
        field_diff_count: comparisonMeta?.field_diff_count ?? 0,
        field_diffs: comparisonMeta?.field_diffs ?? [],
        mapping_complete: comparisonMeta?.mapping_complete ?? true,
        table_matched_by: comparisonMeta?.table_matched_by ?? mapping.matchedBy,
      };
    });

    const now = new Date().toISOString();
    this.plan = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      source: mappingSet.source,
      destination: mappingSet.destination,
      comparisonComparedAt: options.comparisonComparedAt ?? null,
      entries,
    };
    this.mappingSet = mappingSet;

    await this.persistMappings();
    await this.persistPlan();
    this.ensureWatcher();
    this.emitter.fire(this.plan);
    return this.plan;
  }

  /** Patch a single entry and persist immediately (the live execution log). */
  async updateEntry(id: string, patch: Partial<PlanEntry>): Promise<PlanEntry | undefined> {
    if (!this.plan) {
      return undefined;
    }
    const entry = this.plan.entries.find((e) => e.id === id);
    if (!entry) {
      return undefined;
    }
    Object.assign(entry, patch);
    await this.persistPlan();
    this.emitter.fire(this.plan);
    return entry;
  }

  /** Replace the whole mapping set (manual overrides) and persist. */
  async updateMappings(mappingSet: MappingSet): Promise<void> {
    this.mappingSet = mappingSet;
    await this.persistMappings();
  }

  async save(): Promise<void> {
    await this.persistPlan();
    if (this.mappingSet) {
      await this.persistMappings();
    }
  }

  private async persistPlan(): Promise<void> {
    if (!this.plan) {
      return;
    }
    this.plan.updatedAt = new Date().toISOString();
    this.writing = true;
    try {
      await writeJsonAtomic(planFilePath(), this.plan);
    } finally {
      // Small delay so the watcher event caused by our write is ignored.
      setTimeout(() => {
        this.writing = false;
      }, 500);
    }
  }

  private async persistMappings(): Promise<void> {
    if (!this.mappingSet) {
      return;
    }
    this.writing = true;
    try {
      await writeJsonAtomic(mappingsFilePath(), this.mappingSet);
    } finally {
      setTimeout(() => {
        this.writing = false;
      }, 500);
    }
  }

  /** Watch the plan file so external edits refresh the dashboard. */
  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    let pattern: vscode.RelativePattern;
    try {
      pattern = new vscode.RelativePattern(planFilePath().replace(/[\\/][^\\/]+$/, ''), '*.json');
    } catch {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const reload = async () => {
      if (this.writing) {
        return;
      }
      this.plan = await readJson<MigrationPlan>(planFilePath());
      this.mappingSet = await readJson<MappingSet>(mappingsFilePath());
      if (this.plan) {
        this.plan.comparisonComparedAt ??= null;
        for (const entry of this.plan.entries) {
          entry.field_diff_count ??= 0;
          entry.field_diffs ??= [];
          entry.mapping_complete ??= true;
          entry.table_matched_by ??= null;
        }
      }
      this.emitter.fire(this.plan);
    };
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}
