// Posting a clip straight into a Discord channel.
//
// This sidesteps file hosting entirely: instead of uploading to catbox and
// pasting a link that Discord then has to fetch, the clip is attached to a
// webhook message and Discord stores it. That gives a native inline player -
// the best embed available - and it cannot be broken by somebody else's storage
// problems, which is what made every hosted option unreliable.
//
// Nothing here fires on its own. The server only calls it when the user presses
// Send to Discord on one specific clip.

import fs from "node:fs";
import path from "node:path";

// Discord's attachment ceiling for a server with no boosts. Boost level 2 is
// 50MB and level 3 is 100MB, so this is the floor rather than a hard truth -
// hence the check is advisory and Discord's own 413 is still handled below.
export const DEFAULT_LIMIT = 10 * 1024 * 1024;

const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;

/** Is this a Discord webhook URL? Checked before use so a typo fails clearly. */
export function looksLikeWebhook(url) {
  return WEBHOOK_RE.test(String(url ?? "").trim());
}

/** The channel a webhook posts to, for showing the user what they linked. */
export async function describeWebhook(url, { signal } = {}) {
  if (!looksLikeWebhook(url)) throw new Error("That is not a Discord webhook URL.");
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(res.status === 401 || res.status === 404
      ? "Discord does not recognise that webhook - it may have been deleted, or the URL is incomplete."
      : `Discord returned ${res.status} for that webhook.`);
  }
  const j = await res.json();
  return { name: j.name, channelId: j.channel_id, guildId: j.guild_id };
}

/**
 * Attach a clip to a webhook message.
 *
 * `wait=true` makes Discord return the created message, which is the only way
 * to know it really landed - and it carries the CDN url of the attachment.
 */
export async function postClip(webhook, file, {
  content = "", limitBytes = DEFAULT_LIMIT, signal,
} = {}) {
  if (!looksLikeWebhook(webhook)) {
    throw new Error("No Discord webhook set. Paste one from Channel Settings → Integrations → Webhooks.");
  }
  const bytes = fs.statSync(file).size;
  if (bytes > limitBytes) {
    throw new Error(
      `Clip is ${(bytes / 1048576).toFixed(1)}MB and Discord takes ${(limitBytes / 1048576).toFixed(0)}MB `
      + "in an unboosted server. Render it at a smaller quality, or mark a shorter range.");
  }

  const form = new FormData();
  // payload_json carries everything that is not the file itself.
  form.append("payload_json", JSON.stringify({
    content: content.slice(0, 1900),
    allowed_mentions: { parse: [] },     // a clip should never ping anyone
  }));
  form.append("files[0]", await fs.openAsBlob(file), path.basename(file));

  const res = await fetch(`${webhook}?wait=true`, { method: "POST", body: form, signal });
  if (res.status === 413) {
    throw new Error(`Discord rejected the clip as too large (${(bytes / 1048576).toFixed(1)}MB). `
      + "Render it smaller, or post it in a boosted server.");
  }
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`Discord is rate limiting; try again in ${Math.ceil(j.retry_after ?? 5)}s.`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`Discord refused the post (${res.status}): ${text}`);
  }

  const msg = await res.json();
  return {
    messageId: msg.id,
    channelId: msg.channel_id,
    // Attachment urls are signed and expire, so this is for confirming the post
    // landed - the message in the channel is the durable thing.
    attachment: msg.attachments?.[0]?.url ?? null,
    bytes,
  };
}
