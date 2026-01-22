/**
 * Review parser for Cashu mint reviews.
 * Parses the "[X/5] comment" format used in Nostr review events.
 */

/**
 * Parse a rating and comment from review content.
 * Reviews use the format: "[X/5] optional comment"
 *
 * @param {string} content - The review content to parse
 * @returns {{ rating: number|null, comment: string }} Parsed rating and comment
 *
 * @example
 * parseRatingAndComment("[5/5] Great mint!")
 * // => { rating: 5, comment: "Great mint!" }
 *
 * parseRatingAndComment("[3/5]")
 * // => { rating: 3, comment: "" }
 *
 * parseRatingAndComment("Just a comment without rating")
 * // => { rating: null, comment: "Just a comment without rating" }
 */
function parseRatingAndComment(content) {
  if (!content || typeof content !== "string") {
    return { rating: null, comment: "" };
  }

  const match = content.match(/\s*\[(\d)\s*\/\s*5\]\s*(.*)$/s);

  if (!match) {
    return { rating: null, comment: content.trim() };
  }

  const rating = parseInt(match[1], 10);
  const comment = (match[2] || "").trim();

  if (isNaN(rating) || rating < 1 || rating > 5) {
    return { rating: null, comment };
  }

  return { rating, comment };
}

module.exports = { parseRatingAndComment };
