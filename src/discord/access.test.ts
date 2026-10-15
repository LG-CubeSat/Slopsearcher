import {
  Collection,
  ChannelType,
  PermissionsBitField,
  PermissionFlagsBits,
  type GuildBasedChannel,
} from "discord.js";
import { expect, it } from "vitest";
import { audienceCompatible } from "./access.ts";
const view = PermissionFlagsBits.ViewChannel,
  history = PermissionFlagsBits.ReadMessageHistory;
function channel(
  id: string,
  publicRead: boolean,
  overwrites: { id: string; allow?: bigint; deny?: bigint }[] = [],
  type = ChannelType.GuildText,
): GuildBasedChannel {
  return {
    id,
    type,
    isThread: () => false,
    guild: { roles: { everyone: {} } },
    permissionsFor: () =>
      new PermissionsBitField(publicRead ? view | history : 0n),
    permissionOverwrites: {
      cache: new Collection(
        overwrites.map((o) => [
          o.id,
          {
            id: o.id,
            type: 0,
            allow: new PermissionsBitField(o.allow ?? 0n),
            deny: new PermissionsBitField(o.deny ?? 0n),
          },
        ]),
      ),
    },
  } as unknown as GuildBasedChannel;
}
it("does not expose a private source to a public destination", () => {
  expect(
    audienceCompatible(
      channel("private", false, [
        { id: "guild", deny: view },
        { id: "team", allow: view },
      ]),
      channel("public", true),
      "bot",
    ),
  ).toBe(false);
});
it("permits matching access overwrites even when posting permissions differ", () => {
  const common = [
    { id: "guild", deny: view },
    { id: "team", allow: view },
  ];
  expect(
    audienceCompatible(
      channel("a", false, [
        ...common,
        { id: "poster", allow: PermissionFlagsBits.SendMessages },
      ]),
      channel("b", false, [...common, { id: "bot", allow: view }]),
      "bot",
    ),
  ).toBe(true);
});
it("treats specific audience denials as a restriction even when everyone has view permission", () => {
  expect(
    audienceCompatible(
      channel("a", true, [{ id: "restricted", deny: view }]),
      channel("b", true),
      "bot",
    ),
  ).toBe(false);
});
it("never treats a private thread as a public source", () => {
  expect(
    audienceCompatible(
      channel("thread", true, [], ChannelType.PrivateThread),
      channel("public", true),
      "bot",
    ),
  ).toBe(false);
});
it("permits public project sources in a private destination", () => {
  expect(
    audienceCompatible(
      channel("public", true),
      channel("private", false, [{ id: "guild", deny: view }]),
      "bot",
    ),
  ).toBe(true);
});
