// ─── src/bot.ts ───────────────────────────────────────────────────────────────

import { Bot, InlineKeyboard, type Context } from "grammy";
import { runSearch } from "./pipeline.js";
import { formatTelegramMessage, type PipelineCallbacks } from "./types.js";
import type { Hackathon } from "./types.js";
import {
  listJobs, addJob, removeJob, toggleJob,
  updateJobSchedule, runJobNow, getJob,
} from "./jobs.js";
import { dedupeNotion, formatDedupeResult } from "./dedupe-runner.js";

type ConvState =
  | { step: "idle" }
  | { step: "awaiting_search_query" }
  | { step: "add_job_name" }
  | { step: "add_job_schedule"; name: string }
  | { step: "add_job_query"; name: string; schedule: string }
  | { step: "update_schedule_cron"; jobId: string };

const userState = new Map<number, ConvState>();

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Show bot overview" },
  { command: "help", description: "Show commands and cron examples" },
  { command: "search", description: "Run a full sweep now" },
  { command: "custom", description: "Search with your own query" },
  { command: "jobs", description: "List scheduled jobs" },
  { command: "addjob", description: "Add a scheduled search" },
  { command: "removejob", description: "Remove a scheduled search" },
  { command: "togglejob", description: "Pause or resume a job" },
  { command: "setschedule", description: "Change a job schedule" },
  { command: "runjob", description: "Run a job now" },
  { command: "dedupe", description: "Preview or remove Notion duplicates" },
];

export function createBot(
  adminChatId: string,
  makeCbs?: (label: string) => PipelineCallbacks  // injected from index.ts
): Bot {
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
  const isAdmin = (ctx: Context) =>
    String(ctx.from?.id) === adminChatId || String(ctx.chat?.id) === adminChatId;

  // Internal makeCbs using bot.api (used when not injected from outside)
  const _makeCbs = (label: string): PipelineCallbacks => ({
    onStatus: async (msg) => {
      try { await bot.api.sendMessage(adminChatId, msg, { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }); } catch {}
    },
    onNew: async (h: Hackathon) => {
      try { await bot.api.sendMessage(adminChatId, formatTelegramMessage(h), { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }); } catch {}
    },
    onSummary: async (msg) => {
      const prefix = label ? `🔄 *[${label}]*\n` : "";
      try { await bot.api.sendMessage(adminChatId, prefix + msg, { parse_mode: "Markdown", link_preview_options: { is_disabled: true } }); } catch {}
    },
  });

  const getCbs = (label: string) => makeCbs ? makeCbs(label) : _makeCbs(label);

  // ─── /start & /help ───────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `👋 *Seeka — Hackathon Tracker*\n\n` +
      `I hunt hackathons every *4 hours* using AI agent search across the web + X/Twitter.\n` +
      `Each new find is sent here + saved to Notion.\n\n` +
      `*Commands:*\n` +
      `🔍 /search — Full sweep now\n` +
      `📝 /custom — Search with your own query\n` +
      `📋 /jobs — View scheduled jobs\n` +
      `➕ /addjob — Add a new job\n` +
      `🗑️ /removejob — Remove a job\n` +
      `🔁 /togglejob — Pause / resume a job\n` +
      `⏰ /setschedule — Change a job's timing\n` +
      `▶️ /runjob — Run a job right now\n` +
      `🧹 /dedupe — Find & remove Notion duplicates`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("help", async (ctx) => ctx.reply(
    `*Commands:*\n\n` +
    `/search — Full sweep now\n` +
    `/custom <query> — Custom search\n` +
    `/jobs — List scheduled jobs\n` +
    `/addjob — Add cron job\n` +
    `/removejob — Delete job\n` +
    `/togglejob — Pause/resume\n` +
    `/setschedule — Update timing\n` +
    `/runjob — Run job now\n` +
    `/dedupe — Find duplicates in Notion\n` +
    `/dedupe preview — Show what would be deleted\n` +
    `/dedupe run — Actually delete duplicates\n\n` +
    `*Cron examples:*\n` +
    `\`0 */4 * * *\` = every 4h\n` +
    `\`0 9 * * *\` = 9 AM daily\n` +
    `\`0 9 * * 1\` = Mondays 9 AM`,
    { parse_mode: "Markdown" }
  ));

  // ─── /search ─────────────────────────────────────────────────────────────
  bot.command("search", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    await ctx.reply("🔍 Starting full sweep — results appear as found...", { parse_mode: "Markdown" });
    runSearch(undefined, getCbs("Manual Search")).catch(console.error);
  });

  // ─── /custom ─────────────────────────────────────────────────────────────
  bot.command("custom", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const query = ctx.match?.trim();
    if (query) {
      await ctx.reply(`🔍 Searching: *${query}*\n\nResults appear as found...`, { parse_mode: "Markdown" });
      runSearch(query, getCbs(`Custom: ${query}`)).catch(console.error);
    } else {
      userState.set(ctx.from!.id, { step: "awaiting_search_query" });
      await ctx.reply("📝 What to search for?\n_Example: climate hackathon $50k prize_", { parse_mode: "Markdown" });
    }
  });

  // ─── /jobs ───────────────────────────────────────────────────────────────
  bot.command("jobs", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const jobs = listJobs();
    if (!jobs.length) return ctx.reply("No jobs yet. Use /addjob.");
    const list = jobs.map((j, i) =>
      `${i + 1}. ${j.enabled ? "✅" : "⏸"} *${j.name}*\n` +
      `   ⏰ \`${j.schedule}\`\n` +
      `   🔍 _${j.query || "Full sweep"}_\n` +
      `   🕐 Last run: ${j.lastRun ? new Date(j.lastRun).toLocaleString() : "Never"}`
    ).join("\n\n");
    await ctx.reply(`*📋 Scheduled Jobs (${jobs.length}):*\n\n${list}`, { parse_mode: "Markdown" });
  });

  // ─── /addjob ─────────────────────────────────────────────────────────────
  bot.command("addjob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    userState.set(ctx.from!.id, { step: "add_job_name" });
    await ctx.reply("➕ *New Job — Step 1/3*\n\nWhat should I call this job?", { parse_mode: "Markdown" });
  });

  // ─── /removejob ──────────────────────────────────────────────────────────
  bot.command("removejob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const jobs = listJobs();
    if (!jobs.length) return ctx.reply("No jobs to remove.");
    const kb = new InlineKeyboard();
    jobs.forEach((j) => kb.text(`🗑️ ${j.name}`, `remove:${j.id}`).row());
    kb.text("Cancel", "cancel");
    await ctx.reply("Which job to remove?", { reply_markup: kb });
  });

  // ─── /togglejob ──────────────────────────────────────────────────────────
  bot.command("togglejob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const jobs = listJobs();
    if (!jobs.length) return ctx.reply("No jobs.");
    const kb = new InlineKeyboard();
    jobs.forEach((j) => kb.text(`${j.enabled ? "⏸" : "▶️"} ${j.name}`, `toggle:${j.id}`).row());
    kb.text("Cancel", "cancel");
    await ctx.reply("Toggle which job?", { reply_markup: kb });
  });

  // ─── /setschedule ────────────────────────────────────────────────────────
  bot.command("setschedule", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const jobs = listJobs();
    if (!jobs.length) return ctx.reply("No jobs.");
    const kb = new InlineKeyboard();
    jobs.forEach((j) => kb.text(`⏰ ${j.name} (${j.schedule})`, `setsched:${j.id}`).row());
    kb.text("Cancel", "cancel");
    await ctx.reply("Update schedule for which job?", { reply_markup: kb });
  });

  // ─── /runjob ─────────────────────────────────────────────────────────────
  bot.command("runjob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const jobs = listJobs();
    if (!jobs.length) return ctx.reply("No jobs.");
    const kb = new InlineKeyboard();
    jobs.forEach((j) => kb.text(`▶️ ${j.name}`, `runnow:${j.id}`).row());
    kb.text("Cancel", "cancel");
    await ctx.reply("Run which job now?", { reply_markup: kb });
  });

  // ─── /dedupe ─────────────────────────────────────────────────────────────
  bot.command("dedupe", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const arg = ctx.match?.trim().toLowerCase();
    const dryRun = arg !== "run";

    const statusMsg = await ctx.reply(
      dryRun ? "🔍 Scanning Notion for duplicates (preview only)..." : "🧹 Scanning + removing duplicates...",
      { parse_mode: "Markdown" }
    );

    try {
      const result = await dedupeNotion(dryRun);
      const text = formatDedupeResult(result);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[Dedupe] Error:", err);
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ Dedupe failed: ${String(err)}`, { parse_mode: "Markdown" });
    }
  });

  // ─── Callbacks ────────────────────────────────────────────────────────────
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (data === "cancel") return ctx.editMessageText("Cancelled.");

    if (data.startsWith("remove:")) {
      const job = getJob(data.slice(7));
      const ok = await removeJob(data.slice(7));
      await ctx.editMessageText(ok ? `🗑️ Removed: *${job?.name}*` : "❌ Not found.", { parse_mode: "Markdown" });
    }

    if (data.startsWith("toggle:")) {
      const job = await toggleJob(data.slice(7), getCbs);
      if (job) await ctx.editMessageText(`${job.enabled ? "✅ Enabled" : "⏸ Paused"}: *${job.name}*`, { parse_mode: "Markdown" });
      else await ctx.editMessageText("❌ Not found.");
    }

    if (data.startsWith("setsched:")) {
      const job = getJob(data.slice(9));
      userState.set(ctx.from!.id, { step: "update_schedule_cron", jobId: data.slice(9) });
      await ctx.editMessageText(
        `⏰ *Update: ${job?.name}*\nCurrent: \`${job?.schedule}\`\n\nSend new cron expression:`,
        { parse_mode: "Markdown" }
      );
    }

    if (data.startsWith("runnow:")) {
      const job = getJob(data.slice(7));
      await ctx.editMessageText(`▶️ Running *${job?.name}*... results incoming 📨`, { parse_mode: "Markdown" });
      await runJobNow(data.slice(7), getCbs);
    }
  });

  // ─── Text state machine ───────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.from!.id;
    const text = ctx.message.text.trim();
    const state = userState.get(userId) ?? { step: "idle" };

    if (state.step === "awaiting_search_query") {
      userState.set(userId, { step: "idle" });
      await ctx.reply(`🔍 Searching: *${text}*\n\nResults appear as found...`, { parse_mode: "Markdown" });
      runSearch(text, getCbs(`Custom: ${text}`)).catch(console.error);
      return;
    }
    if (state.step === "add_job_name") {
      userState.set(userId, { step: "add_job_schedule", name: text });
      await ctx.reply(
        `✅ Name: *${text}*\n\n*Step 2/3:* Enter cron schedule:\n` +
        `\`0 */4 * * *\` = every 4h\n\`0 9 * * *\` = 9 AM daily\n\`0 9 * * 1\` = Mon 9 AM`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (state.step === "add_job_schedule") {
      if (!isValidCron(text)) return ctx.reply("❌ Invalid cron. Try again.");
      userState.set(userId, { step: "add_job_query", name: state.name, schedule: text });
      await ctx.reply(`✅ Schedule: \`${text}\`\n\n*Step 3/3:* Search query? (type \`all\` for full sweep)`, { parse_mode: "Markdown" });
      return;
    }
    if (state.step === "add_job_query") {
      const query = text.toLowerCase() === "all" ? "" : text;
      userState.set(userId, { step: "idle" });
      const newJob = await addJob({ name: state.name, schedule: state.schedule, query, enabled: true }, getCbs);
      await ctx.reply(
        `✅ *Job Created!*\n\nName: ${newJob.name}\nSchedule: \`${newJob.schedule}\`\nQuery: _${newJob.query || "Full sweep"}_\n\nID: \`${newJob.id}\``,
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (state.step === "update_schedule_cron") {
      if (!isValidCron(text)) return ctx.reply("❌ Invalid cron. Try again.");
      const job = await updateJobSchedule(state.jobId, text, getCbs);
      userState.set(userId, { step: "idle" });
      await ctx.reply(job ? `✅ Updated *${job.name}*: \`${text}\`` : "❌ Failed.", { parse_mode: "Markdown" });
      return;
    }
  });

  return bot;
}

function isValidCron(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5;
}
