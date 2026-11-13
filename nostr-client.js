/**
 * Nostr client for fetching Cashu mint info and reviews.
 * Uses nostr-tools for lightweight relay connections.
 */

const { SimplePool } = require("nostr-tools/pool");
const { parseRatingAndComment } = require("./review-parser");
const { isAcceptableMintUrl } = require("./url-policy");

// A review names one mint, occasionally a few. Only the first few "u" tags of an
// event count, so one event cannot add thousands of URLs for the browser to fetch.
const MAX_U_TAGS_PER_EVENT = 5;

/**
 * Mint URLs an event names: the first MAX_U_TAGS_PER_EVENT Cashu "u" tags,
 * keeping only public https URLs.
 *
 * @param {Object} event
 * @returns {string[]}
 */
function eventMintUrls(event) {
  const urls = (event.tags || [])
    .filter(isCashuUrlTag)
    .slice(0, MAX_U_TAGS_PER_EVENT)
    .map((t) => t[1])
    .filter(isAcceptableMintUrl);
  return [...new Set(urls)];
}

/**
 * Is this a "u" tag naming a Cashu mint? NIP-87 leaves the third element
 * undefined; in practice it is absent (most events) or a network label such as
 * "cashu" or "fedimint". Accept absent/"cashu", reject any other label.
 *
 * @param {Array} t - Tag
 * @returns {boolean}
 */
function isCashuUrlTag(t) {
  if (!Array.isArray(t) || t[0] !== "u" || typeof t[1] !== "string") return false;
  if (t.length < 3 || t[2] === undefined || t[2] === null || t[2] === "") return true;
  return String(t[2]).toLowerCase() === "cashu";
}

/**
 * Relay "#u" filters match exactly, so ask for both spellings of a URL.
 *
 * @param {string} url
 * @returns {string[]}
 */
function urlVariants(url) {
  const base = url.trim().replace(/\/+$/, "");
  return [base, base + "/"];
}

// Nostr event kinds for Cashu
const MINT_INFO_KIND = 38172;
const REVIEW_KIND = 38000;

// Default relays
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.8333.space/",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

/**
 * Create a Nostr client for mint discovery.
 *
 * @param {Object} options - Configuration options
 * @param {string[]} [options.relays] - Relay URLs to connect to
 * @param {number} [options.timeout] - Query timeout in ms (default: 10000)
 * @returns {Object} Nostr client instance
 */
function createNostrClient(options = {}) {
  const relays = options.relays || DEFAULT_RELAYS;
  const timeout = options.timeout || 10000;
  const pool = new SimplePool();

  /**
   * Fetch all mint info events (kind 38172).
   *
   * @param {number} [limit] - Maximum number of events to fetch
   * @returns {Promise<Object[]>} Array of parsed mint info objects
   */
  async function fetchMintInfoEvents(limit = 5000) {
    const filter = {
      kinds: [MINT_INFO_KIND],
      limit,
    };

    const events = await pool.querySync(relays, filter, { timeout });
    return events.map(parseMintInfoEvent).filter(Boolean);
  }

  /**
   * Fetch all review events (kind 38000 with #k=38172 tag).
   *
   * @param {number} [limit] - Maximum number of events to fetch
   * @returns {Promise<Object[]>} Array of parsed review objects
   */
  async function fetchReviewEvents(limit = 5000) {
    const filter = {
      kinds: [REVIEW_KIND],
      "#k": ["38172"],
      limit,
    };

    const events = await pool.querySync(relays, filter, { timeout });
    return events.flatMap(parseReviewEvent).filter(Boolean);
  }

  /**
   * Fetch reviews for a specific mint URL.
   *
   * @param {string} url - The mint URL to fetch reviews for
   * @param {number} [limit] - Maximum number of events to fetch
   * @returns {Promise<Object[]>} Array of parsed review objects
   */
  async function fetchReviewsForUrl(url, limit = 5000) {
    if (!isAcceptableMintUrl(url)) {
      return [];
    }

    const filter = {
      kinds: [REVIEW_KIND],
      "#k": ["38172"],
      "#u": urlVariants(url),
      limit,
    };

    const events = await pool.querySync(relays, filter, { timeout });
    return events.flatMap(parseReviewEvent).filter(Boolean);
  }

  /**
   * Fetch mint info events for a specific URL.
   *
   * @param {string} url - The mint URL
   * @param {number} [limit] - Maximum number of events to fetch
   * @returns {Promise<Object[]>} Array of parsed mint info objects
   */
  async function fetchMintInfoForUrl(url, limit = 1000) {
    if (!isAcceptableMintUrl(url)) {
      return [];
    }

    const filter = {
      kinds: [MINT_INFO_KIND],
      "#u": urlVariants(url),
      limit,
    };

    const events = await pool.querySync(relays, filter, { timeout });
    return events.map(parseMintInfoEvent).filter(Boolean);
  }

  /**
   * Subscribe to live mint info events.
   *
   * @param {Object} callbacks - Event callbacks
   * @param {Function} callbacks.onEvent - Called for each new event
   * @param {Function} [callbacks.onEose] - Called when end of stored events reached
   * @returns {Object} Subscription handle with close() method
   */
  function subscribeMintInfo(callbacks) {
    const filter = { kinds: [MINT_INFO_KIND] };
    const sub = pool.subscribeMany(relays, filter, {
      onevent(event) {
        const parsed = parseMintInfoEvent(event);
        if (parsed && callbacks.onEvent) {
          callbacks.onEvent(parsed, event);
        }
      },
      oneose() {
        if (callbacks.onEose) callbacks.onEose();
      },
    });
    return sub;
  }

  /**
   * Subscribe to live review events.
   *
   * @param {Object} callbacks - Event callbacks
   * @param {Function} callbacks.onEvent - Called for each new event
   * @param {Function} [callbacks.onEose] - Called when end of stored events reached
   * @returns {Object} Subscription handle with close() method
   */
  function subscribeReviews(callbacks) {
    const filter = { kinds: [REVIEW_KIND], "#k": ["38172"] };
    const sub = pool.subscribeMany(relays, filter, {
      onevent(event) {
        const parsed = parseReviewEvent(event);
        if (parsed.length > 0 && callbacks.onEvent) {
          for (const review of parsed) {
            callbacks.onEvent(review, event);
          }
        }
      },
      oneose() {
        if (callbacks.onEose) callbacks.onEose();
      },
    });
    return sub;
  }

  /**
   * Close all relay connections.
   */
  function close() {
    pool.close(relays);
  }

  return {
    fetchMintInfoEvents,
    fetchReviewEvents,
    fetchReviewsForUrl,
    fetchMintInfoForUrl,
    subscribeMintInfo,
    subscribeReviews,
    close,
    pool,
    relays,
  };
}

/**
 * Parse a mint info event (kind 38172).
 *
 * @param {Object} event - Nostr event
 * @returns {Object|null} Parsed mint info or null if invalid
 */
function parseMintInfoEvent(event) {
  if (!event || event.kind !== MINT_INFO_KIND) return null;

  // The first acceptable Cashu URL among the event's first few 'u' tags
  const url = eventMintUrls(event)[0];
  if (!url) return null;

  let content;
  try {
    content = event.content ? JSON.parse(event.content) : undefined;
  } catch {
    content = undefined;
  }

  const dTag = event.tags.find((t) => t[0] === "d");

  return {
    url,
    pubkey: event.pubkey,
    d: dTag ? dTag[1] : "",
    content,
    created_at: event.created_at || 0,
    raw: event,
  };
}

/**
 * Parse a review event (kind 38000 with #k=38172).
 * Returns an array since a review can reference multiple mint URLs.
 *
 * @param {Object} event - Nostr event
 * @returns {Object[]} Array of parsed reviews (one per referenced URL)
 */
function parseReviewEvent(event) {
  if (!event || event.kind !== REVIEW_KIND) return [];

  const kTag = (event.tags || []).find((t) => t[0] === "k");
  if (!kTag || kTag[1] !== "38172") return [];

  const urls = eventMintUrls(event);
  if (!urls.length) return [];

  const { rating, comment } = parseRatingAndComment(event.content || "");

  const reviews = [];
  for (const url of urls) {
    reviews.push({
      eventId: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at || 0,
      rating,
      comment,
      url,
      raw: event,
    });
  }

  return reviews;
}

module.exports = {
  createNostrClient,
  parseMintInfoEvent,
  parseReviewEvent,
  isCashuUrlTag,
  MAX_U_TAGS_PER_EVENT,
  DEFAULT_RELAYS,
  MINT_INFO_KIND,
  REVIEW_KIND,
};
