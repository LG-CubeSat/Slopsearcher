import { ChannelType, PermissionFlagsBits, type GuildBasedChannel } from "discord.js";
// Matching overwrite sets allow project teams to use their private channels
// together. Public-channel answers can additionally cite public sources.
export function permissionSignature(channel: GuildBasedChannel, botId: string): string {
  const c = channel.isThread() ? channel.parent : channel;
  if (!c || !("permissionOverwrites" in c)) return "unavailable";
  return [...c.permissionOverwrites.cache.values()].filter(o => o.id !== botId).map(o => `${o.id}:${o.type}:${o.allow.bitfield}:${o.deny.bitfield}`).sort().join("|");
}
export function audienceCompatible(source: GuildBasedChannel, destination: GuildBasedChannel, botId: string): boolean {
  if (source.id === destination.id) return true;
  if (source.type === ChannelType.PrivateThread) return false;
  const everyone = source.permissionsFor(source.guild.roles.everyone);
  const base = source.isThread() ? source.parent : source;
  const noAudienceDenials = base && "permissionOverwrites" in base && ![...base.permissionOverwrites.cache.values()].some(o => o.id !== botId && o.deny.any([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));
  if (everyone?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]) && noAudienceDenials) return true;
  return permissionSignature(source, botId) !== "unavailable" && permissionSignature(source, botId) === permissionSignature(destination, botId);
}
