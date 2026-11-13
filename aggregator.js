/**
 * Aggregator for Cashu mint recommendations.
 * Processes reviews and mint info to generate sorted recommendations.
 */

/**
 * @typedef {Object} MintReview
 * @property {string} eventId - Nostr event ID
 * @property {string} pubkey - Author's public key
 * @property {number} created_at - Unix timestamp
 * @property {number|null} rating - Rating 1-5 or null
 * @property {string} comment - Review comment
 * @property {string} url - Mint URL
 */

/**
 * @typedef {Object} MintRecommendation
 * @property {string} url - Mint URL
 * @property {number} reviewsCount - Number of reviews (latest per author, rated or not)
 * @property {number} ratingsCount - Number of those reviews that carry a 1-5 rating
 * @property {number|null} averageRating - Average rating or null
 * @property {number} score - Ranking score (see rankingScore)
 * @property {Object} [info] - HTTP /v1/info response
 * @property {boolean} error - Whether last HTTP fetch failed
 * @property {number} [lastHttpInfoFetchAt] - Unix timestamp of last fetch
 */

// Ranking: every mint starts with PRIOR_WEIGHT imaginary reviews of PRIOR_RATING
// stars, and its real ratings are averaged in on top. A mint with one 5-star review
// scores (2*3 + 5) / 3 = 3.67, one with twenty 5-star reviews scores 4.9, and one with
// thirty 1-star reviews scores 1.1, so many bad reviews never outrank good ones and a
// single review cannot jump the queue. Unrated mints sit at the neutral 3.0.
const PRIOR_RATING = 3;
const PRIOR_WEIGHT = 2;

// Most mint URLs one discovery run lists and fetches. Anyone can publish reviews
// naming made-up URLs; past this many, the best-supported ones win (see getAllUrls).
const MAX_DISCOVERY_URLS = 300;

// Cached /v1/info results older than this are dropped rather than shown.
const HTTP_INFO_MAX_AGE_SECONDS = 7 * 24 * 3600;

/**
 * Normalize a mint URL so "https://m.example" and "https://m.example/" are one mint.
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  if (typeof url !== "string") return url;
  return url.trim().replace(/\/+$/, "");
}

/**
 * Ranking score: average rating pulled towards PRIOR_RATING by PRIOR_WEIGHT
 * imaginary reviews (a Bayesian average).
 *
 * @param {number[]} ratings - Valid 1-5 ratings
 * @returns {number}
 */
function rankingScore(ratings) {
  const sum = ratings.reduce((a, b) => a + b, 0);
  return (PRIOR_RATING * PRIOR_WEIGHT + sum) / (PRIOR_WEIGHT + ratings.length);
}

/**
 * Sort order for recommendations: reachable mints first, then by score, then by
 * number of ratings, then URL (stable across runs).
 *
 * @param {MintRecommendation} a
 * @param {MintRecommendation} b
 * @returns {number}
 */
function compareRecommendations(a, b) {
  const errDiff = (a.error ? 1 : 0) - (b.error ? 1 : 0);
  if (errDiff !== 0) return errDiff;
  const scoreDiff = (b.score ?? PRIOR_RATING) - (a.score ?? PRIOR_RATING);
  if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
  const countDiff = (b.ratingsCount || 0) - (a.ratingsCount || 0);
  if (countDiff !== 0) return countDiff;
  return String(a.url) < String(b.url) ? -1 : String(a.url) > String(b.url) ? 1 : 0;
}

const { isAcceptableMintUrl } = require("./url-policy");

/**
 * Create an aggregator instance.
 *
 * @returns {Object} Aggregator instance
 */
function createAggregator() {
  // In-memory stores
  const reviewsByUrl = new Map();
  const mintInfoByUrl = new Map();
  const httpInfoByUrl = new Map();

  /**
   * Add or update a review.
   * Only keeps the latest review per author per mint.
   *
   * @param {MintReview} review - The review to add
   */
  function addReview(review) {
    if (!review || !review.url || !review.eventId) return;
    if (!isAcceptableMintUrl(review.url)) return;

    const url = normalizeUrl(review.url);
    review = { ...review, url };
    let reviews = reviewsByUrl.get(url) || [];

    // Check if this exact event already exists
    if (reviews.some((r) => r.eventId === review.eventId)) return;

    // Keep only the latest review per author. Events arrive in no guaranteed order
    // (relays send newest first, several relays interleave, the local cache is loaded
    // first), so compare timestamps instead of letting the last one processed win.
    const existing = reviews.find((r) => r.pubkey === review.pubkey);
    if (existing) {
      const newer =
        (review.created_at || 0) > (existing.created_at || 0) ||
        ((review.created_at || 0) === (existing.created_at || 0) &&
          String(review.eventId) > String(existing.eventId));
      if (!newer) return;
      reviews = reviews.filter((r) => r.pubkey !== review.pubkey);
    }
    reviews.push(review);

    // Sort by created_at ascending
    reviews.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

    reviewsByUrl.set(url, reviews);
  }

  /**
   * Add multiple reviews.
   *
   * @param {MintReview[]} reviews - Array of reviews to add
   */
  function addReviews(reviews) {
    if (!Array.isArray(reviews)) return;
    for (const review of reviews) {
      addReview(review);
    }
  }

  /**
   * Add mint info from Nostr event.
   *
   * @param {Object} info - Parsed mint info from Nostr
   */
  function addMintInfo(info) {
    if (!info || !info.url) return;
    if (!isAcceptableMintUrl(info.url)) return;

    const url = normalizeUrl(info.url);
    const existing = mintInfoByUrl.get(url);

    // Keep the most recent event per URL
    if (!existing || (info.created_at || 0) > (existing.created_at || 0)) {
      mintInfoByUrl.set(url, { ...info, url });
    }
  }

  /**
   * Add multiple mint info entries.
   *
   * @param {Object[]} infos - Array of mint info objects
   */
  function addMintInfos(infos) {
    if (!Array.isArray(infos)) return;
    for (const info of infos) {
      addMintInfo(info);
    }
  }

  /**
   * Set HTTP info for a mint.
   *
   * @param {string} url - Mint URL
   * @param {Object} httpResult - Result from fetchMintInfo
   */
  function setHttpInfo(url, httpResult) {
    if (!url || !httpResult) return;
    if (!isAcceptableMintUrl(url)) return;
    const key = normalizeUrl(url);
    httpInfoByUrl.set(key, { ...httpResult, url: key });
  }

  /**
   * Get the stored HTTP /v1/info result for a mint.
   *
   * @param {string} url - Mint URL
   * @returns {Object|null} { url, info, error, fetchedAt } or null
   */
  function getHttpInfo(url) {
    return httpInfoByUrl.get(normalizeUrl(url)) || null;
  }

  /**
   * Set HTTP info for multiple mints.
   *
   * @param {Object[]} results - Array of fetchMintInfo results
   */
  function setHttpInfoBatch(results) {
    if (!Array.isArray(results)) return;
    for (const result of results) {
      if (result && result.url) {
        setHttpInfo(result.url, result);
      }
    }
  }

  /**
   * Drop cached HTTP results that are too old or (when keepUrls is given) for
   * mints no longer seen on Nostr.
   *
   * @param {Object} [opts]
   * @param {Iterable<string>} [opts.keepUrls] - URLs seen in the current Nostr set
   * @param {number} [opts.maxAgeSeconds] - Maximum age of a cached result
   * @returns {string[]} Normalized URLs that were removed
   */
  function pruneHttpInfo(opts = {}) {
    const maxAge = opts.maxAgeSeconds ?? HTTP_INFO_MAX_AGE_SECONDS;
    const keep = opts.keepUrls ? new Set(Array.from(opts.keepUrls, normalizeUrl)) : null;
    const nowSec = Math.floor(Date.now() / 1000);
    const removed = [];
    for (const [url, http] of httpInfoByUrl) {
      const tooOld = !http.fetchedAt || nowSec - http.fetchedAt > maxAge;
      if (tooOld || (keep && !keep.has(url))) {
        httpInfoByUrl.delete(url);
        removed.push(url);
      }
    }
    return removed;
  }

  /**
   * Get known mint URLs, best-supported first, at most `limit` of them.
   *
   * A URL is well supported when it has a mint announcement (kind 38172) or
   * reviews from at least two authors; then come URLs with more reviewers.
   * A flood of single-author reviews for made-up URLs therefore cannot push
   * real mints out of the list.
   *
   * @param {number} [limit=MAX_DISCOVERY_URLS]
   * @returns {string[]} Array of unique URLs
   */
  function getAllUrls(limit = MAX_DISCOVERY_URLS) {
    const urls = new Set();
    for (const url of reviewsByUrl.keys()) urls.add(url);
    for (const url of mintInfoByUrl.keys()) urls.add(url);
    for (const url of httpInfoByUrl.keys()) urls.add(url);
    const support = (url) => {
      const reviewers = (reviewsByUrl.get(url) || []).length;
      const strong = mintInfoByUrl.has(url) || reviewers >= 2;
      return { strong, reviewers };
    };
    const ranked = Array.from(urls, (url) => ({ url, ...support(url) }));
    ranked.sort((a, b) => {
      if (a.strong !== b.strong) return a.strong ? -1 : 1;
      if (a.reviewers !== b.reviewers) return b.reviewers - a.reviewers;
      return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
    });
    return ranked.slice(0, Math.max(0, limit)).map((r) => r.url);
  }

  /**
   * Get reviews for a specific mint.
   *
   * @param {string} url - Mint URL
   * @returns {MintReview[]} Array of reviews
   */
  function getReviewsForUrl(url) {
    return reviewsByUrl.get(normalizeUrl(url)) || [];
  }

  /**
   * Build the recommendation object for one (normalized) URL.
   *
   * @param {string} url
   * @returns {MintRecommendation}
   */
  function buildRecommendation(url) {
    const reviews = reviewsByUrl.get(url) || [];
    const http = httpInfoByUrl.get(url);

    const ratings = reviews
      .map((r) => r.rating)
      .filter((n) => typeof n === "number" && n >= 1 && n <= 5);

    const averageRating =
      ratings.length > 0
        ? ratings.reduce((a, b) => a + b, 0) / ratings.length
        : null;

    return {
      url,
      reviewsCount: reviews.length,
      ratingsCount: ratings.length,
      averageRating,
      score: rankingScore(ratings),
      info: http?.info || undefined,
      error: http?.error || false,
      lastHttpInfoFetchAt: http?.fetchedAt || undefined,
    };
  }

  /**
   * Build sorted recommendations from all collected data.
   * Sorted by compareRecommendations: reachable first, then score, then
   * number of ratings.
   *
   * @returns {MintRecommendation[]} Sorted array of recommendations
   */
  function getRecommendations() {
    return getAllUrls().map(buildRecommendation).sort(compareRecommendations);
  }

  /**
   * Get a single recommendation by URL.
   *
   * @param {string} url - Mint URL
   * @returns {MintRecommendation|null} Recommendation or null
   */
  function getRecommendation(url) {
    const key = normalizeUrl(url);
    if (!reviewsByUrl.has(key) && !mintInfoByUrl.has(key) && !httpInfoByUrl.has(key)) {
      return null;
    }
    return buildRecommendation(key);
  }

  /**
   * Clear all data.
   */
  function clear() {
    reviewsByUrl.clear();
    mintInfoByUrl.clear();
    httpInfoByUrl.clear();
  }

  /**
   * Get statistics about the aggregator state.
   *
   * @returns {Object} Statistics
   */
  function getStats() {
    let totalReviews = 0;
    for (const reviews of reviewsByUrl.values()) {
      totalReviews += reviews.length;
    }

    return {
      mintCount: getAllUrls().length,
      totalReviews,
      mintsWithReviews: reviewsByUrl.size,
      mintsWithNostrInfo: mintInfoByUrl.size,
      mintsWithHttpInfo: httpInfoByUrl.size,
    };
  }

  /**
   * Export all data for serialization.
   *
   * @returns {Object} Serializable data
   */
  function exportData() {
    return {
      reviews: Array.from(reviewsByUrl.entries()).map(([url, reviews]) => ({
        url,
        reviews: reviews.map((r) => ({
          eventId: r.eventId,
          pubkey: r.pubkey,
          created_at: r.created_at,
          rating: r.rating,
          comment: r.comment,
        })),
      })),
      httpInfo: Array.from(httpInfoByUrl.entries()).map(([url, info]) => ({
        url,
        info: info.info,
        error: info.error,
        fetchedAt: info.fetchedAt,
      })),
    };
  }

  /**
   * Import previously exported data.
   *
   * @param {Object} data - Data from exportData()
   */
  function importData(data) {
    if (!data) return;

    if (Array.isArray(data.reviews)) {
      for (const { url, reviews } of data.reviews) {
        if (Array.isArray(reviews)) {
          for (const review of reviews) {
            addReview({ ...review, url });
          }
        }
      }
    }

    if (Array.isArray(data.httpInfo)) {
      for (const item of data.httpInfo) {
        if (item.url) {
          setHttpInfo(item.url, item);
        }
      }
    }
  }

  return {
    addReview,
    addReviews,
    addMintInfo,
    addMintInfos,
    setHttpInfo,
    setHttpInfoBatch,
    getHttpInfo,
    pruneHttpInfo,
    getAllUrls,
    getReviewsForUrl,
    getRecommendations,
    getRecommendation,
    clear,
    getStats,
    exportData,
    importData,
  };
}

module.exports = {
  createAggregator,
  compareRecommendations,
  normalizeUrl,
  rankingScore,
  MAX_DISCOVERY_URLS,
  HTTP_INFO_MAX_AGE_SECONDS,
  PRIOR_RATING,
  PRIOR_WEIGHT,
};
