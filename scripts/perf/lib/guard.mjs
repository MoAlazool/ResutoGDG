// Shared safety checks for the perf harness: it writes to databases and drives load, so it only ever touches
// local, explicitly named, disposable targets.

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/** Databases the harness must never write: the shared demo, the default dev database, E2E databases. */
const PROTECTED = [/^resuto$/, /^resuto_demo$/, /^resuto_e2e/, /^postgres$/, /^template\d$/];

export function assertLocalDatabase(url, { write = false } = {}) {
  const u = new URL(url);
  if (!LOCAL_HOSTS.has(u.hostname)) throw new Error(`Refusing a non-local database (${u.hostname}). The perf harness is local-only.`);
  const name = u.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unsupported database name: ${name}`);
  if (write && PROTECTED.some((re) => re.test(name))) throw new Error(`Refusing to write to protected database ${name}. Use a dedicated copy.`);
  return name;
}

export function assertLocalUrl(url) {
  const u = new URL(url);
  if (!LOCAL_HOSTS.has(u.hostname) && process.env.PERF_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing to measure ${u.host}: local only (set PERF_ALLOW_REMOTE=1 for a staging run; never production).`);
  }
  return u;
}

export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
