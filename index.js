/**
 * Cashu Mint Discovery Library
 *
 * Discovers Cashu mints via Nostr (NIP-38172 mint info, NIP-38000 reviews)
 * and fetches HTTP info from each mint's /v1/info endpoint.
 *
 * @example
 * const { MintDiscovery } = require('./mint-discovery');
 *
 * const discovery = MintDiscovery.create();
 * const mints = await discovery.discover();
 * console.log(mints); // Reachable first, then by rating score (see aggregator.js)
 */

const { createNostrClient, DEFAULT_RELAYS } = require("./nostr-client");
const { fetchMintInfoBatch, isCacheFresh } = require("./mint-info-fetcher");
const {
  createAggregator,
  normalizeUrl,
  HTTP_INFO_MAX_AGE_SECONDS,
  MAX_DISCOVERY_URLS,
} = require("./aggregator");
const { createStorage } = require("./storage");

/**
 * Create a MintDiscovery instance.
 *
 * @param {Object} [options] - Configuration options
 * @param {string[]} [options.relays] - Nostr relay URLs
 * @param {number} [options.nostrTimeout] - Nostr query timeout in ms (default: 10000)
 * @param {number} [options.httpTimeout] - HTTP request timeout in ms (default: 10000)
 * @param {number} [options.httpConcurrency] - Max concurrent HTTP requests (default: 20)
 * @param {number} [options.httpDelayMs] - Delay between HTTP requests (default: 100)
 * @param {number} [options.httpBatchTimeout] - Deadline for all HTTP checks of one discovery run in ms (default: 60000)
 * @param {number} [options.cacheMaxAge] - Cache max age in seconds (default: 3600)
 * @param {boolean} [options.useStorage] - Enable IndexedDB storage (default: true in browser)
 * @returns {Object} MintDiscovery instance
 */
function create(options = {}) {
  const config = {
    relays: options.relays || DEFAULT_RELAYS,
    nostrTimeout: options.nostrTimeout || 10000,
    httpTimeout: options.httpTimeout || 10000,
    httpConcurrency: options.httpConcurrency || 20,
    httpDelayMs: options.httpDelayMs || 100,
    httpBatchTimeout: options.httpBatchTimeout || 60000,
    cacheMaxAge: options.cacheMaxAge || 3600,
    useStorage: options.useStorage !== false,
  };

  const nostrClient = createNostrClient({
    relays: config.relays,
    timeout: config.nostrTimeout,
  });

  const aggregator = createAggregator();
  const storage = config.useStorage ? createStorage() : null;

  let subscriptions = [];
  let isDiscovering = false;

  /**
   * Load cached data from storage into aggregator.
   *
   * @returns {Promise<void>}
   */
  async function loadFromStorage() {
    if (!storage) return;

    try {
      const [reviews, httpInfos] = await Promise.all([
        storage.getAllReviews(),
        storage.getAllHttpInfo(),
      ]);

      for (const review of reviews) {
        aggregator.addReview(review);
      }

      for (const info of httpInfos) {
        aggregator.setHttpInfo(info.url, info);
      }
      // Week-old results are dropped, not shown.
      aggregator.pruneHttpInfo();
    } catch (err) {
      // Storage errors are non-fatal
    }
  }

  /**
   * Evict cached HTTP results for mints not in the current Nostr set (when the
   * relays returned anything at all) or older than a week, in memory and in
   * storage. Without this, URLs announced once would be listed and refetched
   * forever.
   *
   * @param {Set<string>} seenUrls - Normalized URLs from this run's Nostr events
   * @returns {Promise<void>}
   */
  async function evictStaleHttpInfo(seenUrls) {
    const keepUrls = seenUrls.size > 0 ? seenUrls : null;
    aggregator.pruneHttpInfo({ keepUrls: keepUrls || undefined });
    if (!storage) return;
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      await storage.pruneHttpInfo(
        (rec) =>
          !!rec &&
          !!rec.fetchedAt &&
          nowSec - rec.fetchedAt <= HTTP_INFO_MAX_AGE_SECONDS &&
          (!keepUrls || keepUrls.has(normalizeUrl(rec.url)))
      );
    } catch {}
  }

  /**
   * Discover all mints by fetching from Nostr and HTTP endpoints.
   *
   * @param {Object} [opts] - Discovery options
   * @param {boolean} [opts.skipHttpFetch] - Skip fetching HTTP /v1/info
   * @param {Function} [opts.onProgress] - Progress callback
   * @returns {Promise<Object[]>} Sorted array of MintRecommendation
   */
  async function discover(opts = {}) {
    if (isDiscovering) {
      return aggregator.getRecommendations();
    }

    isDiscovering = true;

    try {
      // Load from storage first
      await loadFromStorage();

      if (opts.onProgress) opts.onProgress({ phase: "nostr", step: "mint-info" });

      // Fetch mint info events from Nostr
      const mintInfos = await nostrClient.fetchMintInfoEvents();
      aggregator.addMintInfos(mintInfos);

      if (opts.onProgress) opts.onProgress({ phase: "nostr", step: "reviews" });

      // Fetch review events from Nostr
      const reviews = await nostrClient.fetchReviewEvents();
      aggregator.addReviews(reviews);

      // Save reviews to storage
      if (storage && reviews.length > 0) {
        try {
          await storage.saveReviews(reviews);
        } catch {}
      }

      const seenUrls = new Set();
      for (const item of mintInfos) seenUrls.add(normalizeUrl(item.url));
      for (const item of reviews) seenUrls.add(normalizeUrl(item.url));
      await evictStaleHttpInfo(seenUrls);

      // Fetch HTTP info for all discovered mints
      if (!opts.skipHttpFetch) {
        if (opts.onProgress) opts.onProgress({ phase: "http", step: "fetching" });

        const urls = aggregator.getAllUrls();

        // Filter out URLs with fresh cache
        const staleUrls = [];
        for (const url of urls) {
          if (!isCacheFresh(aggregator.getHttpInfo(url), config.cacheMaxAge)) {
            staleUrls.push(url);
          }
        }

        if (staleUrls.length > 0) {
          const httpResults = await fetchMintInfoBatch(staleUrls, {
            concurrency: config.httpConcurrency,
            delayMs: config.httpDelayMs,
            timeout: config.httpTimeout,
            batchTimeout: config.httpBatchTimeout,
            onResult: async (result) => {
              aggregator.setHttpInfo(result.url, result);

              // Save to storage
              if (storage) {
                try {
                  await storage.saveHttpInfo(result.url, result);
                } catch {}
              }

              if (opts.onProgress) {
                opts.onProgress({
                  phase: "http",
                  step: "fetched",
                  url: result.url,
                  error: result.error,
                });
              }
            },
          });

          aggregator.setHttpInfoBatch(httpResults);
        }
      }

      if (opts.onProgress) opts.onProgress({ phase: "done" });

      return aggregator.getRecommendations();
    } finally {
      isDiscovering = false;
    }
  }

  /**
   * Discover mints with streaming updates as events arrive from Nostr.
   * Unlike discover(), this emits mints progressively via callbacks.
   *
   * @param {Object} [callbacks] - Event callbacks
   * @param {Function} [callbacks.onMint] - Called with updated recommendation for each new mint/review
   * @param {Function} [callbacks.onProgress] - Progress callback
   * @param {Function} [callbacks.onComplete] - Called when initial discovery is complete
   * @returns {Promise<Object[]>} Final sorted array of MintRecommendation
   */
  async function discoverStreaming(callbacks = {}) {
    if (isDiscovering) {
      return aggregator.getRecommendations();
    }

    isDiscovering = true;
    let eoseFallback;

    try {
      // Load from storage first
      await loadFromStorage();

      // Track EOSE from both subscriptions
      let mintInfoEose = false;
      let reviewsEose = false;
      let httpFetchStarted = false;
      const seenUrls = new Set();

      // URLs already handed to onMint. Once MAX_DISCOVERY_URLS of them have been,
      // a new URL is not emitted (a flood of reviews for made-up URLs would grow the
      // caller's list without bound); known ones keep getting updates, and
      // onComplete still delivers the capped, ranked list.
      const emittedUrls = new Set();
      const emitMint = (url) => {
        if (!callbacks.onMint) return;
        const key = normalizeUrl(url);
        if (!emittedUrls.has(key) && emittedUrls.size >= MAX_DISCOVERY_URLS) return;
        const rec = aggregator.getRecommendation(url);
        if (!rec) return;
        emittedUrls.add(key);
        callbacks.onMint(rec);
      };

      // A relay that never sends EOSE must not keep discovery running: after
      // the Nostr timeout, go on with whatever has arrived.
      eoseFallback = setTimeout(() => {
        mintInfoEose = true;
        reviewsEose = true;
        checkEoseAndFetchHttp();
      }, config.nostrTimeout);

      const checkEoseAndFetchHttp = async () => {
        if (mintInfoEose && reviewsEose && !httpFetchStarted) {
          httpFetchStarted = true;
          clearTimeout(eoseFallback);
          try {
            await runHttpPhase();
          } catch {}
          finish();
        }
      };

      const runHttpPhase = async () => {
        await evictStaleHttpInfo(seenUrls);

        if (callbacks.onProgress) {
          callbacks.onProgress({ phase: "http", step: "fetching" });
        }

        // Fetch HTTP info for all discovered mints
        const urls = aggregator.getAllUrls();
        const staleUrls = [];

        for (const url of urls) {
          if (!isCacheFresh(aggregator.getHttpInfo(url), config.cacheMaxAge)) {
            staleUrls.push(url);
          }
        }

        if (staleUrls.length > 0) {
          await fetchMintInfoBatch(staleUrls, {
            concurrency: config.httpConcurrency,
            delayMs: config.httpDelayMs,
            timeout: config.httpTimeout,
            batchTimeout: config.httpBatchTimeout,
            onResult: async (result) => {
              aggregator.setHttpInfo(result.url, result);

              // Save to storage
              if (storage) {
                try {
                  await storage.saveHttpInfo(result.url, result);
                } catch {}
              }

              // Emit updated recommendation
              emitMint(result.url);

              if (callbacks.onProgress) {
                callbacks.onProgress({
                  phase: "http",
                  step: "fetched",
                  url: result.url,
                  error: result.error,
                });
              }
            },
          });
        }
      };

      const finish = () => {
        // Close subscriptions
        try {
          mintInfoSub.close();
        } catch {}
        try {
          reviewSub.close();
        } catch {}

        isDiscovering = false;

        if (callbacks.onProgress) {
          callbacks.onProgress({ phase: "done" });
        }

        if (callbacks.onComplete) {
          callbacks.onComplete(aggregator.getRecommendations());
        }
      };

      if (callbacks.onProgress) {
        callbacks.onProgress({ phase: "nostr", step: "subscribing" });
      }

      // Subscribe to mint info events
      const mintInfoSub = nostrClient.subscribeMintInfo({
        onEvent: (mintInfo) => {
          aggregator.addMintInfo(mintInfo);
          seenUrls.add(normalizeUrl(mintInfo.url));

          // Emit recommendation for this mint
          emitMint(mintInfo.url);
        },
        onEose: () => {
          mintInfoEose = true;
          if (callbacks.onProgress) {
            callbacks.onProgress({ phase: "nostr", step: "mint-info-complete" });
          }
          checkEoseAndFetchHttp();
        },
      });

      // Subscribe to review events
      const reviewSub = nostrClient.subscribeReviews({
        onEvent: async (review) => {
          aggregator.addReview(review);
          seenUrls.add(normalizeUrl(review.url));

          // Save to storage
          if (storage) {
            try {
              await storage.saveReview(review);
            } catch {}
          }

          // Emit recommendation for this mint
          emitMint(review.url);
        },
        onEose: () => {
          reviewsEose = true;
          if (callbacks.onProgress) {
            callbacks.onProgress({ phase: "nostr", step: "reviews-complete" });
          }
          checkEoseAndFetchHttp();
        },
      });

      // Return a promise that resolves when discovery is complete
      return new Promise((resolve) => {
        const originalOnComplete = callbacks.onComplete;
        callbacks.onComplete = (recommendations) => {
          if (originalOnComplete) originalOnComplete(recommendations);
          resolve(recommendations);
        };
      });
    } catch (err) {
      clearTimeout(eoseFallback);
      isDiscovering = false;
      throw err;
    }
  }

  /**
   * Subscribe to live updates from Nostr.
   *
   * @param {Object} callbacks - Event callbacks
   * @param {Function} [callbacks.onMintInfo] - Called for new mint info
   * @param {Function} [callbacks.onReview] - Called for new reviews
   * @param {Function} [callbacks.onUpdate] - Called when recommendations change
   * @returns {Function} Unsubscribe function
   */
  function subscribe(callbacks = {}) {
    const mintInfoSub = nostrClient.subscribeMintInfo({
      onEvent: async (mintInfo, rawEvent) => {
        aggregator.addMintInfo(mintInfo);

        // Fetch HTTP info for new mint
        if (mintInfo.url) {
          if (!isCacheFresh(aggregator.getHttpInfo(mintInfo.url), config.cacheMaxAge)) {
            const { fetchMintInfo } = require("./mint-info-fetcher");
            const result = await fetchMintInfo(mintInfo.url, config.httpTimeout);
            aggregator.setHttpInfo(mintInfo.url, result);

            if (storage) {
              try {
                await storage.saveHttpInfo(mintInfo.url, result);
              } catch {}
            }
          }
        }

        if (callbacks.onMintInfo) {
          callbacks.onMintInfo(mintInfo, rawEvent);
        }
        if (callbacks.onUpdate) {
          callbacks.onUpdate(aggregator.getRecommendations());
        }
      },
    });

    const reviewSub = nostrClient.subscribeReviews({
      onEvent: async (review, rawEvent) => {
        aggregator.addReview(review);

        if (storage) {
          try {
            await storage.saveReview(review);
          } catch {}
        }

        if (callbacks.onReview) {
          callbacks.onReview(review, rawEvent);
        }
        if (callbacks.onUpdate) {
          callbacks.onUpdate(aggregator.getRecommendations());
        }
      },
    });

    subscriptions.push(mintInfoSub, reviewSub);

    return () => {
      mintInfoSub.close();
      reviewSub.close();
      subscriptions = subscriptions.filter(
        (s) => s !== mintInfoSub && s !== reviewSub
      );
    };
  }

  /**
   * Get current recommendations without fetching.
   *
   * @returns {Object[]} Array of MintRecommendation
   */
  function getRecommendations() {
    return aggregator.getRecommendations();
  }

  /**
   * Get reviews for a specific mint.
   *
   * @param {string} url - Mint URL
   * @returns {Object[]} Array of reviews
   */
  function getReviewsForMint(url) {
    return aggregator.getReviewsForUrl(url);
  }

  /**
   * Fetch reviews for a specific mint from Nostr.
   *
   * @param {string} url - Mint URL
   * @returns {Promise<Object[]>} Array of reviews
   */
  async function fetchReviewsForMint(url) {
    const reviews = await nostrClient.fetchReviewsForUrl(url);
    aggregator.addReviews(reviews);

    if (storage && reviews.length > 0) {
      try {
        await storage.saveReviews(reviews);
      } catch {}
    }

    return aggregator.getReviewsForUrl(url);
  }

  /**
   * Clear all cached data.
   *
   * @returns {Promise<void>}
   */
  async function clearCache() {
    aggregator.clear();
    if (storage) {
      try {
        await storage.clearAll();
      } catch {}
    }
  }

  /**
   * Get statistics about discovered mints.
   *
   * @returns {Object} Statistics
   */
  function getStats() {
    return aggregator.getStats();
  }

  /**
   * Export all data for serialization.
   *
   * @returns {Object} Serializable data
   */
  function exportData() {
    return aggregator.exportData();
  }

  /**
   * Import previously exported data.
   *
   * @param {Object} data - Data from exportData()
   */
  function importData(data) {
    aggregator.importData(data);
  }

  /**
   * Close all connections and subscriptions.
   */
  function close() {
    for (const sub of subscriptions) {
      try {
        sub.close();
      } catch {}
    }
    subscriptions = [];
    nostrClient.close();
    if (storage) {
      storage.close();
    }
  }

  /**
   * Update configuration.
   *
   * @param {Object} newOptions - New configuration options
   */
  function configure(newOptions) {
    if (newOptions.relays) config.relays = newOptions.relays;
    if (newOptions.nostrTimeout) config.nostrTimeout = newOptions.nostrTimeout;
    if (newOptions.httpTimeout) config.httpTimeout = newOptions.httpTimeout;
    if (newOptions.httpConcurrency) config.httpConcurrency = newOptions.httpConcurrency;
    if (newOptions.httpDelayMs) config.httpDelayMs = newOptions.httpDelayMs;
    if (newOptions.httpBatchTimeout) config.httpBatchTimeout = newOptions.httpBatchTimeout;
    if (newOptions.cacheMaxAge) config.cacheMaxAge = newOptions.cacheMaxAge;
  }

  return {
    discover,
    discoverStreaming,
    subscribe,
    getRecommendations,
    getReviewsForMint,
    fetchReviewsForMint,
    clearCache,
    getStats,
    exportData,
    importData,
    configure,
    close,
    // Expose internals for advanced use
    aggregator,
    nostrClient,
    storage,
    config,
  };
}

// Static factory
const MintDiscovery = {
  create,
  DEFAULT_RELAYS,
  // Same order getRecommendations() uses, for callers that re-sort a list
  // they build from streaming onMint updates.
  compareRecommendations: require("./aggregator").compareRecommendations,
};

module.exports = {
  MintDiscovery,
  create,
  DEFAULT_RELAYS,
  // Re-export components for direct use
  createNostrClient: require("./nostr-client").createNostrClient,
  createAggregator: require("./aggregator").createAggregator,
  compareRecommendations: require("./aggregator").compareRecommendations,
  normalizeUrl: require("./aggregator").normalizeUrl,
  createStorage: require("./storage").createStorage,
  parseRatingAndComment: require("./review-parser").parseRatingAndComment,
  fetchMintInfo: require("./mint-info-fetcher").fetchMintInfo,
  fetchMintInfoBatch: require("./mint-info-fetcher").fetchMintInfoBatch,
};
