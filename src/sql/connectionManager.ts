/**
 * Saved connection profiles (globalState + SecretStorage) and pooled
 * `mssql` connections keyed by profile + database.
 *
 * @module sql/connectionManager
 */

import * as crypto from 'crypto';
import * as sql from 'mssql';
import * as vscode from 'vscode';
import { MIGRATION_CONFIG_NAMESPACE, MIGRATION_SETTINGS } from '../constants';
import type { ConnectionProfile } from './types';

const PROFILES_STATE_KEY = 'calToAl.sqlConnectionProfiles';
const SECRET_KEY_PREFIX = 'calToAl.sqlPassword.';

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

function requestTimeoutMs(): number {
  const seconds = vscode.workspace
    .getConfiguration(MIGRATION_CONFIG_NAMESPACE)
    .get<number>(MIGRATION_SETTINGS.queryTimeoutSeconds, 600);
  return Math.max(30, seconds) * 1000;
}

/** Event payload fired when the profile list changes. */
export type ProfilesChangedListener = () => void;

export type ConnectionLogger = (message: string) => void;

/** Extracts a human-readable SQL / network error with nested causes. */
export function formatSqlError(err: unknown): string {
  if (!err) {
    return 'Unknown error';
  }
  if (!(err instanceof Error) && typeof err !== 'object') {
    return String(err);
  }

  const e = err as Error & {
    code?: string | number;
    number?: number;
    state?: number;
    class?: number;
    originalError?: Error & { code?: string; info?: unknown };
    precedingErrors?: unknown[];
  };

  const parts: string[] = [];
  parts.push(e.message || String(err));

  if (e.code !== undefined) {
    parts.push(`code=${e.code}`);
  }
  if (e.number !== undefined) {
    parts.push(`sqlError=${e.number}`);
  }
  if (e.state !== undefined) {
    parts.push(`state=${e.state}`);
  }
  if (e.class !== undefined) {
    parts.push(`class=${e.class}`);
  }

  const original = e.originalError;
  if (original) {
    parts.push(
      `cause=${original.message || String(original)}${original.code ? ` (${original.code})` : ''}`
    );
  }

  return parts.join(' | ');
}

/** Safe summary of a connection attempt (never includes the password). */
export function describeConnectionAttempt(
  profile: ConnectionProfile,
  password: string,
  database?: string
): string {
  const backslash = profile.server.indexOf('\\');
  const host = backslash >= 0 ? profile.server.slice(0, backslash) : profile.server;
  const instance = backslash >= 0 ? profile.server.slice(backslash + 1) : undefined;
  return [
    `name="${profile.name}"`,
    `server=${host}`,
    instance ? `instance=${instance}` : undefined,
    profile.port ? `port=${profile.port}` : 'port=(default/browser)',
    `database=${database ?? 'master'}`,
    `auth=${profile.authMode}`,
    `user=${profile.username}`,
    profile.authMode === 'ntlm' ? `domain=${profile.domain || '(empty)'}` : undefined,
    `password=${password ? 'provided' : 'EMPTY'}`,
    `encrypt=${profile.encrypt}`,
    `trustServerCertificate=${profile.trustServerCertificate}`,
  ]
    .filter(Boolean)
    .join(', ');
}

export class ConnectionManager implements vscode.Disposable {
  private readonly pools = new Map<string, Promise<sql.ConnectionPool>>();
  private readonly listeners = new Set<ProfilesChangedListener>();
  private log: ConnectionLogger = () => undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Attach an output-channel logger for connection diagnostics. */
  setLogger(logger: ConnectionLogger): void {
    this.log = logger;
  }

  // ── Profile CRUD ────────────────────────────────────────────────────────────

  getProfiles(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(PROFILES_STATE_KEY, []);
  }

  getProfile(id: string): ConnectionProfile | undefined {
    return this.getProfiles().find((p) => p.id === id);
  }

  async saveProfile(profile: ConnectionProfile, password?: string): Promise<void> {
    const profiles = this.getProfiles();
    const index = profiles.findIndex((p) => p.id === profile.id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
    await this.context.globalState.update(PROFILES_STATE_KEY, profiles);
    if (password !== undefined) {
      await this.context.secrets.store(SECRET_KEY_PREFIX + profile.id, password);
    }
    await this.closePoolsFor(profile.id);
    this.fireChanged();
  }

  async deleteProfile(id: string): Promise<void> {
    const profiles = this.getProfiles().filter((p) => p.id !== id);
    await this.context.globalState.update(PROFILES_STATE_KEY, profiles);
    await this.context.secrets.delete(SECRET_KEY_PREFIX + id);
    await this.closePoolsFor(id);
    this.fireChanged();
  }

  getPassword(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(SECRET_KEY_PREFIX + id);
  }

  onProfilesChanged(listener: ProfilesChangedListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private fireChanged(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  static newProfileId(): string {
    return crypto.randomUUID();
  }

  // ── Pools ───────────────────────────────────────────────────────────────────

  /**
   * Get (or lazily open) a pooled connection for a profile, optionally scoped
   * to a specific database.
   */
  getPool(profileId: string, database?: string): Promise<sql.ConnectionPool> {
    const key = `${profileId}::${database ?? ''}`;
    let pending = this.pools.get(key);
    if (!pending) {
      pending = this.openPool(profileId, database).catch((err) => {
        this.pools.delete(key);
        throw err;
      });
      this.pools.set(key, pending);
    }
    return pending;
  }

  private async openPool(profileId: string, database?: string): Promise<sql.ConnectionPool> {
    const profile = this.getProfile(profileId);
    if (!profile) {
      throw new Error(`Unknown SQL connection profile: ${profileId}`);
    }
    const password = (await this.getPassword(profileId)) ?? '';
    this.log(
      `[connect] Opening pool — ${describeConnectionAttempt(profile, password, database)}`
    );
    const config = ConnectionManager.buildConfig(profile, password, database);
    const pool = new sql.ConnectionPool(config);
    pool.on('error', (err) => {
      this.log(`[connect] Pool error for ${profile.name}: ${formatSqlError(err)}`);
      void this.closePoolsFor(profileId);
    });
    try {
      await pool.connect();
      this.log(`[connect] Connected to ${profile.server} / ${database ?? 'master'}`);
      return pool;
    } catch (err) {
      this.log(`[connect] FAILED — ${formatSqlError(err)}`);
      throw enrichConnectionError(err, profile);
    }
  }

  static buildConfig(
    profile: ConnectionProfile,
    password: string,
    database?: string
  ): sql.config {
    // Support "host\instance" server names.
    let server = profile.server.trim();
    let instanceName: string | undefined;
    const backslash = server.indexOf('\\');
    if (backslash >= 0) {
      instanceName = server.slice(backslash + 1).trim() || undefined;
      server = server.slice(0, backslash).trim();
    }

    // Accept common local-instance aliases.
    if (server === '.' || server.toLowerCase() === '(local)') {
      server = 'localhost';
    }

    // NTLM: allow DOMAIN\user in the username field.
    let username = profile.username.trim();
    let domain = profile.domain?.trim() || undefined;
    if (profile.authMode === 'ntlm' && username.includes('\\')) {
      const idx = username.indexOf('\\');
      const parsedDomain = username.slice(0, idx).trim();
      const parsedUser = username.slice(idx + 1).trim();
      if (parsedDomain && parsedUser) {
        domain = domain || parsedDomain;
        username = parsedUser;
      }
    }

    // Prefer an explicit TCP port over SQL Browser lookup.
    // Named instances without a port rely on UDP 1434 (SQL Server Browser),
    // which is often blocked by firewalls and causes ETIMEOUT.
    const useExplicitPort = Boolean(profile.port);
    const useInstanceName = Boolean(instanceName) && !useExplicitPort;

    // Use top-level user/password/domain — the format mssql documents and
    // maps reliably onto tedious (see mssql/lib/tedious/connection-pool.js).
    const config: sql.config = {
      server,
      database: database ?? 'master',
      user: username,
      password,
      connectionTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
      requestTimeout: requestTimeoutMs(),
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
      options: {
        encrypt: profile.encrypt,
        trustServerCertificate: profile.trustServerCertificate,
        enableArithAbort: true,
        useUTC: false,
        ...(useInstanceName ? { instanceName } : {}),
      },
    };

    if (profile.authMode === 'ntlm') {
      // mssql switches to NTLM when `domain` is set on the config.
      config.domain = domain ?? '';
    }

    if (useExplicitPort && profile.port) {
      config.port = profile.port;
    }

    return config;
  }

  /** Open a throwaway connection to verify credentials. */
  static async testConnection(
    profile: ConnectionProfile,
    password: string,
    logger?: ConnectionLogger
  ): Promise<void> {
    const log = logger ?? (() => undefined);
    log(`[test] Starting — ${describeConnectionAttempt(profile, password)}`);
    const config = ConnectionManager.buildConfig(profile, password);
    log(
      `[test] Resolved host=${config.server}` +
        `${config.port ? `, port=${config.port}` : ', port=(none — SQL Browser)'}` +
        `${(config.options as { instanceName?: string } | undefined)?.instanceName ? `, instance=${(config.options as { instanceName?: string }).instanceName}` : ''}` +
        `, auth=${profile.authMode === 'ntlm' ? 'ntlm' : 'sql'}, encrypt=${profile.encrypt}, trustCert=${profile.trustServerCertificate}`
    );

    const pool = new sql.ConnectionPool(config);
    try {
      log('[test] pool.connect()…');
      await pool.connect();
      log('[test] Connected — running SELECT 1…');
      await pool.request().query('SELECT 1 AS ok');
      log('[test] Success.');
    } catch (err) {
      log(`[test] FAILED — ${formatSqlError(err)}`);
      throw enrichConnectionError(err, profile);
    } finally {
      await pool.close().catch(() => undefined);
    }
  }

  async closePoolsFor(profileId: string): Promise<void> {
    const prefix = `${profileId}::`;
    const closing: Promise<unknown>[] = [];
    for (const [key, pending] of this.pools) {
      if (key.startsWith(prefix)) {
        this.pools.delete(key);
        closing.push(
          pending.then(
            (pool) => pool.close(),
            () => undefined
          )
        );
      }
    }
    await Promise.all(closing);
  }

  async closeAll(): Promise<void> {
    const pending = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(
      pending.map((p) =>
        p.then(
          (pool) => pool.close(),
          () => undefined
        )
      )
    );
  }

  dispose(): void {
    void this.closeAll();
  }
}

/** Adds actionable hints for common TLS / login / network failures. */
function enrichConnectionError(err: unknown, profile: ConnectionProfile): Error {
  const detail = formatSqlError(err);
  const lower = detail.toLowerCase();
  const hints: string[] = [];

  if (
    lower.includes('certificate') ||
    lower.includes('self signed') ||
    lower.includes('ssl') ||
    lower.includes('tls')
  ) {
    hints.push(
      'TLS tip: choose "Trust server certificate", or set Encrypt = No for older on-premises SQL Server.'
    );
  }
  if (lower.includes('login failed') || lower.includes('18456')) {
    hints.push(
      'Login tip: verify SQL vs Windows auth mode, username, and password. For Windows auth use DOMAIN\\user (or set Domain) — integrated SSO is not supported by the pure-JS driver.'
    );
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('etimeout') ||
    lower.includes('esocket') ||
    lower.includes('could not connect') ||
    lower.includes('failed to connect')
  ) {
    hints.push(
      'Network tip: enable TCP/IP for this instance in SQL Server Configuration Manager, then restart the SQL Server service.'
    );
  }
  if (profile.server.includes('\\') && !profile.port) {
    hints.push(
      'Named instance tip: SQL Browser (UDP 1434) could not resolve the port. Re-add the connection and enter the TCP port from TCP/IP → IP Addresses → IPAll (TCP Dynamic Ports or TCP Port). Example: DESKTOP-S4EOQ9N,49201'
    );
  }
  if (profile.port) {
    hints.push(
      `Port tip: confirm ${profile.server.split('\\')[0]},${profile.port} is listening (PowerShell: Test-NetConnection ${profile.server.split('\\')[0]} -Port ${profile.port}).`
    );
  }

  const message = hints.length > 0 ? `${detail}\n\n${hints.join('\n')}` : detail;
  const wrapped = new Error(message);
  (wrapped as Error & { cause?: unknown }).cause = err;
  return wrapped;
}
