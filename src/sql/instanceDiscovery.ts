/**
 * Discover local SQL Server instances for the Connect dialog dropdown.
 *
 * Uses Windows registry + MSSQL* services when available; always includes
 * common local aliases. Network browse (sqlcmd -L) is best-effort and timed out.
 *
 * @module sql/instanceDiscovery
 */

import { execFile } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface DiscoveredInstance {
  /** Value to put in the Server name field (host or host\\instance). */
  name: string;
  /** Optional hint shown in the dropdown. */
  source?: string;
}

/** Deduplicate while preserving order (case-insensitive). */
function uniqueNames(items: DiscoveredInstance[]): DiscoveredInstance[] {
  const seen = new Set<string>();
  const out: DiscoveredInstance[] = [];
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ name: item.name.trim(), source: item.source });
  }
  return out;
}

function localAliases(computerName: string): DiscoveredInstance[] {
  return [
    { name: computerName, source: 'This computer' },
    { name: 'localhost', source: 'Local' },
    { name: '.', source: 'Local' },
    { name: '(local)', source: 'Local' },
  ];
}

/** Parse MSSQL$INSTANCENAME / MSSQLSERVER service names into server strings. */
function fromServiceName(serviceName: string, computerName: string): string | undefined {
  const upper = serviceName.toUpperCase();
  if (upper === 'MSSQLSERVER') {
    return computerName;
  }
  if (upper.startsWith('MSSQL$')) {
    const instance = serviceName.slice('MSSQL$'.length);
    return instance ? `${computerName}\\${instance}` : undefined;
  }
  return undefined;
}

async function discoverViaPowerShell(computerName: string): Promise<DiscoveredInstance[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$computer = $env:COMPUTERNAME
$found = New-Object System.Collections.Generic.List[string]

function Add-Name([string]$n) {
  if ($n -and -not [string]::IsNullOrWhiteSpace($n)) { [void]$found.Add($n.Trim()) }
}

try {
  $key = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL'
  foreach ($p in $key.PSObject.Properties) {
    if ($p.Name -like 'PS*') { continue }
    if ($p.Name -eq 'MSSQLSERVER') {
      Add-Name $computer
      Add-Name 'localhost'
      Add-Name '.'
    } else {
      Add-Name ($computer + '\\' + $p.Name)
      Add-Name ('localhost\\' + $p.Name)
      Add-Name ('.\\' + $p.Name)
    }
  }
} catch {}

Get-Service -Name 'MSSQL*' | ForEach-Object {
  $n = $_.Name
  if ($n -eq 'MSSQLSERVER') {
    Add-Name $computer
    Add-Name 'localhost'
  } elseif ($n -like 'MSSQL$*') {
    $inst = $n.Substring(6)
    if ($inst) {
      Add-Name ($computer + '\\' + $inst)
      Add-Name ('localhost\\' + $inst)
      Add-Name ('.\\' + $inst)
    }
  }
}

$found | Select-Object -Unique
`.trim();

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => ({ name, source: 'Installed instance' }));
  } catch {
    return localAliases(computerName);
  }
}

/** Best-effort network browse; often empty or slow — never blocks the UI long. */
async function discoverViaSqlcmd(): Promise<DiscoveredInstance[]> {
  try {
    const { stdout } = await execFileAsync('sqlcmd', ['-L'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^servers:?$/i.test(line) && line !== '---')
      .map((name) => ({ name, source: 'Network' }));
  } catch {
    return [];
  }
}

/**
 * Return SQL Server names for the Connect dialog dropdown.
 * Always succeeds with at least local aliases.
 */
export async function discoverSqlInstances(
  recentServers: string[] = []
): Promise<DiscoveredInstance[]> {
  const computerName = os.hostname();
  const collected: DiscoveredInstance[] = [];

  for (const server of recentServers) {
    if (server?.trim()) {
      collected.push({ name: server.trim(), source: 'Recent' });
    }
  }

  if (process.platform === 'win32') {
    collected.push(...(await discoverViaPowerShell(computerName)));
    // Network browse is optional and may time out — ignore failures.
    const network = await discoverViaSqlcmd();
    collected.push(...network);
  }

  collected.push(...localAliases(computerName));

  // Prefer installed/recent entries; aliases fill gaps.
  return uniqueNames(collected);
}

/** Exported for unit-style checks without spawning processes. */
export const _test = { fromServiceName, uniqueNames, localAliases };
