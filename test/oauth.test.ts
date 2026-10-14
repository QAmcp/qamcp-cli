// The local page that catches the "login approved" redirect. No real login server needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALLBACK_PORT, waitForLoginRedirect } from '../src/oauth.js';

const hit = (query: string) => fetch(`http://127.0.0.1:${CALLBACK_PORT}/callback?${query}`, { headers: { connection: 'close' } });

test('accepts the redirect when the state matches, and hands back the code', async () => {
  const { done } = waitForLoginRedirect('abc');
  await new Promise((r) => setTimeout(r, 100));
  const res = await hit('code=xyz&state=abc&iss=https%3A%2F%2Flogin.example');
  assert.equal(res.status, 200);
  const params = await done;
  assert.equal(params.get('code'), 'xyz');
  assert.equal(params.get('iss'), 'https://login.example');
});

test('rejects a redirect with the wrong state (possible forgery)', async () => {
  const { done } = waitForLoginRedirect('abc');
  const failed = assert.rejects(done, /state mismatch/);
  await new Promise((r) => setTimeout(r, 100));
  const res = await hit('code=xyz&state=evil');
  assert.equal(res.status, 400);
  assert.doesNotMatch(await res.text(), /evil/);
  await failed;
});

test('rejects a cancelled login without showing the server error text', async () => {
  const { done } = waitForLoginRedirect('abc');
  const failed = assert.rejects(done, /cancelled or refused/);
  await new Promise((r) => setTimeout(r, 100));
  const res = await hit('error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=abc');
  assert.doesNotMatch(await res.text(), /script/);
  await failed;
});

import { rmSync } from 'node:fs';
import { runTest } from '../src/runTest.js';
import { startAuthServer } from './authServer.js';

test('command-line --login, start to finish: login page, approval, token, test, and the login is reused next time', async () => {
  const svc = await startAuthServer(4770);
  const url = `${svc.origin}/mcp`;
  rmSync('.qamcp/auth/127-0-0-1-4770-mcp.json', { force: true });
  let pagesOpened = 0;
  // Plays the person's browser: open the login page, approve, follow the redirect home.
  const onLoginUrl = (loginUrl: URL) => {
    pagesOpened++;
    void (async () => {
      const page = await fetch(loginUrl, { redirect: 'manual', headers: { connection: 'close' } });
      await fetch(page.headers.get('location')!, { headers: { connection: 'close' } });
    })();
  };
  try {
    const first = await runTest(url, { login: { onLoginUrl }, timeoutMs: 15_000 });
    assert.equal(first.checks.find((c) => c.id === 'connect')!.status, 'pass');
    assert.equal(first.testedAs?.loggedIn, true);
    assert.equal(pagesOpened, 1);
    assert.ok(first.calls.some((c) => c.tool === 'whoami' && c.outcome === 'ok'));

    const second = await runTest(url, { login: { onLoginUrl }, timeoutMs: 15_000 });
    assert.equal(second.checks.find((c) => c.id === 'connect')!.status, 'pass');
    assert.equal(pagesOpened, 1, 'the saved login was reused: no second login page');
  } finally {
    rmSync('.qamcp/auth/127-0-0-1-4770-mcp.json', { force: true });
    svc.http.closeAllConnections();
    svc.http.close();
  }
});
