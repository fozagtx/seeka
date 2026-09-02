// ─── src/pipeline.ts ──────────────────────────────────────────────────────────
// Resilient orchestration: Exa agent search → Firecrawl → Notion → Telegram

import { searchHackathons } from "./searcher.js";
import { scrapeHackathonDetails } from "./scraper.js";
import { pushToNotion } from "./notion.js";
import { formatTelegramMessage } from "./types.js";
import type { Hackathon } from "./types.js";

export interface PipelineCallbacks {
  onStatus: (msg: string) => Promise<void>;   // progress updates
  onNew: (h: Hackathon) => Promise<void>;     // each new hackathon found
  onSummary: (msg: string) => Promise<void>;  // final summary
}

export interface PipelineResult {
  found: number;
  pushed: number;
  skipped: number;
  failed: number;
  hackathons: Hackathon[];
}

export async function runSearch(
  customQuery: string | undefined,
  cb: PipelineCallbacks
): Promise<PipelineResult> {
  const label = customQuery ? `"${customQuery}"` : "full sweep";
  console.log(`[Pipeline] Starting: ${label}`);

  await cb.onStatus(`🔎 *Search started* — ${label}`);

  // ── Step 1: Exa search (agent + neural + X) ────────────────────────────────
  let rawResults: Awaited<ReturnType<typeof searchHackathons>>;
  try {
    rawResults = await searchHackathons(
      (msg) => cb.onStatus(msg).catch(() => {}),
      customQuery
    );
  } catch (err) {
    await cb.onSummary(`❌ Search failed at Exa stage: ${String(err)}`);
    return { found: 0, pushed: 0, skipped: 0, failed: 0, hackathons: [] };
  }

  const { results, agentSummaries } = rawResults;

  // If agent produced summaries, send them as context
  if (agentSummaries.length > 0) {
    const combined = agentSummaries.filter(Boolean).join("\n\n").slice(0, 1000);
    if (combined) {
      await cb.onStatus(`🤖 *Agent research summary:*\n\n${combined}`).catch(() => {});
    }
  }

  await cb.onStatus(`📡 Found *${results.length}* raw results — filtering & scraping...`);

  // ── Step 2: Filter to likely hackathon pages ───────────────────────────────
  const filtered = results.filter((r) => isLikelyHackathon(r.title + " " + r.url + " " + r.text));
  console.log(`[Pipeline] ${filtered.length}/${results.length} pass hackathon filter`);

  if (filtered.length === 0) {
    await cb.onSummary(`⚠️ Found ${results.length} results but none matched hackathon criteria.`);
    return { found: 0, pushed: 0, skipped: 0, failed: 0, hackathons: [] };
  }

  // ── Step 3: Firecrawl scrape (with retries) ────────────────────────────────
  const hackathons: Hackathon[] = [];
  const batch = filtered.slice(0, 20);
  let scrapeErrors = 0;

  for (let i = 0; i < batch.length; i++) {
    const result = batch[i];
    try {
      const h = await scrapeHackathonDetails(result);
      if (h) hackathons.push(h);
    } catch (err) {
      scrapeErrors++;
      console.error(`[Pipeline] Scrape error for ${result.url}:`, err);
    }

    // Progress every 5
    if ((i + 1) % 5 === 0 || i === batch.length - 1) {
      await cb.onStatus(`📄 Scraped *${i + 1}/${batch.length}*...`).catch(() => {});
    }
    await sleep(400);
  }

  console.log(`[Pipeline] Scraped ${hackathons.length} hackathons (${scrapeErrors} errors)`);

  if (hackathons.length === 0) {
    await cb.onSummary(`⚠️ Scraping returned no usable results. Try again or use /custom with a specific query.`);
    return { found: 0, pushed: 0, skipped: 0, failed: scrapeErrors, hackathons: [] };
  }

  // ── Step 4: Push to Notion + notify per new entry ─────────────────────────
  await cb.onStatus(`📋 Sending to Notion...`);
  let pushed = 0, skipped = 0, failed = 0;

  for (const h of hackathons) {
    try {
      const id = await pushToNotion(h);
      if (id) {
        pushed++;
        // Send individual formatted Telegram message immediately
        await cb.onNew(h).catch(() => {});
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      console.error(`[Pipeline] Notion push error for ${h.name}:`, err);
    }
    await sleep(300);
  }

  // ── Step 5: Final summary ──────────────────────────────────────────────────
  const notionUrl = `https://notion.so/${process.env.NOTION_DATABASE_ID?.replace(/-/g, "")}`;
  const summaryLines = [
    `✅ *Search Complete!*`,
    ``,
    `📊 *Stats:*`,
    `• Scanned: ${results.length} pages`,
    `• Matched: ${filtered.length} hackathon pages`,
    `• Scraped: ${hackathons.length} events`,
    `• 🆕 New → Notion: *${pushed}*`,
    `• ⏭ Already tracked: ${skipped}`,
    failed > 0 ? `• ❌ Errors: ${failed}` : null,
    ``,
    `🗂 [View in Notion](${notionUrl})`,
  ].filter((l) => l !== null).join("\n");

  await cb.onSummary(summaryLines);

  // ── Step 6: Notion snapshot — top 3 new ones ──────────────────────────────
  if (pushed > 0) {
    const newOnes = hackathons.filter((_, i) => i < pushed);
    const snapshot = newOnes
      .slice(0, 3)
      .map(
        (h, i) =>
          `*${i + 1}. ${h.name}*\n` +
          `   🏷 ${h.industry}${h.format ? ` · ${h.format}` : ""}\n` +
          `   🏆 ${h.prizePool || "Prize TBD"}\n` +
          `   ⏰ ${h.deadline || "Deadline TBD"}\n` +
          `   🔗 ${h.link}`
      )
      .join("\n\n");

    if (snapshot) {
      await cb.onStatus(
        `📸 *Notion snapshot — latest ${Math.min(pushed, 3)} added:*\n\n${snapshot}`
      ).catch(() => {});
    }
  }

  return { found: hackathons.length, pushed, skipped, failed, hackathons };
}

function isLikelyHackathon(text: string): boolean {
  const t = text.toLowerCase();
  return [
    "hackathon", "competition", "contest", "challenge", "bounty",
    "prize", "submission", "deadline", "apply now", "register",
    "devpost", "devfolio", "hackerearth", "mlh", "lablab",
    "hackfest", "buildathon", "sprint", "datathon",
  ].some((k) => t.includes(k));
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
