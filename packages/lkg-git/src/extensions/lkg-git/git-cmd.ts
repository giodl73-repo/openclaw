/**
 * Minimal `git` shellout wrapper via `child_process.execFile`. No
 * shell interpretation; arguments are passed as an array so paths
 * with spaces or special characters cannot inject commands.
 *
 * Ported from `@bic/openclaw-lkg-git`'s validated implementation.
 *
 * @module @openclaw/lkg-git/git-cmd
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitInvocationOptions {
  readonly cwd: string;
  readonly config?: Readonly<Record<string, string>>;
  readonly tolerateNonZero?: boolean;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Run `git <args>` in `opts.cwd`. Throws on spawn failure or non-zero
 * exit (unless `tolerateNonZero` is true).
 */
export async function git(
  args: readonly string[],
  opts: GitInvocationOptions,
): Promise<GitResult> {
  const configArgs: string[] = [];
  if (opts.config !== undefined) {
    for (const [k, v] of Object.entries(opts.config)) {
      configArgs.push('-c', `${k}=${v}`);
    }
  }
  const fullArgs = [...configArgs, ...args];
  try {
    const result = await execFileAsync('git', fullArgs, {
      cwd: opts.cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    const stdoutStr =
      typeof result.stdout === 'string'
        ? result.stdout
        : (result.stdout as Buffer).toString('utf-8');
    const stderrStr =
      typeof result.stderr === 'string'
        ? result.stderr
        : (result.stderr as Buffer).toString('utf-8');
    return { stdout: stdoutStr, stderr: stderrStr, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
    };
    if (opts.tolerateNonZero === true && typeof e.code === 'number') {
      return {
        stdout:
          typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '',
        stderr:
          typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '',
        exitCode: e.code,
      };
    }
    throw err;
  }
}

/** Binary-safe variant for `git show HEAD:<path>` against binary files. */
export async function gitBinary(
  args: readonly string[],
  opts: GitInvocationOptions,
): Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }> {
  const configArgs: string[] = [];
  if (opts.config !== undefined) {
    for (const [k, v] of Object.entries(opts.config)) {
      configArgs.push('-c', `${k}=${v}`);
    }
  }
  const fullArgs = [...configArgs, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const stdoutBuf = stdout as unknown as Buffer;
        const stderrBuf = stderr as unknown as Buffer;
        const stdoutBytes = new Uint8Array(
          stdoutBuf.buffer,
          stdoutBuf.byteOffset,
          stdoutBuf.byteLength,
        );
        const stderrText = stderrBuf.toString('utf-8');
        if (err !== null) {
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          if (opts.tolerateNonZero === true && typeof e.code === 'number') {
            resolve({ stdout: stdoutBytes, stderr: stderrText, exitCode: e.code });
            return;
          }
          reject(err);
          return;
        }
        resolve({ stdout: stdoutBytes, stderr: stderrText, exitCode: 0 });
      },
    );
  });
}
