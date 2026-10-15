import type { Message } from "discord.js";
import type { SourceInput } from "../index/types.ts";

/**
 * Discord renders mentions as `<@123>` and channels as `<#456>`, which search
 * can do nothing with. Substituting display names makes "who said the ADCS
 * board was done" findable by name rather than by snowflake.
 */
function expandMentions(message: Message): string {
  let text = message.content;

  for (const [id, user] of message.mentions.users) {
    text = text.replaceAll(`<@${id}>`, `@${user.username}`);
    text = text.replaceAll(`<@!${id}>`, `@${user.username}`);
  }
  for (const [id, role] of message.mentions.roles) {
    text = text.replaceAll(`<@&${id}>`, `@${role.name}`);
  }
  for (const [id, channel] of message.mentions.channels) {
    const name = "name" in channel && channel.name ? channel.name : id;
    text = text.replaceAll(`<#${id}>`, `#${name}`);
  }
  return text;
}

/**
 * Embeds and attachments routinely carry the actual content -- a linked
 * datasheet, a pasted error in an embed description, a photo of a board. Fold
 * the searchable parts into the indexed text rather than dropping them.
 */
function describeAttachments(message: Message): string[] {
  const parts: string[] = [];

  for (const attachment of message.attachments.values()) {
    parts.push(`[attachment: ${attachment.name ?? "file"}] ${attachment.url}`);
  }
  for (const embed of message.embeds) {
    const fields = [
      embed.title,
      embed.description,
      embed.url,
      ...embed.fields.map((field) => `${field.name}: ${field.value}`),
    ].filter((value): value is string => Boolean(value));
    if (fields.length > 0) parts.push(`[embed] ${fields.join(" — ")}`);
  }
  return parts;
}

export function messageUrl(
  guildId: string,
  channelId: string,
  messageId: string,
): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/**
 * Returns null for messages with nothing to index -- a bare reaction-like
 * message or a join notice. Keeping them out holds the FTS index to content
 * that can actually answer a question.
 */
export function toSourceInput(
  message: Message,
  guildId: string,
): SourceInput | null {
  const body = [expandMentions(message), ...describeAttachments(message)]
    .filter((part) => part.trim().length > 0)
    .join("\n");

  if (body.trim().length === 0) return null;

  const channelName =
    message.channel && "name" in message.channel ? message.channel.name : null;

  return {
    kind: "discord",
    externalId: message.id,
    url: messageUrl(guildId, message.channelId, message.id),
    channelId: message.channelId,
    channelName: channelName ?? null,
    author: message.author?.username ?? null,
    parentId: message.reference?.messageId ?? null,
    title: null,
    ts: message.createdTimestamp,
    text: body,
  };
}
