import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/**
 * Timestamped lines to stdout/stderr. With `file` set, lines are appended there too (used when
 * `start` runs in a terminal so `mesh-node logs` still has something to tail; launchd redirects
 * stdout to the same file, so the service passes no file).
 */
export function createLogger(file?: string): Logger {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const write = (level: string, msg: string, stream: NodeJS.WriteStream) => {
    const line = `${stamp()} ${level.padEnd(5)} ${msg}`;
    stream.write(line + '\n');
    if (file) {
      try {
        appendFileSync(file, line + '\n');
      } catch {
        /* log dir missing or read-only; stdout still has it */
      }
    }
  };
  return {
    info: (m) => write('info', m, process.stdout),
    warn: (m) => write('warn', m, process.stderr),
    error: (m) => write('error', m, process.stderr),
  };
}
