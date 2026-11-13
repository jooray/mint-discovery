const test = require("node:test");
const assert = require("node:assert");
const { fetchMintInfo, fetchMintInfoBatch, MAX_INFO_BYTES } = require("../mint-info-fetcher");
const { parseReviewEvent, parseMintInfoEvent, MAX_U_TAGS_PER_EVENT } = require("../nostr-client");
const { createAggregator, MAX_DISCOVERY_URLS } = require("../aggregator");
const { isAcceptableMintUrl } = require("../url-policy");
const { create } = require("../index");

const now = () => Math.floor(Date.now() / 1000);

// Replace global fetch for one test; returns a restore function.
function mockFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

// A response whose headers arrive but whose body never does, and which ignores
// the abort signal (the worst case: only the fetcher's own race can end it).
function stalledBodyResponse() {
  return {
    ok: true,
    headers: new Map(),
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => {},
      }),
    },
  };
}

function jsonResponse(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let sent = false;
  return {
    ok: true,
    headers: new Map(),
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => {},
      }),
    },
  };
}

test("stalled body resolves {error:true} within the timeout", async () => {
  const restore = mockFetch(async () => stalledBodyResponse());
  try {
    const started = Date.now();
    const result = await fetchMintInfo("https://stall.example", 150);
    assert.strictEqual(result.error, true);
    assert.strictEqual(result.info, null);
    assert.ok(Date.now() - started < 1000, "should give up shortly after the timeout");
  } finally {
    restore();
  }
});

test("headers that never arrive also resolve on time, even if fetch ignores abort", async () => {
  const restore = mockFetch(() => new Promise(() => {}));
  try {
    const started = Date.now();
    const result = await fetchMintInfo("https://stall.example", 150);
    assert.strictEqual(result.error, true);
    assert.ok(Date.now() - started < 1000);
  } finally {
    restore();
  }
});

test("body over the byte cap is rejected", async () => {
  const big = new Uint8Array(64 * 1024).fill(0x20);
  let reads = 0;
  const restore = mockFetch(async () => ({
    ok: true,
    headers: new Map(),
    body: {
      getReader: () => ({
        read: async () => (reads++ < 10 ? { done: false, value: big } : { done: true }),
        cancel: async () => {},
      }),
    },
  }));
  try {
    const result = await fetchMintInfo("https://big.example", 1000);
    assert.strictEqual(result.error, true);
    assert.ok(reads * big.byteLength <= MAX_INFO_BYTES + big.byteLength);
  } finally {
    restore();
  }
});

test("good body parses; text() fallback works without a reader", async () => {
  let restore = mockFetch(async () => jsonResponse({ name: "M" }));
  try {
    const result = await fetchMintInfo("https://m.example/", 1000);
    assert.strictEqual(result.error, false);
    assert.strictEqual(result.info.name, "M");
  } finally {
    restore();
  }
  restore = mockFetch(async () => ({ ok: true, headers: new Map(), text: async () => '{"name":"T"}' }));
  try {
    const result = await fetchMintInfo("https://m.example", 1000);
    assert.strictEqual(result.info.name, "T");
  } finally {
    restore();
  }
});

test("batch deadline ends the batch even when every server stalls", async () => {
  const restore = mockFetch(async () => stalledBodyResponse());
  try {
    const urls = Array.from({ length: 50 }, (_, i) => `https://s${i}.example`);
    const started = Date.now();
    const results = await fetchMintInfoBatch(urls, {
      concurrency: 2,
      delayMs: 1,
      timeout: 60000,
      batchTimeout: 200,
    });
    assert.ok(Date.now() - started < 1500);
    // Nothing finished before the deadline, so nothing is reported (not even as offline).
    assert.strictEqual(results.length, 0);
  } finally {
    restore();
  }
});

test("50 u-tags in one review event -> at most 5 fetches", async () => {
  const tags = [["k", "38172"]];
  for (let i = 0; i < 50; i++) tags.push(["u", `https://flood${i}.example`]);
  const event = { kind: 38000, id: "ev", pubkey: "p", created_at: 1, content: "[5/5]", tags };
  const reviews = parseReviewEvent(event);
  assert.strictEqual(reviews.length, MAX_U_TAGS_PER_EVENT);
  assert.strictEqual(MAX_U_TAGS_PER_EVENT, 5);

  const fetched = [];
  const restore = mockFetch(async (url) => {
    fetched.push(url);
    return jsonResponse({ name: "x" });
  });
  const discovery = create({ useStorage: false, httpDelayMs: 1 });
  discovery.nostrClient.fetchMintInfoEvents = async () => [];
  discovery.nostrClient.fetchReviewEvents = async () => parseReviewEvent(event);
  try {
    const recs = await discovery.discover();
    assert.ok(fetched.length <= 5, `fetched ${fetched.length}`);
    assert.ok(recs.length <= 5);
  } finally {
    restore();
    discovery.close();
  }
});

test("non-https, IP-literal and local URLs are rejected everywhere", async () => {
  const bad = [
    "http://mint.example",
    "ftp://mint.example",
    "https://127.0.0.1",
    "https://10.0.0.1:3338",
    "https://2130706433",
    "https://0x7f.1",
    "https://[::1]",
    "https://localhost",
    "https://foo.localhost",
    "https://nas.local",
    "https://router",
    "https://user:pw@mint.example",
    "not a url",
  ];
  for (const url of bad) assert.strictEqual(isAcceptableMintUrl(url), false, url);
  assert.strictEqual(isAcceptableMintUrl("https://mint.example.com"), true);
  assert.strictEqual(isAcceptableMintUrl("https://mint.example.com:3338/path/"), true);

  const ev = (url) => ({ kind: 38000, id: "e", pubkey: "p", created_at: 1, content: "", tags: [["k", "38172"], ["u", url]] });
  assert.strictEqual(parseReviewEvent(ev("http://mint.example")).length, 0);
  assert.strictEqual(parseReviewEvent(ev("https://192.168.1.1")).length, 0);
  assert.strictEqual(
    parseMintInfoEvent({ kind: 38172, pubkey: "p", tags: [["u", "http://mint.example"]], content: "" }),
    null
  );

  const agg = createAggregator();
  agg.addReview({ url: "http://mint.example", pubkey: "p", eventId: "e1", created_at: 1 });
  agg.setHttpInfo("https://localhost", { info: {}, error: false, fetchedAt: now() });
  assert.deepStrictEqual(agg.getAllUrls(), []);

  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return jsonResponse({});
  });
  try {
    const result = await fetchMintInfo("http://mint.example");
    assert.strictEqual(result.error, true);
    assert.strictEqual(calls, 0);
  } finally {
    restore();
  }
});

test("URL cap prefers announced or multiply reviewed mints", () => {
  const agg = createAggregator();
  for (let i = 0; i < MAX_DISCOVERY_URLS + 50; i++) {
    agg.addReview({ url: `https://junk${i}.example`, pubkey: "spammer", eventId: `j${i}`, created_at: 1 });
  }
  agg.addMintInfo({ url: "https://announced.example", created_at: 1 });
  agg.addReview({ url: "https://popular.example", pubkey: "a", eventId: "p1", created_at: 1 });
  agg.addReview({ url: "https://popular.example", pubkey: "b", eventId: "p2", created_at: 1 });
  const urls = agg.getAllUrls();
  assert.strictEqual(urls.length, MAX_DISCOVERY_URLS);
  assert.ok(urls.includes("https://announced.example"));
  assert.strictEqual(urls[0], "https://popular.example");
  assert.ok(agg.getRecommendations().length <= MAX_DISCOVERY_URLS);
});

test("cached httpInfo is evicted when stale or no longer on Nostr", async () => {
  const agg = createAggregator();
  agg.setHttpInfo("https://old.example", { info: {}, error: false, fetchedAt: now() - 8 * 24 * 3600 });
  agg.setHttpInfo("https://gone.example", { info: {}, error: false, fetchedAt: now() });
  agg.setHttpInfo("https://kept.example", { info: {}, error: false, fetchedAt: now() });
  agg.pruneHttpInfo({ keepUrls: ["https://kept.example/", "https://old.example"] });
  assert.deepStrictEqual(agg.getAllUrls(), ["https://kept.example"]);

  // Through discover(): an httpInfo record for a mint absent from this run's Nostr set goes away.
  const restore = mockFetch(async () => jsonResponse({ name: "x" }));
  const discovery = create({ useStorage: false, httpDelayMs: 1 });
  discovery.aggregator.setHttpInfo("https://forgotten.example", { info: {}, error: false, fetchedAt: now() });
  discovery.nostrClient.fetchMintInfoEvents = async () => [{ url: "https://live.example", created_at: 1 }];
  discovery.nostrClient.fetchReviewEvents = async () => [];
  try {
    const recs = await discovery.discover();
    assert.deepStrictEqual(recs.map((r) => r.url), ["https://live.example"]);
  } finally {
    restore();
    discovery.close();
  }
});
