/**
 * Run PowerShell commands and append structured output to the conversion log.
 *
 * @module powershellRunner
 */

import { spawn } from 'child_process';
import * as readline from 'readline';
import { appendConversionLog } from './conversionService';

export interface PowerShellRunResult {
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  elapsedMs: number;
}

/**
 * Escape a path for use inside a PowerShell single-quoted string.
 */
export function quotePowerShellPath(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Execute a PowerShell command, wait for completion, and log command/stdout/stderr/elapsed time.
 *
 * @param command - PowerShell script passed to `-Command`.
 * @param logTargetPath - AL output folder whose `_conversion.log` receives the run details.
 * @param sectionTitle - Heading written to the log for this invocation.
 */
export async function runPowerShellCommand(
  command: string,
  logTargetPath: string,
  sectionTitle: string
): Promise<PowerShellRunResult> {
  const started = Date.now();
  const displayCommand = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${command}`;

  let stdoutBuf = '';
  let stderrBuf = '';

  const exitCode: number = await new Promise(resolve => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, shell: false }
    );

    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line: string) => {
      stdoutBuf += `${line}\n`;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    let rlClosed = false;
    let processClosed = false;
    let code: number | undefined;

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

  const elapsedMs = Date.now() - started;
  const logLines: string[] = [
    `Command: ${displayCommand}`,
    `Elapsed: ${elapsedMs} ms`,
    `Exit code: ${exitCode}`,
  ];

  if (stdoutBuf.trim()) {
    logLines.push('--- stdout ---');
    logLines.push(...stdoutBuf.trim().split(/\r?\n/));
  }

  if (stderrBuf.trim()) {
    logLines.push('--- stderr ---');
    logLines.push(...stderrBuf.trim().split(/\r?\n/).map(line => `[WARN/ERR] ${line}`));
  }

  await appendConversionLog(logTargetPath, sectionTitle, logLines);

  return {
    success: exitCode === 0,
    command: displayCommand,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode,
    elapsedMs,
  };
}
