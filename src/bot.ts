// ─── src/bot.ts ───────────────────────────────────────────────────────────────

import { Bot, InlineKeyboard, type Context } from "grammy";
import { runSearch, isSearchRunning } from "./pipeline.js";
import { formatTelegramMessage } from "./types.js";
import type { Hackathon } from "./types.js";
import {
  listJobs, addJob, removeJob, toggleJob,
  updateJobSchedule, runJobNow, getJob,
} from "./jobs.js";

type ConvState =
  | { step: "idle" }
  | { step: "awaiting_search_query" }
  | { step: "add_job_name" }
  | { step: "add_job_schedule"; name: string }
  | { step: "add_job_query"; name: string; schedule: string }
  | { step: "update_schedule_cron"; jobId: string };

const userState = new Map<number, ConvState>();

export function createBot(adminChatId: string): Bot {
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
  const isAdmin = (ctx: Context) =>
    String(ctx.from?.id) === adminChatId || String(ctx.chat?.id) === adminChatId;

  // Shared callbacks passed down from index.ts
  const onNew = async (h: Hackathon) => {
    try {
      await bot.api.sendMessage(adminChatId, formatTelegramMessage(h), {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      console.error("[Bot] Error sending hackathon message:", err);
    }
  };
  const onSummary = async (msg: string) => {
    try {
      await bot.api.sendMessage(adminChatId, msg, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[Bot] Error sending summary:", err);
    }
  };

  // ─── /start & /help ───────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `👋 *Seeka — Hackathon Tracker*\n\n` +
      `I hunt hackathons & competitions every *4 hours* and send them here + to Notion.\n\n` +
      `*Commands:*\n` +
      `🔍 /search — Sweep all platforms now\n` +
      `📝 /custom — Search with your own query\n` +
      `📋 /jobs — View scheduled jobs\n` +
      `➕ /addjob — Add a new job\n` +
      `🗑️ /removejob — Remove a job\n` +
      `🔁 /togglejob — Pause / resume a job\n` +
      `⏰ /setschedule — Change a job's timing\n` +
      `▶️ /runjob — Run a job right now`,
      { parse_mode: "Markdown" }
    );

    if (!isAdmin(ctx)) return;
    if (isSearchRunning()) {
      await ctx.reply("⏳ A search is already running. Results will keep coming in.");
      return;
    }
    await ctx.reply("🔍 Running first search now... results appear one by one as found.");
    runSearch(undefined, onNew)
      .then(({ message }) => onSummary(`🔍 *[First Run]*\n${message}`))
      .catch((err) => onSummary(`❌ *[First Run]* Error: ${String(err)}`));
  });

  bot.command("help", async (ctx) => ctx.reply(
    `*Seeka Commands:*\n\n` +
    `/search — Full sweep now\n` +
    `/custom <query> — Custom search\n` +
    `/jobs — List jobs\n` +
    `/addjob — Add cron job\n` +
    `/removejob — Delete job\n` +
    `/togglejob — Pause/resume\n` +
    `/setschedule — Update timing\n` +
    `/runjob — Run job now\n\n` +
    `*Cron examples:*\n` +
    `\`0 */4 * * *\` = every 4h\n` +
    `\`0 9 * * *\` = 9 AM daily\n` +
    `\`0 9 * * 1\` = Mondays 9 AM`,
    { parse_mode: "Markdown" }
  ));

  // ─── /search ─────────────────────────────────────────────────────────────
  bot.command("search", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    if (isSearchRunning()) {
      return ctx.reply("⏳ A search is already running. Results will keep coming in.");
    }
    await ctx.reply("🔍 Starting full sweep... results will appear one by one as found.");
    runSearch(undefined, onNew)
      .then(({ message }) => onSummary(`📊 *Search complete*\n${message}`))
      .catch((err) => onSummary(`❌ Search failed: ${err}`));
  });

  // ─── /custom ─────────────────────────────────────────────────────────────
  bot.command("custom", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const query = ctx.match?.trim();
    if (query) {
      await executeCustomSearch(ctx, query, onNew, onSummary);
    } else {
      userState.set(ctx.from!.id, { step: "awaiting_search_query" });
      await ctx.reply("📝 What to search for?\n\n_Example: AI hackathon prize over $10k_", {
        parse_mode: "Markdown",
      });
    }
  });

  // ─── /jobs ───────────────────────────────────────────────────────────────
  bot.command("jobs", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const jobs = listJobs();
    if (!jobs.length) return ctx.reply("No jobs yet. Use /addjob.");
    const list = jobs.map((j, i) =>
      `${i + 1}. ${j.enabled ? "✅" : "⏸"} *${j.name}*\n` +
      `   \`${j.schedule}\` — _${j.query || "Full sweep"}_\n` +
      `   Last run: ${j.lastRun ? new Date(j.lastRun).toLocaleString() : "Never"}`
    ).join("\n\n");
    await ctx.reply(`*📋 Jobs (${jobs.length}):*\n\n${list}`, { parse_mode: "Markdown" });
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
    if (!jobs.length) return ctx.reply("No jobs configured.");
    const kb = new InlineKeyboard();
    jobs.forEach((j) => kb.text(`${j.enabled ? "⏸" : "▶️"} ${j.name}`, `toggle:${j.id}`).row());
    kb.text("Cancel", "cancel");
    await ctx.reply("Toggle which job?", { reply_markup: kb });
  });

  // ─── /setschedule ────────────────────────────────────────────────────────
  bot.command("setschedule", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const jobs = listJobs();
    if (!jobs.length) return ctx.reply("No jobs configured.");
    const kb = new InlineKeyboard();
    jobs.forEach((j) => kb.text(`⏰ ${j.name} (${j.schedule})`, `setsched:${j.id}`).row());
    kb.text("Cancel", "cancel");
    await ctx.reply("Update schedule for which job?", { reply_markup: kb });
  });

  // ─── /runjob ─────────────────────────────────────────────────────────────
  bot.command("runjob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    const jobs = listJobs();
    if (!jobs.length) return ctx.reply("No jobs configured.");
    const kb = new InlineKeyboard();
    jobs.forEach((j) => kb.text(`▶️ ${j.name}`, `runnow:${j.id}`).row());
    kb.text("Cancel", "cancel");
    await ctx.reply("Run which job now?", { reply_markup: kb });
  });

  // ─── Callback queries ─────────────────────────────────────────────────────
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
      const job = await toggleJob(data.slice(7), onNew, onSummary);
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
      await ctx.editMessageText(`▶️ Running *${job?.name}*... results incoming`, { parse_mode: "Markdown" });
      await runJobNow(data.slice(7), onNew, onSummary);
    }
  });

  // ─── Text state machine ───────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.from!.id;
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    const state = userState.get(userId) ?? { step: "idle" };

    if (state.step === "awaiting_search_query") {
      userState.set(userId, { step: "idle" });
      await executeCustomSearch(ctx, text, onNew, onSummary);
      return;
    }
    if (state.step === "add_job_name") {
      userState.set(userId, { step: "add_job_schedule", name: text });
      await ctx.reply(
        `✅ Name: *${text}*\n\nStep 2/3: Enter cron schedule:\n\`0 */4 * * *\` = every 4h\n\`0 9 * * *\` = 9 AM daily`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (state.step === "add_job_schedule") {
      if (!isValidCron(text)) return ctx.reply("❌ Invalid cron. Try again.");
      userState.set(userId, { step: "add_job_query", name: state.name, schedule: text });
      await ctx.reply(`✅ Schedule: \`${text}\`\n\nStep 3/3: Search query? (type \`all\` for full sweep)`, {
        parse_mode: "Markdown",
      });
      return;
    }
    if (state.step === "add_job_query") {
      const query = text.toLowerCase() === "all" ? "" : text;
      userState.set(userId, { step: "idle" });
      const newJob = await addJob({ name: state.name, schedule: state.schedule, query, enabled: true }, onNew, onSummary);
      await ctx.reply(
        `✅ *Job Created!*\nName: ${newJob.name}\nSchedule: \`${newJob.schedule}\`\nQuery: _${newJob.query || "Full sweep"}_`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (state.step === "update_schedule_cron") {
      if (!isValidCron(text)) return ctx.reply("❌ Invalid cron. Try again.");
      const job = await updateJobSchedule(state.jobId, text, onNew, onSummary);
      userState.set(userId, { step: "idle" });
      await ctx.reply(job ? `✅ Updated *${job.name}*: \`${text}\`` : "❌ Failed.", { parse_mode: "Markdown" });
      return;
    }
  });

  return bot;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function executeCustomSearch(
  ctx: Context,
  query: string,
  onNew: (h: Hackathon) => void,
  onSummary: (msg: string) => void
) {
  await ctx.reply(`🔍 Searching: *${query}*\n\nResults appear one by one...`, { parse_mode: "Markdown" });
  runSearch(query, onNew)
    .then(({ message }) => onSummary(`📊 *Done*\n${message}`))
    .catch((err) => onSummary(`❌ Error: ${err}`));
}

function isValidCron(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5;
}
