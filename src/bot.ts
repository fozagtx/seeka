// ─── src/bot.ts ───────────────────────────────────────────────────────────────
// Telegram bot with full command interface

import { Bot, InlineKeyboard, type Context } from "grammy";
import { runSearch } from "./pipeline.js";
import {
  listJobs,
  addJob,
  removeJob,
  toggleJob,
  updateJobSchedule,
  runJobNow,
  getJob,
} from "./jobs.js";
import type { CronJob } from "./types.js";

// Conversation state for multi-step interactions
type ConvState =
  | { step: "idle" }
  | { step: "awaiting_search_query" }
  | { step: "add_job_name" }
  | { step: "add_job_schedule"; name: string }
  | { step: "add_job_query"; name: string; schedule: string }
  | { step: "update_schedule_id" }
  | { step: "update_schedule_cron"; jobId: string };

const userState = new Map<number, ConvState>();

export function createBot(adminChatId: string): Bot {
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

  const isAdmin = (ctx: Context) =>
    String(ctx.from?.id) === adminChatId || String(ctx.chat?.id) === adminChatId;

  // Callback for cron job results → send to admin
  const sendToAdmin = async (msg: string) => {
    try {
      await bot.api.sendMessage(adminChatId, msg, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[Bot] Error sending cron result to admin:", err);
    }
  };

  // ─── /start ──────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `👋 *Seeka — Hackathon Tracker Bot*\n\n` +
        `I find hackathons, competitions & contests from across the web and send them to your Notion database.\n\n` +
        `*Commands:*\n` +
        `🔍 /search — Run a one-time search now\n` +
        `📝 /custom — Search with your own query\n` +
        `📋 /jobs — View all cron jobs\n` +
        `➕ /addjob — Add a new scheduled search\n` +
        `🗑️ /removejob — Remove a cron job\n` +
        `🔁 /togglejob — Enable/disable a cron job\n` +
        `⏰ /setschedule — Change a job's cron schedule\n` +
        `▶️ /runjob — Run a specific job right now\n` +
        `ℹ️ /help — Show this message`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("help", async (ctx) => ctx.reply(
    `*Seeka Commands:*\n\n` +
    `/search — Full sweep search (all platforms)\n` +
    `/custom — Search with custom query\n` +
    `/jobs — List all scheduled jobs\n` +
    `/addjob — Add new cron job\n` +
    `/removejob — Remove a cron job\n` +
    `/togglejob — Pause/resume a cron job\n` +
    `/setschedule — Update a job's schedule\n` +
    `/runjob — Run a job manually right now\n\n` +
    `*Cron format examples:*\n` +
    `\`0 9 * * *\` → Every day at 9 AM\n` +
    `\`0 */6 * * *\` → Every 6 hours\n` +
    `\`0 9 * * 1\` → Every Monday at 9 AM\n` +
    `\`*/30 * * * *\` → Every 30 minutes`,
    { parse_mode: "Markdown" }
  ));

  // ─── /search — Full sweep ─────────────────────────────────────────────────
  bot.command("search", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const msg = await ctx.reply("🔍 Starting full hackathon sweep... this may take 1-2 minutes.", {
      parse_mode: "Markdown",
    });

    runSearch()
      .then(async ({ found, pushed, skipped, hackathons, message }) => {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, message, {
          parse_mode: "Markdown",
        });

        // Send a preview of top 5
        if (hackathons.length > 0) {
          const preview = hackathons
            .slice(0, 5)
            .map(
              (h, i) =>
                `${i + 1}. *${h.name}*\n   🏷 ${h.industry}\n   🏆 ${h.prizePool || "Unknown"}\n   ⏰ ${h.deadline || "TBD"}\n   🔗 ${h.link}`
            )
            .join("\n\n");

          await ctx.reply(`*Top Results Preview:*\n\n${preview}`, {
            parse_mode: "Markdown",
            link_preview_options: { is_disabled: true },
          });
        }
      })
      .catch(async (err) => {
        await ctx.api.editMessageText(
          ctx.chat.id,
          msg.message_id,
          `❌ Search failed: ${String(err)}`,
          { parse_mode: "Markdown" }
        );
      });
  });

  // ─── /custom — Custom query search ───────────────────────────────────────
  bot.command("custom", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const query = ctx.match?.trim();
    if (query) {
      // Query provided inline: /custom AI hackathon 2026
      await executeCustomSearch(ctx, query);
    } else {
      userState.set(ctx.from!.id, { step: "awaiting_search_query" });
      await ctx.reply("📝 What do you want to search for?\n\n_Example: AI hackathon with prize over $10k_", {
        parse_mode: "Markdown",
      });
    }
  });

  // ─── /jobs — List cron jobs ───────────────────────────────────────────────
  bot.command("jobs", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const jobs = listJobs();
    if (jobs.length === 0) {
      return ctx.reply("No cron jobs configured yet. Use /addjob to add one.");
    }

    const list = jobs
      .map(
        (j, i) =>
          `${i + 1}. ${j.enabled ? "✅" : "⏸"} *${j.name}*\n` +
          `   ID: \`${j.id}\`\n` +
          `   ⏰ Schedule: \`${j.schedule}\`\n` +
          `   🔍 Query: _${j.query || "Full sweep"}_\n` +
          `   🕐 Last run: ${j.lastRun ? new Date(j.lastRun).toLocaleString() : "Never"}`
      )
      .join("\n\n");

    await ctx.reply(`*📋 Cron Jobs (${jobs.length}):*\n\n${list}`, {
      parse_mode: "Markdown",
    });
  });

  // ─── /addjob — Add new cron job ──────────────────────────────────────────
  bot.command("addjob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");
    userState.set(ctx.from!.id, { step: "add_job_name" });
    await ctx.reply("➕ *Add New Cron Job*\n\nStep 1/3: What should I call this job?\n_Example: Daily Web3 Search_", {
      parse_mode: "Markdown",
    });
  });

  // ─── /removejob — Remove a job ───────────────────────────────────────────
  bot.command("removejob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const jobs = listJobs();
    if (jobs.length === 0) return ctx.reply("No jobs to remove.");

    const kb = new InlineKeyboard();
    for (const job of jobs) {
      kb.text(`🗑️ ${job.name}`, `remove:${job.id}`).row();
    }
    kb.text("Cancel", "cancel");

    await ctx.reply("Which job do you want to remove?", {
      reply_markup: kb,
    });
  });

  // ─── /togglejob — Pause/resume a job ─────────────────────────────────────
  bot.command("togglejob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const jobs = listJobs();
    if (jobs.length === 0) return ctx.reply("No jobs configured.");

    const kb = new InlineKeyboard();
    for (const job of jobs) {
      const icon = job.enabled ? "⏸" : "▶️";
      kb.text(`${icon} ${job.name}`, `toggle:${job.id}`).row();
    }
    kb.text("Cancel", "cancel");

    await ctx.reply("Which job do you want to toggle?", { reply_markup: kb });
  });

  // ─── /setschedule — Update job schedule ──────────────────────────────────
  bot.command("setschedule", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const jobs = listJobs();
    if (jobs.length === 0) return ctx.reply("No jobs configured.");

    const kb = new InlineKeyboard();
    for (const job of jobs) {
      kb.text(`⏰ ${job.name} (${job.schedule})`, `setsched:${job.id}`).row();
    }
    kb.text("Cancel", "cancel");

    await ctx.reply("Which job's schedule do you want to update?", {
      reply_markup: kb,
    });
  });

  // ─── /runjob — Run a job now ──────────────────────────────────────────────
  bot.command("runjob", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Access denied.");

    const jobs = listJobs();
    if (jobs.length === 0) return ctx.reply("No jobs configured.");

    const kb = new InlineKeyboard();
    for (const job of jobs) {
      kb.text(`▶️ ${job.name}`, `runnow:${job.id}`).row();
    }
    kb.text("Cancel", "cancel");

    await ctx.reply("Which job do you want to run now?", { reply_markup: kb });
  });

  // ─── Callback query handlers ──────────────────────────────────────────────
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (data === "cancel") {
      return ctx.editMessageText("Cancelled.");
    }

    if (data.startsWith("remove:")) {
      const jobId = data.slice(7);
      const job = getJob(jobId);
      const removed = await removeJob(jobId);
      if (removed) {
        await ctx.editMessageText(`🗑️ Removed job: *${job?.name}*`, { parse_mode: "Markdown" });
      } else {
        await ctx.editMessageText("❌ Job not found.");
      }
    }

    if (data.startsWith("toggle:")) {
      const jobId = data.slice(7);
      const job = await toggleJob(jobId, sendToAdmin);
      if (job) {
        const status = job.enabled ? "✅ Enabled" : "⏸ Paused";
        await ctx.editMessageText(`${status}: *${job.name}*`, { parse_mode: "Markdown" });
      } else {
        await ctx.editMessageText("❌ Job not found.");
      }
    }

    if (data.startsWith("setsched:")) {
      const jobId = data.slice(9);
      const job = getJob(jobId);
      userState.set(ctx.from!.id, { step: "update_schedule_cron", jobId });
      await ctx.editMessageText(
        `⏰ *Update schedule for: ${job?.name}*\n\nCurrent: \`${job?.schedule}\`\n\nSend the new cron expression:\n_Example: \`0 */6 * * *\` (every 6 hours)_`,
        { parse_mode: "Markdown" }
      );
    }

    if (data.startsWith("runnow:")) {
      const jobId = data.slice(7);
      const job = getJob(jobId);
      await ctx.editMessageText(`▶️ Running *${job?.name}*...`, { parse_mode: "Markdown" });
      const ok = await runJobNow(jobId, sendToAdmin);
      if (!ok) await ctx.editMessageText("❌ Job not found.");
    }
  });

  // ─── Text message handler (state machine) ─────────────────────────────────
  bot.on("message:text", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.from!.id;
    const text = ctx.message.text.trim();
    const state = userState.get(userId) ?? { step: "idle" };

    if (state.step === "awaiting_search_query") {
      userState.set(userId, { step: "idle" });
      await executeCustomSearch(ctx, text);
      return;
    }

    if (state.step === "add_job_name") {
      userState.set(userId, { step: "add_job_schedule", name: text });
      await ctx.reply(
        `✅ Job name: *${text}*\n\nStep 2/3: Enter the cron schedule:\n\`0 9 * * *\` = 9 AM daily\n\`0 */6 * * *\` = every 6h\n\`0 9 * * 1\` = Mondays 9 AM`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (state.step === "add_job_schedule") {
      if (!isValidCron(text)) {
        return ctx.reply("❌ Invalid cron expression. Try again or use /help for examples.");
      }
      userState.set(userId, { step: "add_job_query", name: state.name, schedule: text });
      await ctx.reply(
        `✅ Schedule: \`${text}\`\n\nStep 3/3: What should this job search for?\n_Type \`all\` for a full sweep_`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (state.step === "add_job_query") {
      const query = text.toLowerCase() === "all" ? "" : text;
      userState.set(userId, { step: "idle" });
      const newJob = await addJob(
        { name: state.name, schedule: state.schedule, query, enabled: true },
        sendToAdmin
      );
      await ctx.reply(
        `✅ *Job Created!*\n\nName: ${newJob.name}\nSchedule: \`${newJob.schedule}\`\nQuery: _${newJob.query || "Full sweep"}_\nID: \`${newJob.id}\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (state.step === "update_schedule_cron") {
      if (!isValidCron(text)) {
        return ctx.reply("❌ Invalid cron expression. Try again.");
      }
      const job = await updateJobSchedule(state.jobId, text, sendToAdmin);
      userState.set(userId, { step: "idle" });
      if (job) {
        await ctx.reply(`✅ Schedule updated for *${job.name}*: \`${text}\``, {
          parse_mode: "Markdown",
        });
      } else {
        await ctx.reply("❌ Failed to update schedule.");
      }
      return;
    }
  });

  return bot;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function executeCustomSearch(ctx: Context, query: string) {
  const msg = await ctx.reply(`🔍 Searching for: *${query}*...`, {
    parse_mode: "Markdown",
  });

  runSearch(query)
    .then(async ({ found, pushed, skipped, hackathons, message }) => {
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, message, {
        parse_mode: "Markdown",
      });

      if (hackathons.length > 0) {
        const preview = hackathons
          .slice(0, 5)
          .map(
            (h, i) =>
              `${i + 1}. *${h.name}*\n   🏷 ${h.industry}\n   🏆 ${h.prizePool || "Unknown"}\n   ⏰ ${h.deadline || "TBD"}\n   🔗 ${h.link}`
          )
          .join("\n\n");

        await ctx.reply(`*Top Results:*\n\n${preview}`, {
          parse_mode: "Markdown",
          link_preview_options: { is_disabled: true },
        });
      }
    })
    .catch(async (err) => {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msg.message_id,
        `❌ Search failed: ${String(err)}`,
        { parse_mode: "Markdown" }
      );
    });
}

function isValidCron(expr: string): boolean {
  // Basic validation: 5 space-separated fields
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}
