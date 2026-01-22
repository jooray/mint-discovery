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
 * @property {number} reviewsCount - Number of reviews
 * @property {number|null} averageRating - Average rating or null
 * @property {Object} [info] - HTTP /v1/info response
 * @property {boolean} error - Whether last HTTP fetch failed
 * @property {number} [lastHttpInfoFetchAt] - Unix timestamp of last fetch
 */

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

    const url = review.url;
    let reviews = reviewsByUrl.get(url) || [];

    // Check if this exact event already exists
    if (reviews.some((r) => r.eventId === review.eventId)) return;

    // Remove older reviews from the same author (keep only latest)
    reviews = reviews.filter((r) => r.pubkey !== review.pubkey);
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

    const existing = mintInfoByUrl.get(info.url);

    // Keep the most recent event per URL
    if (!existing || (info.created_at || 0) > (existing.created_at || 0)) {
      mintInfoByUrl.set(info.url, info);
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
    httpInfoByUrl.set(url, httpResult);
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
   * Get all known mint URLs.
   *
   * @returns {string[]} Array of unique URLs
   */
  function getAllUrls() {
    const urls = new Set();
    for (const url of reviewsByUrl.keys()) urls.add(url);
    for (const url of mintInfoByUrl.keys()) urls.add(url);
    for (const url of httpInfoByUrl.keys()) urls.add(url);
    return Array.from(urls);
  }

  /**
   * Get reviews for a specific mint.
   *
   * @param {string} url - Mint URL
   * @returns {MintReview[]} Array of reviews
   */
  function getReviewsForUrl(url) {
    return reviewsByUrl.get(url) || [];
  }

  /**
   * Build sorted recommendations from all collected data.
   * Sorted by review count (descending), then average rating (descending).
   *
   * @returns {MintRecommendation[]} Sorted array of recommendations
   */
  function getRecommendations() {
    const urls = getAllUrls();
    const recommendations = [];

    for (const url of urls) {
      const reviews = reviewsByUrl.get(url) || [];
      const http = httpInfoByUrl.get(url);

      // Calculate average rating
      const ratings = reviews
        .map((r) => r.rating)
        .filter((n) => typeof n === "number" && n >= 1 && n <= 5);

      const averageRating =
        ratings.length > 0
          ? ratings.reduce((a, b) => a + b, 0) / ratings.length
          : null;

      recommendations.push({
        url,
        reviewsCount: reviews.length,
        averageRating,
        info: http?.info || undefined,
        error: http?.error || false,
        lastHttpInfoFetchAt: http?.fetchedAt || undefined,
      });
    }

    // Sort: reviewsCount descending, then averageRating descending
    recommendations.sort((a, b) => {
      const countDiff = b.reviewsCount - a.reviewsCount;
      if (countDiff !== 0) return countDiff;
      return (b.averageRating || 0) - (a.averageRating || 0);
    });

    return recommendations;
  }

  /**
   * Get a single recommendation by URL.
   *
   * @param {string} url - Mint URL
   * @returns {MintRecommendation|null} Recommendation or null
   */
  function getRecommendation(url) {
    const reviews = reviewsByUrl.get(url) || [];
    const http = httpInfoByUrl.get(url);

    if (reviews.length === 0 && !mintInfoByUrl.has(url) && !http) {
      return null;
    }

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
      averageRating,
      info: http?.info || undefined,
      error: http?.error || false,
      lastHttpInfoFetchAt: http?.fetchedAt || undefined,
    };
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

module.exports = { createAggregator };
