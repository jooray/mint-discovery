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
 * console.log(mints); // Sorted by review count, then rating
 */

const { createNostrClient, DEFAULT_RELAYS } = require("./nostr-client");
const { fetchMintInfoBatch, isCacheFresh } = require("./mint-info-fetcher");
const { createAggregator } = require("./aggregator");
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
    } catch (err) {
      // Storage errors are non-fatal
    }
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

      // Fetch HTTP info for all discovered mints
      if (!opts.skipHttpFetch) {
        if (opts.onProgress) opts.onProgress({ phase: "http", step: "fetching" });

        const urls = aggregator.getAllUrls();

        // Filter out URLs with fresh cache
        const staleUrls = [];
        for (const url of urls) {
          const existing = aggregator.getRecommendation(url);
          if (!existing || !isCacheFresh(existing, config.cacheMaxAge)) {
            staleUrls.push(url);
          }
        }

        if (staleUrls.length > 0) {
          const httpResults = await fetchMintInfoBatch(staleUrls, {
            concurrency: config.httpConcurrency,
            delayMs: config.httpDelayMs,
            timeout: config.httpTimeout,
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
          const existing = aggregator.getRecommendation(mintInfo.url);
          if (!existing || !isCacheFresh(existing, config.cacheMaxAge)) {
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
    if (newOptions.cacheMaxAge) config.cacheMaxAge = newOptions.cacheMaxAge;
  }

  return {
    discover,
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
};

module.exports = {
  MintDiscovery,
  create,
  DEFAULT_RELAYS,
  // Re-export components for direct use
  createNostrClient: require("./nostr-client").createNostrClient,
  createAggregator: require("./aggregator").createAggregator,
  createStorage: require("./storage").createStorage,
  parseRatingAndComment: require("./review-parser").parseRatingAndComment,
  fetchMintInfo: require("./mint-info-fetcher").fetchMintInfo,
  fetchMintInfoBatch: require("./mint-info-fetcher").fetchMintInfoBatch,
};
