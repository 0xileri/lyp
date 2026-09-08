import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/index.js";
import { Guardrail } from "../src/guardrail.js";
import { AccountStateService, FixtureProvider } from "../src/agentos/account.js";
import { DIVERSIFIED } from "../fixtures/accounts.js";

/**
 * Entry-point tests.
 *
 * These exist because a syntax error in index.js once shipped green: every
 * other test imports the modules underneath it and never the file that wires
 * them together, so nothing failed until the deployment booted. Importing
 * createApp at all is most of the value here; the assertions are the rest.
 *
 * No network: the routes that reach Agent OS are not exercised.
 */

function appFixture() {
  const guardrail = new Guardrail({
    stateService: new AccountStateService(new FixtureProvider(DIVERSIFIED)),
  });
  return createApp({ guardrail, provider: "fixture" });
}

/** Start on an ephemeral port, run `fn`, always close. */
async function withServer(fn) {
  const server = appFixture().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the app module loads and constructs", () => {
  assert.equal(typeof createApp, "function");
  assert.ok(appFixture());
});

test("GET /health reports mode and declares read-only scope", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.provider, "fixture");
    assert.equal(body.exchangeScope, "read-only");
  });
});

test("GET / serves the landing page", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>lyp/);
    assert.ok(!html.includes("${"), "no unresolved template expressions");
  });
});

test("POST /check returns a verdict", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: { symbol: "ETHUSDT", side: "BUY", quantity: 12, orderType: "MARKET" },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.verdict, "BLOCK");
    assert.ok(body.violations.length > 0);
  });
});

test("a malformed request is rejected without reading as permission", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: { symbol: "ETHUSDT", side: "LONG" } }),
    });
    assert.equal(res.status, 400);
    // A caller that reads `verdict` blindly must never see anything permissive.
    assert.equal((await res.json()).verdict, "BLOCK");
  });
});

test("GET /connect refuses usefully when no client id is configured", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/connect`, { redirect: "manual" });
    // Agent OS issues client ids out of band, so this is a configuration gap
    // rather than a bug, and the response says which.
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /AGENT_OS_CLIENT_ID/);
    assert.match(body.redirectUri, /\/callback$/);
  });
});

test("GET /callback refuses an unknown authorization state", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/callback?code=abc&state=never-issued`);
    // Replays and forgeries both land here; neither should be exchanged.
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Not connected/);
  });
});

test("GET /mcp is refused explicitly rather than 404ing", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`);
    assert.equal(res.status, 405);
    assert.match((await res.json()).error.message, /stateless/);
  });
});

test("POST /verify authorizes exactly the order that was approved", async () => {
  await withServer(async (base) => {
    const checked = await (
      await fetch(`${base}/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: { symbol: "ETHUSDT", side: "BUY", quantity: 2, orderType: "MARKET" },
        }),
      })
    ).json();

    assert.equal(checked.verdict, "ALLOW");
    assert.ok(checked.approval?.token, "a permitted verdict carries an approval");

    const verify = (order) =>
      fetch(`${base}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approval: checked.approval.token, order }),
      });

    // Larger than approved: refused, and the approval survives for a correct
    // attempt afterwards.
    const tooBig = await verify({ symbol: "ETHUSDT", side: "BUY", quantity: 50, orderType: "MARKET" });
    assert.equal(tooBig.status, 403);
    assert.equal((await tooBig.json()).code, "QUANTITY_EXCEEDED");

    const ok = await verify({ symbol: "ETHUSDT", side: "BUY", quantity: 2, orderType: "MARKET" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).valid, true);

    // Single-use.
    const replay = await verify({ symbol: "ETHUSDT", side: "BUY", quantity: 2, orderType: "MARKET" });
    assert.equal(replay.status, 403);
    assert.equal((await replay.json()).code, "ALREADY_USED");
  });
});

test("a BLOCK carries no approval to present", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: { symbol: "ETHUSDT", side: "BUY", quantity: 12, orderType: "MARKET" },
      }),
    });
    const body = await res.json();

    assert.equal(body.verdict, "BLOCK");
    assert.equal(body.approval, null, "there is no approval that says no");
  });
});
