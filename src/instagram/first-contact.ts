import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function resolveFirstContactStateDir(configuredDir?: string): string {
  if (configuredDir?.trim()) return configuredDir.trim();
  return path.join(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw'), 'instagram');
}

export function openFirstContactStore(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const markerPath = (accountId: string, senderId: string) =>
    path.join(
      dataDir,
      `${createHash('sha256').update(`${accountId}\0${senderId}`).digest('hex')}.sent`,
    );

  return {
    claim(accountId: string, senderId: string): boolean {
      try {
        const fd = fs.openSync(markerPath(accountId, senderId), 'wx', 0o600);
        fs.closeSync(fd);
        return true;
      } catch (error: any) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
    },
    release(accountId: string, senderId: string): void {
      try {
        fs.unlinkSync(markerPath(accountId, senderId));
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
    close(): void {
      // Marker files require no open handle.
    },
  };
}
