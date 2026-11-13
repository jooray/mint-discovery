/**
 * Which mint URLs discovery is willing to list and fetch.
 *
 * Mint URLs come from anyone who publishes on Nostr, and the browser that runs
 * discovery fetches each one. Only public https hosts are accepted, so an
 * announcement cannot point the operator's browser at plain http, at a raw IP
 * address or at a machine on their local network (router, NAS, localhost).
 */

// Hostnames that only resolve inside a local network.
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAcceptableMintUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.length > 2048) return false;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return false;
  // IPv6 literal (the URL parser keeps the brackets).
  if (host.startsWith("[") || host.includes(":")) return false;
  // IPv4 literal. The URL parser already rewrites 0x7f.1, 2130706433 and other
  // shorthand into dotted form, so this one check covers them.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  // Single-label names (no dot) never are public mints.
  if (!host.includes(".")) return false;
  if (host === "localhost") return false;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return false;

  return true;
}

module.exports = { isAcceptableMintUrl };
