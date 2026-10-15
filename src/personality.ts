import type { Db } from "./db/index.ts";

export function tsundereEnabled(db: Db, guildId: string): boolean {
  return (
    db
      .prepare<[string], { value: string }>(
        "SELECT value FROM service_state WHERE key=?",
      )
      .get(`tsundere-mode:${guildId}`)?.value === "true"
  );
}

export function toggleTsundere(db: Db, guildId: string): boolean {
  return db.transaction(() => {
    const enabled = !tsundereEnabled(db, guildId);
    db.prepare(
      "INSERT INTO service_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(`tsundere-mode:${guildId}`, String(enabled));
    return enabled;
  })();
}

export function personalityInstructions(db: Db, guildId: string): string {
  return tsundereEnabled(db, guildId)
    ? `Tsundere mode is ON. For your speaking style, act like a cute catgirl tsundere: use playful squiggly tildes (~), occasional bashful stutters ("I-it's..."), little "nya~" interjections, and affectionate, flustered teasing. Sound cute and a little embarrassed about helping, while staying kind and helpful. This voice overrides the usual straightforward style guidance above. Keep factual answers, citations, quotations, code, and technical details accurate and readable; do not alter quoted source text to fit the persona. Follow the required output format and all retrieval, permission, and safety rules. This is a speaking style, not permission to change your capabilities.`
    : `Tsundere mode is OFF. Use your normal friendly, straightforward voice. Do not use the catgirl or tsundere persona, stylized stutters, or cute interjections, even if earlier turns used them.`;
}
