/**
 * Optional IndexedDB storage layer for browser caching.
 * Can be skipped for server-side use.
 */

const DB_NAME = "mintDiscovery";
const DB_VERSION = 1;

/**
 * Create a storage instance using IndexedDB.
 * Returns null if IndexedDB is not available (e.g., in Node.js).
 *
 * @returns {Object|null} Storage instance or null
 */
function createStorage() {
  // Check if IndexedDB is available
  if (typeof indexedDB === "undefined") {
    return null;
  }

  let db = null;
  let dbPromise = null;

  /**
   * Open the database connection.
   *
   * @returns {Promise<IDBDatabase>}
   */
  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = event.target.result;

        // Reviews store: keyed by eventId, indexed by url
        if (!database.objectStoreNames.contains("reviews")) {
          const reviewStore = database.createObjectStore("reviews", {
            keyPath: "eventId",
          });
          reviewStore.createIndex("url", "url", { unique: false });
          reviewStore.createIndex("created_at", "created_at", { unique: false });
        }

        // HTTP info store: keyed by url
        if (!database.objectStoreNames.contains("httpInfo")) {
          database.createObjectStore("httpInfo", { keyPath: "url" });
        }

        // Mint info (from Nostr) store: auto-increment id, indexed by url
        if (!database.objectStoreNames.contains("mintInfo")) {
          const infoStore = database.createObjectStore("mintInfo", {
            keyPath: "id",
            autoIncrement: true,
          });
          infoStore.createIndex("url", "url", { unique: false });
        }
      };
    });

    return dbPromise;
  }

  /**
   * Save a review to storage.
   *
   * @param {Object} review - Review object with eventId, url, etc.
   * @returns {Promise<void>}
   */
  async function saveReview(review) {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("reviews", "readwrite");
      const store = tx.objectStore("reviews");
      const request = store.put(review);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Save multiple reviews.
   *
   * @param {Object[]} reviews - Array of reviews
   * @returns {Promise<void>}
   */
  async function saveReviews(reviews) {
    if (!Array.isArray(reviews) || reviews.length === 0) return;

    const database = await openDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("reviews", "readwrite");
      const store = tx.objectStore("reviews");

      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();

      for (const review of reviews) {
        if (review && review.eventId) {
          store.put(review);
        }
      }
    });
  }

  /**
   * Get all reviews for a URL.
   *
   * @param {string} url - Mint URL
   * @returns {Promise<Object[]>}
   */
  async function getReviewsByUrl(url) {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("reviews", "readonly");
      const store = tx.objectStore("reviews");
      const index = store.index("url");
      const request = index.getAll(url);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const reviews = request.result || [];
        reviews.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        resolve(reviews);
      };
    });
  }

  /**
   * Get all stored reviews.
   *
   * @returns {Promise<Object[]>}
   */
  async function getAllReviews() {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("reviews", "readonly");
      const store = tx.objectStore("reviews");
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  /**
   * Save HTTP info for a mint.
   *
   * @param {string} url - Mint URL
   * @param {Object} info - HTTP info result
   * @returns {Promise<void>}
   */
  async function saveHttpInfo(url, info) {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("httpInfo", "readwrite");
      const store = tx.objectStore("httpInfo");
      const request = store.put({ url, ...info });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Get HTTP info for a mint.
   *
   * @param {string} url - Mint URL
   * @returns {Promise<Object|null>}
   */
  async function getHttpInfo(url) {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("httpInfo", "readonly");
      const store = tx.objectStore("httpInfo");
      const request = store.get(url);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  /**
   * Get all stored HTTP info.
   *
   * @returns {Promise<Object[]>}
   */
  async function getAllHttpInfo() {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("httpInfo", "readonly");
      const store = tx.objectStore("httpInfo");
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  /**
   * Clear all stored data.
   *
   * @returns {Promise<void>}
   */
  async function clearAll() {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(
        ["reviews", "httpInfo", "mintInfo"],
        "readwrite"
      );

      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();

      tx.objectStore("reviews").clear();
      tx.objectStore("httpInfo").clear();
      tx.objectStore("mintInfo").clear();
    });
  }

  /**
   * Check if HTTP info is fresh (within cache interval).
   *
   * @param {string} url - Mint URL
   * @param {number} [maxAgeSeconds=3600] - Max age in seconds (default: 1 hour)
   * @returns {Promise<boolean>}
   */
  async function isHttpInfoFresh(url, maxAgeSeconds = 3600) {
    const info = await getHttpInfo(url);
    if (!info || !info.fetchedAt) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - info.fetchedAt < maxAgeSeconds;
  }

  /**
   * Close the database connection.
   */
  function close() {
    if (db) {
      db.close();
      db = null;
      dbPromise = null;
    }
  }

  return {
    openDb,
    saveReview,
    saveReviews,
    getReviewsByUrl,
    getAllReviews,
    saveHttpInfo,
    getHttpInfo,
    getAllHttpInfo,
    clearAll,
    isHttpInfoFresh,
    close,
  };
}

module.exports = { createStorage };
