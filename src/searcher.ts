// ─── src/searcher.ts ──────────────────────────────────────────────────────────
// Exa-powered hackathon/contest search across web + X/Twitter

import Exa from "exa-js";
import type { SearchResult } from "./types.js";

const exa = new Exa(process.env.EXA_API_KEY!);

// Core search queries that rotate through different angles
const BASE_QUERIES = [
  "hackathon 2026 registration open prize",
  "coding competition 2026 open submission",
  "developer contest 2026 cash prize",
  "startup competition 2026 apply now",
  "AI hackathon 2026",
  "blockchain hackathon 2026",
  "web3 hackathon 2026 prize pool",
  "fintech competition 2026",
  "open source hackathon 2026",
  "design competition 2026 prize",
];

// Twitter/X specific queries
const X_QUERIES = [
  "hackathon registration open 2026",
  "coding competition deadline 2026",
  "developer challenge prize 2026",
  "startup pitch competition 2026",
];

export async function searchHackathons(
  customQuery?: string
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  const queries = customQuery ? [customQuery] : BASE_QUERIES;

  // Search the general web
  for (const query of queries.slice(0, customQuery ? 1 : 5)) {
    try {
      const res = await exa.searchAndContents(query, {
        type: "neural",
        numResults: 10,
        includeDomains: [
          "devpost.com",
          "hackerearth.com",
          "devfolio.co",
          "mlh.io",
          "challengerocket.com",
          "topcoder.com",
          "kaggle.com",
          "lablab.ai",
          "unstop.com",
          "hackaday.io",
          "eventbrite.com",
          "lu.ma",
          "devdynamics.ai",
        ],
        text: { maxCharacters: 2000 },
        startPublishedDate: getDateMonthsAgo(1),
      });

      for (const item of res.results as any[]) {
        results.push({
          title: item.title || "",
          url: item.url,
          text: item.text || "",
          publishedDate: item.publishedDate || undefined,
          author: item.author || undefined,
        });
      }
    } catch (err) {
      console.error(`[Exa web search] Error for query "${query}":`, err);
    }
  }

  // Search X/Twitter
  for (const xQuery of X_QUERIES.slice(0, customQuery ? 0 : 3)) {
    try {
      const res = await exa.searchAndContents(xQuery, {
        type: "neural",
        numResults: 8,
        includeDomains: ["twitter.com", "x.com"],
        text: { maxCharacters: 1000 },
        startPublishedDate: getDateMonthsAgo(1),
      });

      for (const item of res.results as any[]) {
        results.push({
          title: item.title || "",
          url: item.url,
          text: item.text || "",
          publishedDate: item.publishedDate || undefined,
          author: item.author || undefined,
        });
      }
    } catch (err) {
      console.error(`[Exa X search] Error for query "${xQuery}":`, err);
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

export async function searchByCustomQuery(
  query: string,
  domains?: string[]
): Promise<SearchResult[]> {
  try {
    const opts: any = {
      type: "neural",
      numResults: 15,
      text: { maxCharacters: 3000 },
      startPublishedDate: getDateMonthsAgo(3),
    };
    if (domains && domains.length > 0) {
      opts.includeDomains = domains;
    }
    const res = await exa.searchAndContents(query, opts);
    return (res.results as any[]).map((item) => ({
      title: item.title || "",
      url: item.url,
      text: item.text || "",
      publishedDate: item.publishedDate || undefined,
      author: item.author || undefined,
    }));
  } catch (err) {
    console.error(`[Exa custom search] Error:`, err);
    return [];
  }
}

function getDateMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split("T")[0];
}
