// What kind of failure is this? One place that sorts every error a server can send back.
//
// The rule: a failure needs evidence. Only answers that prove the server broke count against
// it (a server error, a dropped connection, a reply that breaks the MCP rules). Answers that
// mean "no" on purpose (sign in, slow down, bad request) are judged as what they are. And
// anything we can't interpret is "not counted", never blamed on the server.

import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

export type ErrorKind =
  | 'timeout' //        no answer in time
  | 'refused' //        a deliberate "no": an MCP error, or HTTP 400/404/405/409/413/415/422
  | 'needs-login' //    HTTP 401/403, or the server says to sign in
  | 'rate-limited' //   HTTP 429: the server asked us to slow down
  | 'unavailable' //    HTTP 503: temporarily down
  | 'server-error' //   HTTP 500, 502, 504 and other 5xx: the server failed
  | 'dropped' //        the connection was cut before an answer
  | 'bad-reply' //      an answer that breaks the MCP rules (not JSON, wrong shape, a web page, empty)
  | 'unclear'; //       anything else: we can't tell, so it doesn't count

export interface ClassifiedError {
  kind: ErrorKind;
  status?: number; // the HTTP status, when there was one
  text: string; // the error as text (scanned for leaked secrets)
  message: string; // the server's own words, when it sent a proper MCP error
}

const SIGN_IN = /unauthori[sz]ed|forbidden|sign[ -]?in\b|log[ -]?in required|not authenticated|authentication required|invalid_token|access token/i;
const REFUSED_STATUS = new Set([400, 404, 405, 406, 409, 410, 413, 415, 422]);

export function classifyError(err: unknown): ClassifiedError {
  const text = errorText(err);
  const status = httpStatus(err);

  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return { kind: 'timeout', status, text: '', message: '' };
  // The official client raises these itself, as protocol errors, when a reply breaks the tool's
  // own output promise. That is the server breaking a MUST, not the server saying "no".
  if (/has an output schema but did not return structured content|Structured content does not match the tool's output schema/i.test(text))
    return { kind: 'bad-reply', status, text, message: '' };
  if (err instanceof ProtocolError) return { kind: 'refused', status, text, message: err.message };

  if (status === 401 || status === 403) return { kind: 'needs-login', status, text, message: '' };
  if (status === 429) return { kind: 'rate-limited', status, text, message: '' };
  if (status === 503) return { kind: 'unavailable', status, text, message: '' };
  if (status !== undefined && status >= 500) return { kind: 'server-error', status, text, message: '' };
  // A proper MCP error sent with an HTTP error status (like 400) is still a deliberate "no".
  const rpcMessage = text.match(/"error"\s*:\s*\{\s*"code"\s*:\s*-?\d+\s*,\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  if (rpcMessage) return { kind: 'refused', status, text: rpcMessage, message: rpcMessage };
  if (status !== undefined && REFUSED_STATUS.has(status)) return { kind: 'refused', status, text, message: '' };
  if (status === undefined && SIGN_IN.test(text)) return { kind: 'needs-login', status, text, message: '' };

  // Replies the official client refuses because they break the rules, including a tool's own
  // output promise (outputSchema), which the spec says it MUST keep.
  if (/Invalid result for|is not valid JSON|Unexpected end of JSON|Unexpected token|Unexpected content type|Invalid JSON|has an output schema but did not return structured content|Structured content does not match the tool's output schema/i.test(text))
    return { kind: 'bad-reply', status, text, message: '' };
  if (/fetch failed|ECONNRESET|socket hang up|other side closed|ECONNREFUSED|EPIPE|terminated|Connection closed/i.test(text))
    return { kind: 'dropped', status, text, message: '' };
  return { kind: 'unclear', status, text, message: '' };
}

// "images/0/price must be number, images/1/price must be number, …" said once:
// "images/*/price must be number (in 10 items)". The same broken field in every item
// of a list is one problem, not ten.
export function schemaIssueWords(text: string): string {
  const groups = new Map<string, number>();
  for (const raw of text.replace(/(^|[\s,;])data\/?/g, '$1').split(/[,;]\s+(?=\S+ must |must )/)) {
    const issue = raw.trim();
    if (!issue) continue;
    const key = issue.replace(/\/\d+(?=\/|\s)/g, '/*');
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const shown = [...groups].slice(0, 2).map(([issue, n]) => (n > 1 ? `${issue} (in ${n} items)` : issue));
  return shown.join('; ') + (groups.size > 2 ? `; and ${groups.size - 2} more` : '');
}

// Plain words for a reply that broke the MCP rules.
export function badReplyWords(text: string): string {
  if (/has an output schema but did not return structured content/i.test(text)) return 'it promised a structured answer (outputSchema) but sent none';
  const mismatch = text.match(/Structured content does not match the tool's output schema:\s*(.*)$/i);
  if (mismatch) return `its structured answer doesn't match its own output schema (${schemaIssueWords(mismatch[1])})`;
  if (/Unexpected content type: text\/html/i.test(text)) return 'it sent a web page instead of an MCP reply';
  if (/Unexpected end of JSON/i.test(text)) return 'it sent an empty reply';
  if (/is not valid JSON|Unexpected token|Invalid JSON/i.test(text)) return 'its reply is not valid JSON';
  if (/"user",\s*"assistant"/.test(text) && /role/.test(text)) return 'a message uses a role other than "user" or "assistant"';
  const path = text.match(/"path":\s*\[([^\]]*)\]/)?.[1]?.replace(/[\s"]/g, '').replace(/,/g, '.');
  const expected = text.match(/"expected":\s*"([^"]+)"/)?.[1];
  if (path && expected) return `"${path}" should be ${/^[aeiou]/i.test(expected) ? 'an' : 'a'} ${expected}`;
  const msg = text.match(/"message":\s*"([^"]+)"/)?.[1];
  return msg ?? 'its reply has the wrong shape';
}

function httpStatus(err: unknown): number | undefined {
  const s = (err as any)?.data?.status ?? (err as any)?.status;
  if (typeof s === 'number') return s;
  if (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpAuthentication) return 401;
  if (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpForbidden) return 403;
  return undefined;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) {
    const data = (err as any).data;
    const own = data !== undefined ? `${err.message} ${typeof data === 'string' ? data : JSON.stringify(data)}` : err.message;
    // The real reason is often a layer or two down ("fetch failed" → cause → code).
    const causes: string[] = [];
    let c: any = (err as any).cause;
    for (let i = 0; c && i < 4; i++, c = c.cause) causes.push([c.code, c.message].filter(Boolean).join(' '));
    return [own, ...causes].filter(Boolean).join(' ');
  }
  return String(err);
}
