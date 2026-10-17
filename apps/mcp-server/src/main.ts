#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ResutoApi } from './api.js';
import { loadConfig } from './config.js';
import { createHttpApp } from './http.js';
import { log } from './log.js';
import { createMcpServer } from './mcp.js';

async function runStdio() {
  const config = loadConfig();
  if (!config.stdioKey) throw new Error('Set RESUTO_MCP_KEY to a ResutoMCP connection key (rmcp_…) for --stdio mode');
  const api = new ResutoApi(config.apiUrl, config.stdioKey, config.apiTimeoutMs);
  const who = await api.whoami();
  const server = createMcpServer(api, who);
  await server.connect(new StdioServerTransport());
  log('info', 'stdio session ready', { clientId: who.clientId, orgId: who.orgId, keyPrefix: config.stdioKey.slice(0, 13) });
}

async function runHttp() {
  const config = loadConfig();
  const app = createHttpApp(config);
  await app.listen();
  log('info', 'ResutoMCP listening', { url: `http://${config.host}:${config.port}/mcp`, publicUrl: config.publicUrl, api: config.apiUrl,
    allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

(process.argv.includes('--stdio') ? runStdio() : runHttp()).catch((e) => {
  log('error', 'fatal', { error: (e as Error)?.message ?? String(e) });
  process.exit(1);
});
