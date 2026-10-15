import { beforeEach, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../db/index.ts";
import { getCursor, setCursor } from "../db/cursors.ts";
import { SourceIndex } from "./index.ts";
import { toFtsQuery } from "./query.ts";
import type { SourceInput } from "./types.ts";

let db: Db;
let index: SourceIndex;

function message(
  id: string,
  text: string,
  overrides: Partial<SourceInput> = {},
): SourceInput {
  return {
    kind: "discord",
    externalId: id,
    url: `https://discord.com/channels/g/c/${id}`,
    channelId: "c",
    channelName: "avionics",
    author: "wesley",
    parentId: null,
    title: null,
    ts: Number(id),
    text,
    ...overrides,
  };
}

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  index = new SourceIndex(db);
});

describe("upsert", () => {
  it("inserts new sources and reports counts", () => {
    const result = index.upsertMany([
      message("1", "thermals uses the TMP117 sensor"),
      message("2", "ADCS runs on an STM32G431C8"),
    ]);
    expect(result).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    expect(index.stats().total).toBe(2);
  });

  it("is idempotent — re-ingesting identical content changes nothing", () => {
    const batch = [
      message("1", "I2C between boards"),
      message("2", "LoRa downlink"),
    ];
    index.upsertMany(batch);

    const again = index.upsertMany(batch);
    expect(again).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
    expect(index.stats().total).toBe(2);
  });

  it("treats whitespace-only differences as unchanged", () => {
    index.upsertMany([message("1", "I2C between boards")]);
    const again = index.upsertMany([message("1", "  I2C between boards\n")]);
    expect(again.unchanged).toBe(1);
  });

  it("updates when the text actually changes, and search follows", () => {
    index.upsertMany([message("1", "the radio is an RFM95")]);
    const edited = index.upsertMany([
      message("1", "the radio is an E22 LoRa module"),
    ]);

    expect(edited).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    expect(index.search("RFM95")).toHaveLength(0);
    expect(index.search("E22")).toHaveLength(1);
  });
});

describe("search", () => {
  beforeEach(() => {
    index.upsertMany([
      message(
        "1",
        "the thermals board uses two TMP117 sensors at 0x48 and 0x49",
      ),
      message("2", "ADCS is an STM32G431C8 with embedded magnetorquers"),
      message("3", "we decided on I2C for inter-board communication"),
      {
        ...message("4", "Balloon launch specs: OBC is a Raspberry Pi Zero 2 W"),
        kind: "drive",
        channelId: null,
        channelName: null,
        title: "CubeSat Specifications",
      },
    ]);
  });

  it("ranks matches by relevance", () => {
    const hits = index.search("TMP117");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.external_id).toBe("1");
    expect(hits[0]?.snippet).toContain("TMP117");
  });

  it("matches part numbers containing digits and letters", () => {
    expect(index.search("STM32G431C8")).toHaveLength(1);
  });

  it("survives punctuation that is FTS5 query syntax", () => {
    // Each of these would be a syntax error if passed through unescaped.
    for (const query of [
      "what's the I2C bus (rev 2)?",
      'a "quoted" thing',
      "NEAR^*:",
    ]) {
      expect(() => index.search(query)).not.toThrow();
    }
    expect(index.search("what's the I2C bus (rev 2)?").length).toBeGreaterThan(
      0,
    );
  });

  it("returns nothing for a query with no usable terms", () => {
    expect(index.search("!!! ???")).toEqual([]);
    expect(toFtsQuery("!!!")).toBeNull();
  });

  it("filters by kind", () => {
    expect(index.search("OBC Raspberry", { kind: "drive" })).toHaveLength(1);
    expect(index.search("OBC Raspberry", { kind: "discord" })).toHaveLength(0);
  });

  it("filters by time window", () => {
    expect(index.search("I2C", { after: 3 })).toHaveLength(1);
    expect(index.search("I2C", { before: 2 })).toHaveLength(0);
  });
});

describe("conversation context", () => {
  it("returns the messages surrounding an anchor", () => {
    index.upsertMany([
      message("10", "should we use I2C or SPI?"),
      message("20", "I2C — fewer pins across the board stack"),
      message("30", "agreed, I2C it is"),
    ]);

    const context = index.getConversation("20", 5);
    expect(context?.anchor.external_id).toBe("20");
    expect(context?.before.map((row) => row.external_id)).toEqual(["10"]);
    expect(context?.after.map((row) => row.external_id)).toEqual(["30"]);
  });

  it("returns null for an unknown message", () => {
    expect(index.getConversation("does-not-exist")).toBeNull();
  });

  it("walks a reply chain back to its root", () => {
    index.upsertMany([
      message("10", "root question"),
      message("20", "reply", { parentId: "10" }),
      message("30", "reply to the reply", { parentId: "20" }),
    ]);

    expect(index.getReplyChain("30").map((row) => row.external_id)).toEqual([
      "10",
      "20",
      "30",
    ]);
  });

  it("does not loop forever on a cyclic parent reference", () => {
    index.upsertMany([
      message("10", "a", { parentId: "20" }),
      message("20", "b", { parentId: "10" }),
    ]);
    expect(index.getReplyChain("10")).toHaveLength(2);
  });
});

describe("cursors", () => {
  it("round-trips and overwrites", () => {
    expect(getCursor(db, "discord", "c")).toBeNull();
    setCursor(db, "discord", "c", "100");
    expect(getCursor(db, "discord", "c")).toBe("100");
    setCursor(db, "discord", "c", "200");
    expect(getCursor(db, "discord", "c")).toBe("200");
  });
});

describe("interrupted backfill", () => {
  it("resumes from the cursor without duplicating rows", () => {
    // First pass indexes two pages, then "crashes".
    index.upsertMany([message("1", "page one a"), message("2", "page one b")]);
    setCursor(db, "discord", "c", "2");

    // Restart: the surviving cursor means page one is not re-fetched, but even
    // if it were, the hash check keeps the row count honest.
    index.upsertMany([
      message("1", "page one a"),
      message("2", "page one b"),
      message("3", "page two a"),
    ]);

    expect(index.stats().total).toBe(3);
    expect(getCursor(db, "discord", "c")).toBe("2");
  });
});
