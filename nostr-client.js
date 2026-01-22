/**
 * Nostr client for fetching Cashu mint info and reviews.
 * Uses nostr-tools for lightweight relay connections.
 */

const { SimplePool } = require("nostr-tools/pool");
const { parseRatingAndComment } = require("./review-parser");

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
    if (!url || typeof url !== "string" || !url.startsWith("http")) {
      return [];
    }

    const filter = {
      kinds: [REVIEW_KIND],
      "#k": ["38172"],
      "#u": [url],
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
    if (!url || typeof url !== "string" || !url.startsWith("http")) {
      return [];
    }

    const filter = {
      kinds: [MINT_INFO_KIND],
      "#u": [url],
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
    const sub = pool.subscribeMany(relays, [filter], {
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
    const sub = pool.subscribeMany(relays, [filter], {
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

  // Find the 'u' tag with cashu URL
  const uTag = event.tags.find(
    (t) => t[0] === "u" && (t[2] === "cashu" || t.length >= 2)
  );

  if (!uTag || typeof uTag[1] !== "string" || !uTag[1].startsWith("http")) {
    return null;
  }

  let content;
  try {
    content = event.content ? JSON.parse(event.content) : undefined;
  } catch {
    content = undefined;
  }

  const dTag = event.tags.find((t) => t[0] === "d");

  return {
    url: uTag[1],
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

  const kTag = event.tags.find((t) => t[0] === "k");
  if (!kTag || kTag[1] !== "38172") return [];

  const uTags = event.tags.filter(
    (t) => t[0] === "u" && (t[2] === "cashu" || t.length >= 2)
  );
  if (!uTags.length) return [];

  const { rating, comment } = parseRatingAndComment(event.content || "");

  const reviews = [];
  for (const uTag of uTags) {
    const url = uTag[1];
    if (typeof url === "string" && url.startsWith("http")) {
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
  }

  return reviews;
}

module.exports = {
  createNostrClient,
  parseMintInfoEvent,
  parseReviewEvent,
  DEFAULT_RELAYS,
  MINT_INFO_KIND,
  REVIEW_KIND,
};
