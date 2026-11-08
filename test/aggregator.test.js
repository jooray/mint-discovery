const test = require("node:test");
const assert = require("node:assert");
const { createAggregator, compareRecommendations } = require("../aggregator");
const { isCacheFresh } = require("../mint-info-fetcher");
const { parseRatingAndComment } = require("../review-parser");
const { parseReviewEvent, parseMintInfoEvent } = require("../nostr-client");

const now = () => Math.floor(Date.now() / 1000);

function review(url, pubkey, created_at, rating, eventId) {
  return { url, pubkey, created_at, rating, comment: "", eventId: eventId || `${pubkey}-${created_at}` };
}

test("cache freshness works with what the aggregator stores", () => {
  const agg = createAggregator();
  agg.setHttpInfo("https://m.example", { url: "https://m.example", info: {}, error: false, fetchedAt: now() });
  assert.strictEqual(isCacheFresh(agg.getHttpInfo("https://m.example"), 3600), true);
  // a recommendation carries lastHttpInfoFetchAt, also accepted
  assert.strictEqual(isCacheFresh(agg.getRecommendation("https://m.example"), 3600), true);
  assert.strictEqual(isCacheFresh(null, 3600), false);
  assert.strictEqual(isCacheFresh({ fetchedAt: now() - 7200 }, 3600), false);
  // failed fetches are retried
  assert.strictEqual(isCacheFresh({ fetchedAt: now(), error: true }, 3600), false);
});

test("latest review per author wins regardless of arrival order", () => {
  const agg = createAggregator();
  // newest first, as relays send them
  agg.addReview(review("https://m.example", "alice", 200, 1));
  agg.addReview(review("https://m.example", "alice", 100, 5));
  let r = agg.getReviewsForUrl("https://m.example");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].rating, 1);
  // oldest first
  const agg2 = createAggregator();
  agg2.addReview(review("https://m.example", "alice", 100, 5));
  agg2.addReview(review("https://m.example", "alice", 200, 1));
  r = agg2.getReviewsForUrl("https://m.example");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].rating, 1);
});

test("many bad ratings do not outrank good ones", () => {
  const agg = createAggregator();
  for (let i = 0; i < 30; i++) agg.addReview(review("https://scam.example", "s" + i, 100, 1));
  for (let i = 0; i < 25; i++) agg.addReview(review("https://good.example", "g" + i, 100, 5));
  agg.addReview(review("https://one.example", "x", 100, 5));
  agg.addReview(review("https://unrated.example", "y", 100, null));
  const order = agg.getRecommendations().map((m) => m.url);
  assert.deepStrictEqual(order, [
    "https://good.example",
    "https://one.example",
    "https://unrated.example",
    "https://scam.example",
  ]);
  const good = agg.getRecommendation("https://good.example");
  assert.strictEqual(good.ratingsCount, 25);
  assert.ok(good.score > 4.8 && good.score < 5);
});

test("unreachable mints sort after reachable ones", () => {
  const recs = [
    { url: "a", error: true, score: 5, ratingsCount: 10 },
    { url: "b", error: false, score: 3, ratingsCount: 0 },
  ];
  assert.deepStrictEqual(recs.sort(compareRecommendations).map((m) => m.url), ["b", "a"]);
});

test("trailing slash does not split a mint", () => {
  const agg = createAggregator();
  agg.addReview(review("https://m.example/", "alice", 100, 5));
  agg.setHttpInfo("https://m.example", { info: { name: "M" }, error: false, fetchedAt: now() });
  agg.addMintInfo({ url: " https://m.example// ", created_at: 1 });
  assert.deepStrictEqual(agg.getAllUrls(), ["https://m.example"]);
  const rec = agg.getRecommendation("https://m.example/");
  assert.strictEqual(rec.reviewsCount, 1);
  assert.strictEqual(rec.info.name, "M");
});

test("u tag: absent or 'cashu' label accepted, other labels rejected", () => {
  const ev = (tags) => ({ kind: 38000, id: "e", pubkey: "p", created_at: 1, content: "[4/5] ok", tags: [["k", "38172"], ...tags] });
  assert.strictEqual(parseReviewEvent(ev([["u", "https://a.example"]])).length, 1);
  assert.strictEqual(parseReviewEvent(ev([["u", "https://a.example", "cashu"]])).length, 1);
  assert.strictEqual(parseReviewEvent(ev([["u", "https://a.example", "fedimint"]])).length, 0);
  assert.strictEqual(parseReviewEvent(ev([["u", "fed11abc", "fedimint"], ["u", "https://b.example", "cashu"]]))[0].url, "https://b.example");
  const info = parseMintInfoEvent({ kind: 38172, pubkey: "p", tags: [["d", "x"], ["u", "https://a.example"]], content: "" });
  assert.strictEqual(info.url, "https://a.example");
});

test("rating must lead the review", () => {
  assert.deepStrictEqual(parseRatingAndComment("[5/5] Great"), { rating: 5, comment: "Great" });
  assert.deepStrictEqual(parseRatingAndComment("  [3 / 5]"), { rating: 3, comment: "" });
  assert.deepStrictEqual(parseRatingAndComment("Scam! Used to be [5/5], now steals funds"), {
    rating: null,
    comment: "Scam! Used to be [5/5], now steals funds",
  });
  assert.strictEqual(parseRatingAndComment("[0/5] bad").rating, null);
  assert.strictEqual(parseRatingAndComment("[1/5] line1\nline2").comment, "line1\nline2");
});
