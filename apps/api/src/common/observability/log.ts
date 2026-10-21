import { Logger } from '@nestjs/common';
import { buildInfo } from './build-info';

/**
 * Structured logs without a logging dependency (audit CR-14). In JSON mode (default in staging and production, or
 * LOG_FORMAT=json) every entry is one JSON object per line on stdout, which Render's log stream and any log drain can
 * parse; in text mode the Nest logger prints the same object. Entries carry the validated request id (PS-15) and the
 * deployed commit, never request bodies, headers, query strings or raw paths (guest and payment tokens live in paths).
 */
export type LogFormat = 'json' | 'text';

export function logFormat(env: Record<string, string | undefined> = process.env): LogFormat {
  if (env.LOG_FORMAT === 'json' || env.LOG_FORMAT === 'text') return env.LOG_FORMAT;
  return env.NODE_ENV === 'production' || env.NODE_ENV === 'staging' ? 'json' : 'text';
}

type Sink = (line: string) => void;
let sink: Sink = (line) => { process.stdout.write(`${line}\n`); };
/** Tests capture the JSON lines here. */
export function setLogSink(next: Sink | null) { sink = next ?? ((line) => { process.stdout.write(`${line}\n`); }); }

const textLoggers = new Map<string, Logger>();

export function writeLog(type: string, level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, format: LogFormat = logFormat()) {
  if (format === 'json') {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, type, service: 'api', build: buildInfo().shortCommit, ...fields }));
    return;
  }
  let logger = textLoggers.get(type);
  if (!logger) { logger = new Logger(type === 'access' ? 'Access' : type); textLoggers.set(type, logger); }
  const text = JSON.stringify(fields);
  if (level === 'error') logger.error(text); else if (level === 'warn') logger.warn(text); else logger.log(text);
}

/** One line per response: method, route pattern, status, duration, request id, tenant, actor. */
export interface AccessEntry {
  requestId: string;
  method: string;
  route: string;
  status: number;
  ms: number;
  orgId: string | null;
  actor: string | null;
  ip: string | null;
}

export function writeAccessLog(entry: AccessEntry, format: LogFormat = logFormat()) {
  writeLog('access', entry.status >= 500 ? 'error' : entry.status >= 400 ? 'warn' : 'info', { ...entry }, format);
}
