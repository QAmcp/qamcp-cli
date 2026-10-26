// "Blocks other websites" for servers on this computer. The MCP spec says servers MUST check the Origin
// header: otherwise any website open in your browser can quietly send commands to an MCP server on
// localhost (a "DNS rebinding" attack). We send the same harmless hello twice, once as a normal app
// and once claiming to come from a strange website, and compare. No tools are called.
// Not scored yet (weight 0), so it can't push anyone's commit hook below its bar overnight.

import type { CheckResult, Finding } from './types.js';

export const ORIGIN_ID = 'origin';
export const ORIGIN_TITLE = 'Blocks requests from other websites (not scored yet)';
const STRANGE_SITE = 'https://qamcp-origin-check.example';

export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
  } catch {
    return false;
  }
}

export async function originCheck(url: string, headers: Record<string, string>, protocolVersion: string | undefined, timeoutMs: number, fetchImpl: typeof fetch = fetch): Promise<CheckResult | undefined> {
  if (!isLocalUrl(url)) return undefined;
  const hello = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: protocolVersion ?? '2025-06-18', capabilities: {}, clientInfo: { name: 'qamcp-origin-check', version: '1' } } });
  const send = async (origin?: string): Promise<number | undefined> => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(origin ? { origin } : {}) },
        body: hello,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.text().catch(() => '');
      // Don't leave a session open on the server because of us.
      const session = res.headers.get('mcp-session-id');
      if (session) await fetchImpl(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session }, signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
      return res.status;
    } catch {
      return undefined;
    }
  };
  const normal = await send();
  const finding = (status: Finding['status'], message: string, skip = false): CheckResult => ({
    id: ORIGIN_ID, title: ORIGIN_TITLE, status: skip ? 'skip' : status, summary: skip ? 'Not tested' : status === 'pass' ? 'All good' : '1 tip (not scored)', findings: [{ status: skip ? 'skip' : status, message }], weight: 0,
  });
  if (normal === undefined || normal >= 300) return finding('skip', `Couldn't tell: our plain hello didn't get a normal answer${normal ? ` (HTTP ${normal})` : ''}, so there was nothing to compare with`, true);
  const strange = await send(STRANGE_SITE);
  if (strange === undefined) return finding('skip', "Couldn't tell: the request from another website got no answer at all", true);
  if (strange >= 400) return finding('pass', `Refused a request claiming to come from another website (HTTP ${strange}), as the MCP spec asks`);
  return finding('warn', `Accepted a request claiming to come from another website (${STRANGE_SITE}). The MCP spec says local servers must check the Origin header; without it, any website open in your browser could send commands to this server.`);
}
