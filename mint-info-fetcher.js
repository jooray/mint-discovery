/**
 * HTTP fetcher for Cashu mint info.
 * Fetches /v1/info endpoint from mints with concurrency control.
 */

/**
 * Fetch mint info from a single mint's /v1/info endpoint.
 *
 * @param {string} url - The mint base URL
 * @param {number} [timeout=10000] - Request timeout in ms
 * @returns {Promise<Object>} Result with info or error
 *
 * @example
 * const result = await fetchMintInfo("https://mint.example.com");
 * // => { url: "https://mint.example.com", info: {...}, error: false, fetchedAt: 1234567890 }
 */
async function fetchMintInfo(url, timeout = 10000) {
  if (!url || typeof url !== "string" || !url.startsWith("http")) {
    return {
      url,
      info: null,
      error: true,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  }

  // Normalize URL - remove trailing slash
  const baseUrl = url.replace(/\/$/, "");
  const infoUrl = `${baseUrl}/v1/info`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(infoUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        url,
        info: null,
        error: true,
        fetchedAt: Math.floor(Date.now() / 1000),
      };
    }

    const info = await response.json();

    return {
      url,
      info,
      error: false,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      url,
      info: null,
      error: true,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  }
}

/**
 * Fetch mint info from multiple mints with concurrency control.
 *
 * @param {string[]} urls - Array of mint base URLs
 * @param {Object} [options] - Fetch options
 * @param {number} [options.concurrency=20] - Maximum concurrent requests
 * @param {number} [options.delayMs=100] - Delay between starting new requests
 * @param {number} [options.timeout=10000] - Request timeout in ms
 * @param {Function} [options.onResult] - Callback for each completed fetch
 * @returns {Promise<Object[]>} Array of results
 *
 * @example
 * const results = await fetchMintInfoBatch(
 *   ["https://mint1.com", "https://mint2.com"],
 *   { concurrency: 10, onResult: (r) => console.log(r.url, r.error ? "failed" : "ok") }
 * );
 */
async function fetchMintInfoBatch(urls, options = {}) {
  const {
    concurrency = 20,
    delayMs = 100,
    timeout = 10000,
    onResult,
  } = options;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  // Deduplicate URLs
  const uniqueUrls = [...new Set(urls.filter((u) => typeof u === "string"))];
  const results = [];
  let idx = 0;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= uniqueUrls.length) break;

      const url = uniqueUrls[i];
      const result = await fetchMintInfo(url, timeout);
      results.push(result);

      if (onResult) {
        try {
          onResult(result);
        } catch {}
      }

      if (i < uniqueUrls.length - 1) {
        await delay(delayMs);
      }
    }
  };

  const workerCount = Math.min(concurrency, uniqueUrls.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Check if a cached result is still fresh.
 *
 * @param {Object} cachedResult - Previously fetched result
 * @param {number} [maxAgeSeconds=3600] - Maximum age in seconds (default: 1 hour)
 * @returns {boolean} True if the cache is still fresh
 */
function isCacheFresh(cachedResult, maxAgeSeconds = 3600) {
  if (!cachedResult || !cachedResult.fetchedAt) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - cachedResult.fetchedAt < maxAgeSeconds;
}

module.exports = {
  fetchMintInfo,
  fetchMintInfoBatch,
  isCacheFresh,
};
