/** Structured logs on stderr (stdout is the MCP channel in stdio mode). Never log keys — only their prefix. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
}
