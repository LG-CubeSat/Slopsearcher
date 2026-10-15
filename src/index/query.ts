/**
 * FTS5 treats plenty of punctuation as query syntax, so a user question like
 * `what's the I2C bus (rev 2)?` is a syntax error rather than a search. We take
 * the words ourselves and quote each one, which gives predictable behaviour and
 * removes any chance of malformed input reaching the matcher.
 */
export function toFtsQuery(raw: string): string | null {
  const terms = raw
    .toLowerCase()
    // Keep alphanumerics plus the characters that carry meaning in part
    // numbers and identifiers: STM32G431C8, 2.4ghz, i2c-bus, rs_485.
    .split(/[^\p{L}\p{N}._-]+/u)
    .map((term) => term.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((term) => term.length > 0);

  if (terms.length === 0) return null;

  // Doubling embedded quotes is the FTS5 escape for a quoted string literal.
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}
