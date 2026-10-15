import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAndMigrate, type Db } from "../db/index.ts";
import { SourceIndex } from "../index/index.ts";
import { MemoryStore } from "./store.ts";
let db: Db;
let index: SourceIndex;
let memory: MemoryStore;
const input = {
  kind: "discord" as const,
  externalId: "123",
  channelId: "private",
  url: "https://discord.com/channels/g/private/123",
  ts: 1,
  text: "The radio is RFM95",
};
beforeEach(() => {
  db = openAndMigrate(":memory:");
  index = new SourceIndex(db);
  memory = new MemoryStore(db);
  index.upsert(input);
});
afterEach(() => db.close());
function extract() {
  const source = index.getByExternalId("discord", "123")!;
  memory.save([source], {
    notes: [
      {
        claim: "The radio is RFM95",
        kind: "fact",
        subsystem: "radio",
        confidence: 1,
        sourceIds: [source.id],
      },
    ],
  });
}
describe("project memory freshness", () => {
  it("keeps cited notes searchable and respects source permissions", () => {
    extract();
    expect(memory.search("radio", () => true)).toHaveLength(1);
    expect(memory.search("radio", () => false)).toEqual([]);
    expect(memory.pending(10)).toEqual([]);
  });
  it("invalidates memory when a cited message changes", () => {
    extract();
    index.upsert({ ...input, text: "The radio is E22" });
    expect(memory.search("radio", () => true)).toEqual([]);
    expect(memory.pending(10)).toHaveLength(1);
    expect(index.search("RFM95")).toEqual([]);
  });
  it("retires deleted sources from source and memory searches", () => {
    extract();
    index.retire("discord", "123");
    expect(index.search("radio")).toEqual([]);
    expect(memory.search("radio", () => true)).toEqual([]);
    expect(index.getByExternalId("discord", "123")).toBeNull();
  });
  it("discards extraction results if the source changed during inference", () => {
    const sources = memory.pending(10);
    index.upsert({ ...input, text: "New decision" });
    expect(
      memory.save(sources, {
        notes: [
          {
            claim: "old",
            kind: "fact",
            subsystem: null,
            confidence: 1,
            sourceIds: [sources[0]!.id],
          },
        ],
      }),
    ).toBe(0);
    expect(memory.pending(10)).toHaveLength(1);
  });
  it("rejects invented citation IDs", () => {
    const sources = memory.pending(10);
    expect(
      memory.save(sources, {
        notes: [
          {
            claim: "unsupported",
            kind: "fact",
            subsystem: null,
            confidence: 1,
            sourceIds: [999],
          },
        ],
      }),
    ).toBe(0);
  });
  it("cannot retrieve private source matches through an allowed-channel filter", () => {
    expect(index.search("radio", { allowedChannelIds: ["public"] })).toEqual(
      [],
    );
    expect(
      index.search("radio", { allowedChannelIds: ["private"] }),
    ).toHaveLength(1);
  });
});
it("replaces a clearly superseded decision while preserving its history", () => {
  extract();
  const old = memory.recentFor([index.getByExternalId("discord", "123")!])[0]!;
  index.upsert({
    ...input,
    externalId: "124",
    ts: 2,
    text: "New decision: use E22",
  });
  const pending = memory.pending(10);
  const previous = memory.recentFor(pending);
  memory.save(
    pending,
    {
      notes: [
        {
          claim: "The radio is now E22",
          kind: "decision",
          subsystem: "radio",
          confidence: 1,
          sourceIds: [pending[0]!.id],
          supersedesIds: [old.id],
        },
      ],
    },
    previous.map((n) => n.id),
  );
  const notes = memory.search("radio", () => true) as { claim: string }[];
  expect(notes).toHaveLength(1);
  expect(notes[0]?.claim).toContain("E22");
  expect(
    db.prepare("SELECT superseded_by FROM memories WHERE id=?").get(old.id),
  ).toMatchObject({ superseded_by: 2 });
});
it("keeps extraction batches within a single source channel", () => {
  index.upsert({
    ...input,
    externalId: "other",
    channelId: "another-private",
    ts: 2,
  });
  const pending = memory.pending(30);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.channel_id).toBe("another-private");
});
