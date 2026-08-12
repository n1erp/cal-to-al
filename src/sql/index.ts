/**
 * SQL core layer entry point: builds the shared service instances used by
 * every data-migration feature module.
 *
 * @module sql
 */

import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { MetadataScanner } from './metadataScanner';
import { QueryRunner } from './queryRunner';

export * from './types';
export { ConnectionManager } from './connectionManager';
export { QueryRunner } from './queryRunner';
export { MetadataScanner } from './metadataScanner';
export { discoverSqlInstances } from './instanceDiscovery';

/** Shared SQL services passed to the feature modules. */
export interface SqlServices {
  connections: ConnectionManager;
  runner: QueryRunner;
  scanner: MetadataScanner;
  /** "Data Migration" output channel shared by all migration features. */
  output: vscode.OutputChannel;
}

export function createSqlServices(context: vscode.ExtensionContext): SqlServices {
  const connections = new ConnectionManager(context);
  const runner = new QueryRunner(connections);
  const scanner = new MetadataScanner(connections, runner);
  const output = vscode.window.createOutputChannel('Data Migration');
  connections.setLogger((message) => {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  });
  context.subscriptions.push(connections, output);
  return { connections, runner, scanner, output };
}
