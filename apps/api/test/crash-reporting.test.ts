import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crashLine, ErrorReporter, installCrashReporting } from '../src/common/observability/error-tracking';

// Review finding on CR-14: the API reported crashes from 'uncaughtExceptionMonitor', but Node exits synchronously right
// after that listener returns, so the async POST never left the process (a local receiver logged 0 requests).

const SRC = path.resolve(__dirname, '../src/common/observability');
let server: Server;
let port = 0;
const received: Array<{ url: string; body: string }> = [];
let hang = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body });
      if (!hang) res.end('{}');   // when hanging, never answer
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

/** The real module, compiled to CommonJS, in a child process that throws from a timer (a genuine uncaught exception). */
function crashChild(dsn: string): Promise<{ code: number | null; stderr: string; ms: number }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'crash-'));
  for (const f of ['error-tracking', 'build-info']) {
    const out = ts.transpileModule(readFileSync(path.join(SRC, `${f}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    writeFileSync(path.join(dir, `${f}.js`), out.outputText);
  }
  writeFileSync(path.join(dir, 'child.js'), `
    const { installCrashReporting } = require('./error-tracking.js');
    installCrashReporting();
    setTimeout(() => { throw new Error('order failed for guest +201090001001'); }, 20);
    setInterval(() => {}, 1000);   // the process would otherwise stay alive: only the crash path may end it
  `);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'child.js')], { env: { ...process.env, ERROR_TRACKING_DSN: dsn, NODE_ENV: 'staging' } });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stderr, ms: Date.now() - started }));
  });
}

describe('crash reporting (CR-14, PS-04)', () => {
  it('a real crash in a child process delivers exactly one envelope, logs one scrubbed JSON line and exits 1', async () => {
    received.length = 0;
    hang = false;
    const { code, stderr } = await crashChild(`http://pubkey@127.0.0.1:${port}/7`);
    expect(code).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/api/7/envelope/');
    const [, item, event] = received[0].body.split('\n').map((l) => JSON.parse(l));
    expect(item.type).toBe('event');
    expect(event.tags.source).toBe('uncaughtException');
    expect(event.exception.values[0].value).toBe('order failed for guest [number]');
    const line = stderr.split('\n').find((l) => l.startsWith('{"level":"fatal"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed).toEqual(expect.objectContaining({ msg: 'process crash', origin: 'uncaughtException' }));
    expect(line).not.toContain('1090001001');
    expect(stderr).toContain('Error: order failed');   // the stack is still printed, as Node prints it
  });

  it('never hangs on an unresponsive tracker: the process still exits 1 within the bounded wait', async () => {
    received.length = 0;
    hang = true;
    const { code, ms, stderr } = await crashChild(`http://pubkey@127.0.0.1:${port}/7`);
    expect(code).toBe(1);
    expect(ms).toBeLessThan(6000);
    expect(stderr).toContain('"msg":"process crash"');
    hang = false;
  });

  it('without a DSN the crash is still logged as one JSON line and the process exits 1', async () => {
    received.length = 0;
    const { code, stderr } = await crashChild('');
    expect(code).toBe(1);
    expect(received).toHaveLength(0);
    expect(stderr).toContain('"msg":"process crash"');
  });

  it('waits for the report before exiting, and a second failure while reporting exits at once', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    let release!: () => void;
    const pending = new Promise<'sent'>((r) => { release = () => r('sent'); });
    const reporter = { capture: () => pending } as unknown as ErrorReporter;
    const lines: string[] = [];
    const off = installCrashReporting({ target: target as unknown as NodeJS.Process, reporter: () => reporter, exit: (c) => exits.push(c), write: (t) => lines.push(t), timeoutMs: 5000 });
    target.emit('uncaughtException', new Error('first'), 'uncaughtException');
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([]);   // still reporting
    target.emit('uncaughtException', new Error('second'), 'uncaughtException');
    expect(exits).toEqual([1]);   // re-entrant failure: exit now
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual([1, 1]);
    expect(lines.filter((l) => l.startsWith('{')).length).toBe(1);
    off();
  });

  it('the crash line carries only the scrubbed error, frames and build', () => {
    const line = JSON.parse(crashLine(new Error('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc for a@b.co'), 'unhandledRejection'));
    expect(line.error.message).not.toMatch(/eyJ|a@b\.co/);
    expect(line.origin).toBe('unhandledRejection');
  });
});
