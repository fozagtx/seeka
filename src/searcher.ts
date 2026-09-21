// ─── src/searcher.ts ──────────────────────────────────────────────────────────
// Exa-powered hackathon search using AGENT MODE (answer API) + neural search

import Exa from "exa-js";
import type { SearchResult } from "./types.js";
import { searchX, isXConfigured, X_SWEEP_QUERIES } from "./xsearch.js";

const exa = new Exa(process.env.EXA_API_KEY!);

// ─── Agent mode queries (Exa answer API — deep agentic research) ──────────────
const AGENT_QUERIES = [
  "Find all hackathons, coding competitions, and developer contests open for registration in 2026. Include name, organizer, prize pool, deadline, and registration link.",
  "What are the best AI and machine learning hackathons happening in 2026 with prizes? List them with deadlines and links.",
  "Find open web3, blockchain, and crypto hackathons in 2026 with prize pools. Include organizer and registration details.",
  "List fintech, healthtech, and climate tech competitions and hackathons open in 2026. Include deadlines and prize info.",
];

// ─── Neural search queries (broader net) ─────────────────────────────────────
const NEURAL_QUERIES = [
  "hackathon 2026 registration open prize deadline apply",
  "coding competition 2026 open submission cash prize",
  "developer challenge contest 2026 prize pool apply now",
  "AI hackathon 2026 open registration",
  "blockchain web3 hackathon 2026",
  "startup competition pitch 2026",
];

// ─── X/Twitter specific ───────────────────────────────────────────────────────
const X_OPPORTUNITY_QUERY = `(hackathon OR buildathon OR contest OR competition OR challenge OR grant) (deadline OR "submissions close" OR "registration closes") ("Sep 2026" OR "September 2026" OR "Oct 2026" OR "October 2026" OR "Nov 2026" OR "November 2026" OR "Dec 2026" OR "December 2026" OR "2027") -2025 -2024 -ended -closed -expired -past`;

const TWITTER_QUERIES = [
  X_OPPORTUNITY_QUERY,
  "hackathon 2026 registration open deadline prize",
  "buildathon contest competition challenge 2026 2027 submissions close",
  "grant fellowship funding award 2026 2027 applications close",
];

export interface SearchOutput {
  results: SearchResult[];
  agentSummaries: string[];
}

export async function searchHackathons(
  onStatus: (msg: string) => void,
  customQuery?: string
): Promise<SearchOutput> {
  const allResults: SearchResult[] = [];
  const agentSummaries: string[] = [];

  if (customQuery) {
    // Single custom query — use both agent + neural
    onStatus(`🤖 Running agent research for: _${customQuery}_`);
    const agentResult = await runAgentQuery(customQuery);
    if (agentResult.summary) agentSummaries.push(agentResult.summary);
    allResults.push(...agentResult.results);

    onStatus(`🔍 Running neural search...`);
    const neural = await runNeuralQuery(customQuery);
    allResults.push(...neural);

    onStatus(`🐦 Scanning X/Twitter with FireScraper-ready targets...`);
    const twitter = await runTwitterSearches([customQuery, `${customQuery} ${X_OPPORTUNITY_QUERY}`]);
    allResults.push(...twitter);

    if (isXConfigured()) {
      onStatus(`🐦 Querying the X API for: _${customQuery}_`);
      const xResults = await searchX([buildCustomXQuery(customQuery)], onStatus);
      allResults.push(...xResults);
    }
  } else {
    // Full sweep — agent mode first
    onStatus(`🤖 *Phase 1/4:* Agent research (deep mode)...`);
    for (const q of AGENT_QUERIES.slice(0, 2)) {
      const agentResult = await runAgentQuery(q);
      if (agentResult.summary) agentSummaries.push(agentResult.summary);
      allResults.push(...agentResult.results);
      await sleep(500);
    }

    // Neural search across hackathon platforms
    onStatus(`🔍 *Phase 2/4:* Neural search across platforms...`);
    for (const q of NEURAL_QUERIES.slice(0, 4)) {
      const results = await runNeuralQuery(q, [
        "devpost.com", "hackerearth.com", "devfolio.co", "mlh.io",
        "lablab.ai", "challengerocket.com", "unstop.com", "kaggle.com",
        "topcoder.com", "hackaday.io", "lu.ma", "eventbrite.com",
      ]);
      allResults.push(...results);
      await sleep(300);
    }

    // X / Twitter search
    onStatus(`🐦 *Phase 3/4:* Scanning X/Twitter via Exa...`);
    const twitter = await runTwitterSearches(TWITTER_QUERIES);
    allResults.push(...twitter);

    // X API recent search (since_id cursor — only posts newer than last run)
    if (isXConfigured()) {
      onStatus(`🐦 *Phase 4/4:* X API recent search (new posts since last run)...`);
      const xResults = await searchX(X_SWEEP_QUERIES, onStatus);
      allResults.push(...xResults);
    } else {
      onStatus(`ℹ️ X API skipped — set X\\_BEARER\\_TOKEN to enable.`);
    }
  }

  // Deduplicate by URL — X API results win because they carry images + post links
  const byUrl = new Map<string, SearchResult>();
  for (const r of allResults) {
    const existing = byUrl.get(r.url);
    if (!existing) { byUrl.set(r.url, r); continue; }
    if (r.origin === "x" && existing.origin !== "x") byUrl.set(r.url, r);
  }
  const deduped = Array.from(byUrl.values());

  return { results: deduped, agentSummaries };
}

function buildCustomXQuery(customQuery: string): string {
  // Reduce a free-text query to its keywords so it stays a valid X operator query
  const keywords = customQuery
    .replace(/[^\w\s$#]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);
  const core = keywords.length > 0 ? keywords.join(" ") : "hackathon";
  return `${core} (hackathon OR competition OR contest OR challenge) has:links -is:retweet lang:en`;
}

// ─── Exa Agent Mode (answer API) ─────────────────────────────────────────────
async function runAgentQuery(query: string): Promise<{ results: SearchResult[]; summary: string }> {
  try {
    const res = await (exa as any).answer(query, {
      text: true,
      highlights: { numSentences: 3, highlightsPerUrl: 2 },
    });

    const results: SearchResult[] = (res.sources || res.citations || []).map((s: any) => ({
      title: s.title || "",
      url: s.url || s.link || "",
      text: s.text || s.highlight || s.snippet || "",
      publishedDate: s.publishedDate || undefined,
      author: s.author || undefined,
    })).filter((r: SearchResult) => r.url);

    return { results, summary: res.answer || res.text || "" };
  } catch (err) {
    console.error(`[Exa Agent] Error:`, err);
    return { results: [], summary: "" };
  }
}

// ─── Neural search ────────────────────────────────────────────────────────────
async function runNeuralQuery(query: string, domains?: string[]): Promise<SearchResult[]> {
  try {
    const opts: any = {
      type: "neural",
      numResults: 10,
      text: { maxCharacters: 2000 },
      startPublishedDate: getDateMonthsAgo(2),
    };
    if (domains?.length) opts.includeDomains = domains;

    const res = await exa.searchAndContents(query, opts);
    return (res.results as any[]).map((item) => ({
      title: item.title || "",
      url: item.url,
      text: item.text || "",
      publishedDate: item.publishedDate || undefined,
      author: item.author || undefined,
    }));
  } catch (err) {
    console.error(`[Exa Neural] Error:`, err);
    return [];
  }
}

// ─── X/Twitter search ─────────────────────────────────────────────────────────
async function runTwitterSearches(queries: string[]): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];

  for (const query of queries) {
    allResults.push(...await runSingleTwitterSearch(query, "neural"));
    allResults.push(...await runSingleTwitterSearch(query, "keyword"));
    await sleep(300);
  }

  const seen = new Set<string>();
  return allResults.filter((result) => {
    if (!isTwitterUrl(result.url)) return false;
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

async function runSingleTwitterSearch(query: string, type: "neural" | "keyword"): Promise<SearchResult[]> {
  try {
    const searchQuery = type === "keyword" ? `site:x.com OR site:twitter.com ${query}` : query;
    const res = await exa.searchAndContents(searchQuery, {
      type,
      numResults: type === "neural" ? 12 : 8,
      includeDomains: ["x.com", "twitter.com"],
      text: { maxCharacters: 1500 },
      startPublishedDate: getDateMonthsAgo(2),
    } as any);

    return (res.results as any[]).map((item) => ({
      title: item.title || "",
      url: item.url,
      text: item.text || "",
      publishedDate: item.publishedDate || undefined,
      author: item.author || undefined,
    }));
  } catch (err) {
    console.error(`[Exa X/${type}] Error:`, err);
    return [];
  }
}

function isTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

function getDateMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split("T")[0];
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
