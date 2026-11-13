/**
 * HTTP fetcher for Cashu mint info.
 * Fetches /v1/info endpoint from mints with concurrency control.
 */

const { isAcceptableMintUrl } = require("./url-policy");

// A /v1/info document is a few KiB; anything far larger is not a mint.
const MAX_INFO_BYTES = 256 * 1024;

function failure(url) {
  return {
    url,
    info: null,
    error: true,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Promise that rejects once the signal aborts. Racing body reads against it
 * keeps the deadline effective even where an aborted fetch does not error
 * its body stream.
 *
 * @param {AbortSignal} signal
 * @returns {Promise<never>}
 */
function abortedPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/**
 * Read a response body as text, failing past maxBytes or when the signal aborts.
 *
 * @param {Response} response
 * @param {AbortSignal} signal
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBodyCapped(response, signal, maxBytes) {
  const aborted = abortedPromise(signal);
  aborted.catch(() => {});

  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("response too large");
  }

  const reader =
    response.body && typeof response.body.getReader === "function"
      ? response.body.getReader()
      : null;

  if (!reader) {
    const text = await Promise.race([response.text(), aborted]);
    if (text.length > maxBytes) throw new Error("response too large");
    return text;
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("response too large");
      chunks.push(value);
    }
  } catch (err) {
    try {
      reader.cancel().catch(() => {});
    } catch {}
    throw err;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Fetch mint info from a single mint's /v1/info endpoint.
 *
 * The timeout covers the whole exchange, body included: a server that sends
 * headers and then trickles (or never sends) the body still fails on time.
 *
 * @param {string} url - The mint base URL (public https only, see url-policy.js)
 * @param {number} [timeout=10000] - Request timeout in ms
 * @param {AbortSignal} [outerSignal] - Aborts the request early (batch deadline)
 * @returns {Promise<Object>} Result with info or error
 *
 * @example
 * const result = await fetchMintInfo("https://mint.example.com");
 * // => { url: "https://mint.example.com", info: {...}, error: false, fetchedAt: 1234567890 }
 */
async function fetchMintInfo(url, timeout = 10000, outerSignal) {
  if (!isAcceptableMintUrl(url)) {
    return failure(url);
  }

  // Normalize URL - remove trailing slash
  const baseUrl = url.trim().replace(/\/+$/, "");
  const infoUrl = `${baseUrl}/v1/info`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const response = await Promise.race([
      fetch(infoUrl, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
        },
      }),
      abortedPromise(controller.signal),
    ]);

    if (!response.ok) {
      // Release the connection; the body is not needed.
      try {
        response.body?.cancel?.().catch(() => {});
      } catch {}
      return failure(url);
    }

    const text = await readBodyCapped(response, controller.signal, MAX_INFO_BYTES);
    const info = JSON.parse(text);
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      return failure(url);
    }

    return {
      url,
      info,
      error: false,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    return failure(url);
  } finally {
    clearTimeout(timeoutId);
    if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Fetch mint info from multiple mints with concurrency control.
 *
 * The whole batch has a deadline (batchTimeout): when it passes, requests in
 * flight are aborted, URLs not yet started are skipped (not reported, so they
 * are not cached as offline) and the promise resolves with what finished.
 *
 * @param {string[]} urls - Array of mint base URLs
 * @param {Object} [options] - Fetch options
 * @param {number} [options.concurrency=20] - Maximum concurrent requests
 * @param {number} [options.delayMs=100] - Delay between starting new requests
 * @param {number} [options.timeout=10000] - Per-request timeout in ms
 * @param {number} [options.batchTimeout=60000] - Deadline for the whole batch in ms
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
    batchTimeout = 60000,
    onResult,
  } = options;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  // Deduplicate URLs
  const uniqueUrls = [...new Set(urls.filter((u) => typeof u === "string"))];
  const results = [];
  let idx = 0;

  const batch = new AbortController();
  let deadlineId;
  const deadline = new Promise((resolve) => {
    deadlineId = setTimeout(() => {
      batch.abort();
      resolve();
    }, batchTimeout);
  });

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const worker = async () => {
    while (!batch.signal.aborted) {
      const i = idx++;
      if (i >= uniqueUrls.length) break;

      const url = uniqueUrls[i];
      const result = await fetchMintInfo(url, timeout, batch.signal);
      // Cut off by the batch deadline: the caller has moved on, and a mint that
      // was merely slow should not be recorded as offline.
      if (batch.signal.aborted) break;
      results.push(result);

      if (onResult) {
        try {
          onResult(result);
        } catch {}
      }

      if (i < uniqueUrls.length - 1 && !batch.signal.aborted) {
        await delay(delayMs);
      }
    }
  };

  const workerCount = Math.min(concurrency, uniqueUrls.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  try {
    await Promise.race([Promise.all(workers), deadline]);
  } finally {
    clearTimeout(deadlineId);
    batch.abort();
  }

  return results.slice();
}

/**
 * Check if a cached result is still fresh.
 *
 * @param {Object} cachedResult - Previously fetched result or a recommendation
 * @param {number} [maxAgeSeconds=3600] - Maximum age in seconds (default: 1 hour)
 * @returns {boolean} True if the cache is still fresh
 */
function isCacheFresh(cachedResult, maxAgeSeconds = 3600) {
  if (!cachedResult) return false;
  // Accepts a fetchMintInfo result ({fetchedAt}) or a recommendation
  // ({lastHttpInfoFetchAt}).
  const fetchedAt = cachedResult.fetchedAt || cachedResult.lastHttpInfoFetchAt;
  if (!fetchedAt) return false;
  // A failed fetch is never fresh: retry it instead of showing a mint that was
  // briefly unreachable as offline for the whole cache period.
  if (cachedResult.error) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - fetchedAt < maxAgeSeconds;
}

module.exports = {
  MAX_INFO_BYTES,
  fetchMintInfo,
  fetchMintInfoBatch,
  isCacheFresh,
};
