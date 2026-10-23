import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

/** Only this application's credentials are stored here. No other app's login
 * files, browser cookies or environment API keys are read. */
export interface CredentialStorage {
  read(): Promise<unknown | undefined>;
  write(value: unknown): Promise<void>;
}
export class ProtectedCredentialStorage implements CredentialStorage {
  private file: string;
  constructor(private directory: string) {
    this.file = path.join(directory, 'chatgpt-login.dat');
  }
  private async check() {
    await mkdir(this.directory, { recursive: true });
    for (let current = path.resolve(this.directory); ; current = path.dirname(current)) {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new AppError(500, 'ログイン情報の保存先にリンクは使用できません。', 'AUTH_STORAGE');
      if (path.dirname(current) === current) break;
    }
    const directory = await lstat(this.directory);
    if (directory.isSymbolicLink() || !directory.isDirectory())
      throw new AppError(500, 'ログイン情報の保存先を確認してください。', 'AUTH_STORAGE');
    try {
      const file = await lstat(this.file);
      if (file.isSymbolicLink() || !file.isFile())
        throw new AppError(500, 'ログイン情報の保存先を確認してください。', 'AUTH_STORAGE');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async read() {
    await this.check();
    let raw: Buffer;
    try {
      const stat = await lstat(this.file);
      if (stat.size > 1024 * 1024) throw new AppError(500, 'ログイン情報を読み取れません。', 'AUTH_STORAGE');
      raw = await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (raw.length > 1024 * 1024) throw new AppError(500, 'ログイン情報を読み取れません。', 'AUTH_STORAGE');
    if (process.platform === 'win32') {
      if (!raw.toString('ascii', 0, 7).startsWith('DPAPI1:'))
        throw new AppError(500, 'ログイン情報の保護形式が正しくありません。', 'AUTH_STORAGE');
      const plain = await dpapi('decrypt', Buffer.from(raw.subarray(7).toString('ascii'), 'base64'));
      return JSON.parse(plain.toString('utf8'));
    }
    const stat = await lstat(this.file);
    if ((stat.mode & 0o077) !== 0)
      throw new AppError(500, 'ログイン情報のファイル権限を確認してください。', 'AUTH_STORAGE');
    return JSON.parse(raw.toString('utf8'));
  }
  async write(value: unknown) {
    await this.check();
    const plain = Buffer.from(JSON.stringify(value), 'utf8');
    if (plain.length > 650000) throw new AppError(500, 'ログイン情報の保存量が大きすぎます。', 'AUTH_STORAGE');
    const data =
      process.platform === 'win32'
        ? Buffer.from(`DPAPI1:${(await dpapi('encrypt', plain)).toString('base64')}`)
        : plain;
    const temporary = path.join(this.directory, `.login-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}

/** Windows DPAPI binds ciphertext to the current Windows user. Stdin/stdout
 * transport is bounded and is never printed or passed on the command line. */
function dpapi(action: 'encrypt' | 'decrypt', bytes: Buffer): Promise<Buffer> {
  const method = action === 'encrypt' ? 'Protect' : 'Unprotect';
  const code = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[System.Security.Cryptography.ProtectedData]::${method}($inputBytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let complete = false;
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 15000);
    timer.unref();
    const finish = (result?: Buffer) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      result
        ? resolve(result)
        : reject(
            new AppError(
              500,
              'Windowsでログイン情報を保護できませんでした。認証情報は平文で保存していません。',
              'AUTH_STORAGE',
            ),
          );
    };
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 2 * 1024 * 1024) {
        child.kill();
        finish();
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish());
    child.on('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output)) {
        finish();
        return;
      }
      finish(Buffer.from(output, 'base64'));
    });
    child.stdin.end(bytes.toString('base64'));
  });
}
