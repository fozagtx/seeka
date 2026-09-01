// ─── src/pipeline.ts ──────────────────────────────────────────────────────────
// Orchestrates: Exa search → Firecrawl scrape → Notion push

import { searchHackathons, searchByCustomQuery } from "./searcher.js";
import { scrapeHackathonDetails } from "./scraper.js";
import { pushBatchToNotion } from "./notion.js";
import type { Hackathon } from "./types.js";

export interface PipelineResult {
  found: number;
  pushed: number;
  skipped: number;
  hackathons: Hackathon[];
  message: string;
}

export async function runSearch(customQuery?: string): Promise<PipelineResult> {
  console.log(`[Pipeline] Starting search${customQuery ? ` for: "${customQuery}"` : " (full sweep)"}`);

  // Step 1: Search with Exa
  const searchResults = customQuery
    ? await searchByCustomQuery(customQuery)
    : await searchHackathons();

  console.log(`[Pipeline] Found ${searchResults.length} raw results from Exa`);

  if (searchResults.length === 0) {
    return {
      found: 0,
      pushed: 0,
      skipped: 0,
      hackathons: [],
      message: "No results found from search.",
    };
  }

  // Step 2: Filter to likely hackathon/competition pages
  const filtered = searchResults.filter((r) => isLikelyHackathon(r.title + " " + r.url + " " + r.text));
  console.log(`[Pipeline] Filtered to ${filtered.length} likely hackathon results`);

  // Step 3: Scrape details with Firecrawl (batch, max 20 at a time)
  const hackathons: Hackathon[] = [];
  const batch = filtered.slice(0, 25);

  for (const result of batch) {
    const h = await scrapeHackathonDetails(result);
    if (h) hackathons.push(h);
    // Rate limit Firecrawl
    await sleep(500);
  }

  console.log(`[Pipeline] Scraped ${hackathons.length} hackathons`);

  // Step 4: Push to Notion
  const { pushed, skipped } = await pushBatchToNotion(hackathons);

  const message =
    pushed > 0
      ? `✅ Found *${hackathons.length}* events → sent *${pushed}* new to Notion (${skipped} already tracked)`
      : `ℹ️ Found *${hackathons.length}* events but all ${skipped} were already in Notion`;

  return {
    found: hackathons.length,
    pushed,
    skipped,
    hackathons,
    message,
  };
}

function isLikelyHackathon(text: string): boolean {
  const t = text.toLowerCase();
  const keywords = [
    "hackathon", "competition", "contest", "challenge", "bounty",
    "prize", "submission", "deadline", "apply now", "register",
    "devpost", "devfolio", "hackerearth", "mlh", "lablab",
  ];
  return keywords.some((k) => t.includes(k));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
