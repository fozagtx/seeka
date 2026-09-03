// ─── index.ts ─────────────────────────────────────────────────────────────────

import { config } from "dotenv";
config();

// ── Catch 409 bot conflicts before they crash the process ────────────────────
// grammy's polling loop throws internally (not caught by try/catch around start)
process.on("unhandledRejection", (err: any) => {
  const is409 = err?.error_code === 409 || (err?.message && err.message.includes("409"));
  if (is409) {
    console.log("[Bot] 409 conflict suppressed (deploy handoff) — retrying...");
    return;
  }
  console.error("[Unhandled Rejection]", err);
});

import { createBot } from "./src/bot.js";
import { loadJobs, startAllJobs } from "./src/jobs.js";
import { setupNotionDatabase, initSeenUrls } from "./src/notion.js";
import { loadHistory as loadDedupeHistory } from "./src/dedupe.js";
import { runSearch } from "./src/pipeline.js";
import { formatTelegramMessage } from "./src/types.js";
import type { Hackathon, PipelineCallbacks } from "./src/types.js";

const PORT = Number(process.env.PORT || 3000);
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID!;

async function main() {
  console.log("🚀 Seeka — Hackathon Tracker starting...");

  const required = [
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_ADMIN_CHAT_ID",
    "EXA_API_KEY", "FIRECRAWL_API_KEY",
    "NOTION_API_KEY", "NOTION_DATABASE_ID",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌ Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  // ── Notion setup ──────────────────────────────────────────────────────────
  await setupNotionDatabase();
  await initSeenUrls();
  await loadDedupeHistory();

  // ── Bot ───────────────────────────────────────────────────────────────────
  const bot = createBot(ADMIN_CHAT_ID);

  // ── Shared pipeline callbacks ─────────────────────────────────────────────
  const makeCbs = (label: string): PipelineCallbacks => ({
    onStatus: async (msg: string) => {
      try {
        await bot.api.sendMessage(ADMIN_CHAT_ID, msg, {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
        });
      } catch (err) { console.error("[CB] onStatus:", err); }
    },
    onNew: async (h: Hackathon) => {
      try {
        await bot.api.sendMessage(ADMIN_CHAT_ID, formatTelegramMessage(h), {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
        });
      } catch (err) { console.error("[CB] onNew:", err); }
    },
    onSummary: async (msg: string) => {
      const prefix = label ? `🔄 *[${label}]*\n` : "";
      try {
        await bot.api.sendMessage(ADMIN_CHAT_ID, prefix + msg, {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
        });
      } catch (err) { console.error("[CB] onSummary:", err); }
    },
  });

  // ── Jobs ──────────────────────────────────────────────────────────────────
  await loadJobs();
  startAllJobs(makeCbs);

  // ── HTTP server ───────────────────────────────────────────────────────────
  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.pathname === "/run" && req.method === "POST") {
        const q = url.searchParams.get("q") || undefined;
        runSearch(q, makeCbs("HTTP Trigger")).catch(console.error);
        return new Response(JSON.stringify({ status: "triggered" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Seeka OK", { status: 200 });
    },
  });

  console.log(`🌐 HTTP server on http://localhost:${PORT}`);

  // ── Keep-alive (prevents Render free tier sleep) ──────────────────────────
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(async () => {
      try { await fetch(`${RENDER_URL}/health`); } catch {}
    }, 10 * 60 * 1000);
    console.log(`💓 Keep-alive pinging every 10 min`);
  }

  // ── Start bot ─────────────────────────────────────────────────────────────
  startBotWithRetry(bot, ADMIN_CHAT_ID).catch(console.error);
}

function startBotWithRetry(bot: ReturnType<typeof createBot>, adminChatId: string): Promise<void> {
  const delays = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000];
  let attempt = 0;

  const tryStart = async (): Promise<void> => {
    try {
      await bot.start({
        onStart: async (info) => {
          console.log(`✅ Bot @${info.username} online`);
          try {
            const jobs = (await import("./src/jobs.js")).listJobs();
            const jobLines = jobs
              .filter((j) => j.enabled)
              .map((j) => `• ${j.name}: \`${j.schedule}\``)
              .join("\n");
            await bot.api.sendMessage(
              adminChatId,
              `🟢 *Seeka is online\\!*\n\n` +
              `⏰ *Auto\\-scheduled searches:*\n${jobLines}\n\n` +
              `👆 Type /search whenever you're ready\\.\n` +
              `Cron jobs will fire automatically on schedule\\.`,
              { parse_mode: "MarkdownV2" }
            ).catch(() => {});
          } catch (err) {
            console.error("[Bot] onStart error:", err);
          }
        },
      });
    } catch (err: any) {
      const delay = delays[Math.min(attempt, delays.length - 1)];
      attempt++;
      console.error(`[Bot] Polling conflict (${err?.error_code || err?.message || err}) — retry in ${delay / 1000}s (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, delay));
      await tryStart();
    }
  };

  return tryStart();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});