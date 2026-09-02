// ─── index.ts ─────────────────────────────────────────────────────────────────

import { config } from "dotenv";
config();

import { createBot } from "./src/bot.js";
import { loadJobs, startAllJobs } from "./src/jobs.js";
import { setupNotionDatabase, initSeenUrls } from "./src/notion.js";
import { runSearch } from "./src/pipeline.js";
import { formatTelegramMessage } from "./src/types.js";
import type { Hackathon } from "./src/types.js";

const PORT = Number(process.env.PORT || 3000);
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID!;

async function main() {
  console.log("🚀 Seeka — Hackathon Tracker Bot starting...");

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

  await setupNotionDatabase();
  await initSeenUrls();

  const bot = createBot(ADMIN_CHAT_ID);

  // ─── Callbacks ──────────────────────────────────────────────────────────────

  // Per-hackathon: send individual formatted message
  const onNew = async (h: Hackathon) => {
    try {
      await bot.api.sendMessage(ADMIN_CHAT_ID, formatTelegramMessage(h), {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error("[Bot] Error sending hackathon message:", err);
    }
  };

  // Summary after each job run
  const onSummary = async (msg: string) => {
    try {
      await bot.api.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[Bot] Error sending summary:", err);
    }
  };

  // ─── Jobs ───────────────────────────────────────────────────────────────────
  await loadJobs();
  startAllJobs(onNew, onSummary);

  // ─── Bot ────────────────────────────────────────────────────────────────────
  bot.start({
    onStart: async (info) => {
      console.log(`✅ Bot started as @${info.username}`);
      await bot.api
        .sendMessage(ADMIN_CHAT_ID, `🟢 *Seeka is online!*\n\nTap /start to run the first search.\nThen every *4 hours* automatically.\n\nType /help to see all commands.`, {
          parse_mode: "Markdown",
        })
        .catch(() => {});
    },
  });

  // ─── HTTP server ─────────────────────────────────────────────────────────
  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/run" && req.method === "POST") {
        const query = url.searchParams.get("q") || undefined;
        runSearch(query, onNew)
          .then(({ message }) => onSummary(`🌐 *[HTTP Trigger]*\n${message}`))
          .catch(() => {});
        return new Response(JSON.stringify({ status: "triggered" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Seeka OK", { status: 200 });
    },
  });

  console.log(`🌐 HTTP server on http://localhost:${PORT}`);

  // ─── Keep-alive ping (prevents Render free tier sleep) ────────────────────
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(async () => {
      try {
        const res = await fetch(`${RENDER_URL}/health`);
        console.log(`[Keep-alive] ${res.status}`);
      } catch (err) {
        console.warn(`[Keep-alive] Ping failed:`, err);
      }
    }, 10 * 60 * 1000); // every 10 minutes
    console.log(`💓 Keep-alive pinging ${RENDER_URL}/health every 10 min`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});