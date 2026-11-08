import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep established Windows installations in place; new installations may
// override both roots without moving source or credential files into Git.
export function dataPath(...parts) {
  const root = process.env.PROGRESSIVE_READING_DATA_HOME
    || (process.platform === 'win32' && existsSync('D:/AppData') ? 'D:/AppData'
      : process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
  return path.join(root, ...parts);
}

export function artifactPath(...parts) {
  const root = process.env.PROGRESSIVE_READING_ARTIFACT_HOME
    || (process.platform === 'win32' && existsSync('D:/Artifacts') ? 'D:/Artifacts'
      : path.join(dataPath('ProgressiveReading'), 'artifacts'));
  return path.join(root, ...parts);
}
