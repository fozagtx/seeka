// ─── index.ts ─────────────────────────────────────────────────────────────────
// Entry point — starts the HTTP server, bot, and cron jobs

import { config } from "dotenv";
config();

import { createBot } from "./src/bot.js";
import { loadJobs, startAllJobs } from "./src/jobs.js";
import { setupNotionDatabase, initSeenUrls } from "./src/notion.js";
import { runSearch } from "./src/pipeline.js";

const PORT = Number(process.env.PORT || 3000);
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID!;

async function main() {
  console.log("🚀 Seeka — Hackathon Tracker Bot starting...");

  // Validate required env vars
  const required = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ADMIN_CHAT_ID",
    "EXA_API_KEY",
    "FIRECRAWL_API_KEY",
    "NOTION_API_KEY",
    "NOTION_DATABASE_ID",
  ];

  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in your API keys.");
    process.exit(1);
  }

  // Init Notion database schema
  console.log("[Notion] Setting up database...");
  await setupNotionDatabase();

  // Load previously seen URLs (deduplication)
  console.log("[Notion] Loading existing entries...");
  await initSeenUrls();

  // Create and configure bot
  const bot = createBot(ADMIN_CHAT_ID);

  // Load and start cron jobs
  console.log("[Jobs] Loading cron jobs...");
  await loadJobs();

  startAllJobs(async (msg: string) => {
    try {
      await bot.api.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[Server] Error sending cron result:", err);
    }
  });

  // Start bot (long polling)
  console.log("[Bot] Starting long polling...");
  bot.start({
    onStart: (info) => {
      console.log(`✅ Bot started as @${info.username}`);
      // Notify admin
      bot.api
        .sendMessage(
          ADMIN_CHAT_ID,
          `🟢 *Seeka Bot is online!*\n\nType /help to see available commands.`,
          { parse_mode: "Markdown" }
        )
        .catch(() => {});
    },
  });

  // HTTP health check server
  const server = Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            bot: "running",
            timestamp: new Date().toISOString(),
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/run" && req.method === "POST") {
        // Manual trigger via HTTP (e.g., from external cron)
        const query = url.searchParams.get("q") || undefined;
        runSearch(query).then(({ pushed, message }) => {
          bot.api
            .sendMessage(ADMIN_CHAT_ID, `🌐 *[HTTP Trigger]*\n${message}`, {
              parse_mode: "Markdown",
            })
            .catch(() => {});
        });
        return new Response(JSON.stringify({ status: "triggered" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Seeka Hackathon Tracker — OK", { status: 200 });
    },
  });

  console.log(`🌐 HTTP server running on http://localhost:${PORT}`);
  console.log(`   GET  /health — health check`);
  console.log(`   POST /run?q=<query> — trigger search via HTTP`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});