// ─── src/searcher.ts ──────────────────────────────────────────────────────────
// Exa-powered hackathon search using AGENT MODE (answer API) + neural search

import Exa from "exa-js";
import type { SearchResult } from "./types.js";

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
const TWITTER_QUERIES = [
  "hackathon 2026 registration open",
  "coding competition 2026 prize apply",
  "developer contest 2026 deadline",
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
  } else {
    // Full sweep — agent mode first
    onStatus(`🤖 *Phase 1/3:* Agent research (deep mode)...`);
    for (const q of AGENT_QUERIES.slice(0, 2)) {
      const agentResult = await runAgentQuery(q);
      if (agentResult.summary) agentSummaries.push(agentResult.summary);
      allResults.push(...agentResult.results);
      await sleep(500);
    }

    // Neural search across hackathon platforms
    onStatus(`🔍 *Phase 2/3:* Neural search across platforms...`);
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
    onStatus(`🐦 *Phase 3/3:* Scanning X/Twitter...`);
    for (const q of TWITTER_QUERIES) {
      const results = await runTwitterSearch(q);
      allResults.push(...results);
      await sleep(300);
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const deduped = allResults.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  return { results: deduped, agentSummaries };
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
async function runTwitterSearch(query: string): Promise<SearchResult[]> {
  try {
    // Try with X/Twitter domains
    const res = await exa.searchAndContents(query, {
      type: "neural",
      numResults: 8,
      includeDomains: ["twitter.com", "x.com"],
      text: { maxCharacters: 800 },
      startPublishedDate: getDateMonthsAgo(1),
    } as any);
    return (res.results as any[]).map((item) => ({
      title: item.title || "",
      url: item.url,
      text: item.text || "",
      publishedDate: item.publishedDate || undefined,
    }));
  } catch {
    // Fallback — keyword search mentioning Twitter
    try {
      const res = await exa.searchAndContents(`site:twitter.com OR site:x.com ${query}`, {
        type: "keyword",
        numResults: 5,
        text: { maxCharacters: 800 },
      } as any);
      return (res.results as any[]).map((item) => ({
        title: item.title || "",
        url: item.url,
        text: item.text || "",
      }));
    } catch {
      return [];
    }
  }
}

function getDateMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split("T")[0];
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
