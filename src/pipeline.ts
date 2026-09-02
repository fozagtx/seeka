// ─── src/pipeline.ts ──────────────────────────────────────────────────────────
// Orchestrates: Exa search → Firecrawl scrape → Notion push → Telegram notify

import { searchHackathons, searchByCustomQuery } from "./searcher.js";
import { scrapeHackathonDetails } from "./scraper.js";
import { pushToNotion } from "./notion.js";
import type { Hackathon } from "./types.js";

export interface PipelineResult {
  found: number;
  pushed: number;
  skipped: number;
  hackathons: Hackathon[];
  message: string;
}

let running = false;

export function isSearchRunning(): boolean {
  return running;
}

// onNew: called for each NEW hackathon pushed to Notion
export async function runSearch(
  customQuery?: string,
  onNew?: (h: Hackathon) => void | Promise<void>
): Promise<PipelineResult> {
  if (running) {
    return {
      found: 0,
      pushed: 0,
      skipped: 0,
      hackathons: [],
      message: "⏳ A search is already running. Results will keep coming in.",
    };
  }
  running = true;
  try {
    return await executeSearch(customQuery, onNew);
  } finally {
    running = false;
  }
}

async function executeSearch(
  customQuery?: string,
  onNew?: (h: Hackathon) => void | Promise<void>
): Promise<PipelineResult> {
  console.log(`[Pipeline] Starting search${customQuery ? ` for: "${customQuery}"` : " (full sweep)"}`);

  // Step 1: Search with Exa
  const searchResults = customQuery
    ? await searchByCustomQuery(customQuery)
    : await searchHackathons();

  console.log(`[Pipeline] Found ${searchResults.length} raw results from Exa`);

  if (searchResults.length === 0) {
    return { found: 0, pushed: 0, skipped: 0, hackathons: [], message: "No results found." };
  }

  // Step 2: Filter to likely hackathon pages
  const filtered = searchResults.filter((r) =>
    isLikelyHackathon(r.title + " " + r.url + " " + r.text)
  );
  console.log(`[Pipeline] Filtered to ${filtered.length} likely hackathon results`);

  // Step 3: Scrape details with Firecrawl
  const hackathons: Hackathon[] = [];
  for (const result of filtered.slice(0, 25)) {
    const h = await scrapeHackathonDetails(result);
    if (h) hackathons.push(h);
    await sleep(500);
  }

  console.log(`[Pipeline] Scraped ${hackathons.length} hackathons`);

  // Step 4: Push to Notion and notify per new entry
  let pushed = 0;
  let skipped = 0;

  for (const h of hackathons) {
    const id = await pushToNotion(h);
    if (id) {
      pushed++;
      if (onNew) await onNew(h);
    } else {
      skipped++;
    }
    await sleep(350);
  }

  const message =
    pushed > 0
      ? `✅ Found *${hackathons.length}* events → sent *${pushed}* new to Notion (${skipped} already tracked)`
      : `ℹ️ Found *${hackathons.length}* events — all ${skipped} already in Notion`;

  return { found: hackathons.length, pushed, skipped, hackathons, message };
}

function isLikelyHackathon(text: string): boolean {
  const t = text.toLowerCase();
  return [
    "hackathon", "competition", "contest", "challenge", "bounty",
    "prize", "submission", "deadline", "apply now", "register",
    "devpost", "devfolio", "hackerearth", "mlh", "lablab",
  ].some((k) => t.includes(k));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
