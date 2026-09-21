// ─── src/telegram.ts ──────────────────────────────────────────────────────────
// Sends a hackathon to Telegram as a photo (when we have an image) or as text

import type { Api } from "grammy";
import { formatTelegramMessage, formatTelegramCaption } from "./types.js";
import type { Hackathon } from "./types.js";

export async function sendHackathon(api: Api, chatId: string, h: Hackathon): Promise<void> {
  if (h.imageUrl) {
    try {
      await api.sendPhoto(chatId, h.imageUrl, {
        caption: formatTelegramCaption(h),
        parse_mode: "Markdown",
      });
      return;
    } catch (err) {
      console.error(`[Telegram] sendPhoto failed for ${h.name} (${h.imageUrl}) — falling back to text:`, err);
    }
  }

  await api.sendMessage(chatId, formatTelegramMessage(h), {
    parse_mode: "Markdown",
    link_preview_options: { is_disabled: true },
  });
}
