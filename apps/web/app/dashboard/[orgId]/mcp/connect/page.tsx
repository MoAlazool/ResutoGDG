'use client';
import { Card, Notice } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { CopyButton, McpPage } from '../_components/shared';

/** Public HTTPS URL of the deployed ResutoMCP server, e.g. https://mcp.example.com/mcp */
const CONFIGURED_URL = process.env.NEXT_PUBLIC_MCP_URL?.replace(/\/$/, '') ?? null;

function Snippet({ text }: { text: string }) {
  return (
    <div style={{ position: 'relative' }}>
      <pre dir="ltr" className="code-block is-dark">{text}</pre>
      <div style={{ position: 'absolute', insetBlockStart: 8, insetInlineEnd: 8 }}><CopyButton text={text} className="btn btn-sm btn-ghost" /></div>
    </div>
  );
}

export default function McpConnectPage() {
  const { t } = useT();
  const url = CONFIGURED_URL ?? 'https://mcp.example.com/mcp';
  const desktop = JSON.stringify({
    mcpServers: {
      resuto: {
        command: 'npx',
        args: ['-y', 'mcp-remote@0.14.3', url, '--header', 'Authorization:${RESUTO_AUTH}'],
        env: { RESUTO_AUTH: 'Bearer rmcp_…' },
      },
    },
  }, null, 2);

  return (
    <McpPage tab="connect" permission="mcp:approve">
      <div className="stack gap-16">
        <Notice tone="warn">{t('mcp.connect.untested')}</Notice>
        <Card title={t('mcp.connect.url')}>
          {!CONFIGURED_URL && <Notice tone="info">{t('mcp.connect.urlMissing')}</Notice>}
          <div className="row mbs-10">
            <code dir="ltr" style={{ fontSize: 15, wordBreak: 'break-all' }}>{url}</code>
            <CopyButton text={url} />
          </div>
          <h3 className="mbe-6">{t('mcp.connect.header')}</h3>
          <p className="fine mbs-0">{t('mcp.connect.headerBody')}</p>
          <Snippet text={'Authorization: Bearer rmcp_…'} />
        </Card>

        <div className="grid grid-2">
          <Card title={t('mcp.connect.claudeDesktop')}>
            <p className="fine mbs-0">{t('mcp.connect.claudeDesktopBody')}</p>
            <Snippet text={desktop} />
          </Card>
          <div className="stack gap-16">
            <Card title={t('mcp.connect.claudeAi')}>
              <p className="fine mbs-0">{t('mcp.connect.claudeAiBody')}</p>
              <Snippet text={`${url}/rmcp_…`} />
            </Card>
            <Card title={t('mcp.connect.chatgpt')}>
              <p className="fine mbs-0">{t('mcp.connect.chatgptBody')}</p>
              <Snippet text={`${url}/rmcp_…`} />
            </Card>
          </div>
        </div>
        <Notice tone="info">{t('mcp.connect.oauth')}</Notice>

        <Card title={t('mcp.connect.safety')}>
          <ul className="stack" style={{ margin: 0, paddingInlineStart: 20, gap: 6 }}>
            {[1, 2, 3, 4].map((i) => <li key={i}>{t(`mcp.connect.safety${i}`)}</li>)}
          </ul>
        </Card>
      </div>
    </McpPage>
  );
}
