// ─── src/scraper.ts ───────────────────────────────────────────────────────────
// Firecrawl-powered deep scraping of hackathon detail pages

import type { SearchResult, Hackathon, Industry } from "./types.js";
import { INDUSTRIES } from "./types.js";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v1";

interface FirecrawlResult {
  success: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      ogDescription?: string;
      ogTitle?: string;
    };
  };
}

export async function scrapeHackathonDetails(
  result: SearchResult
): Promise<Hackathon | null> {
  try {
    const response = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: result.url,
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 2000,
        timeout: 20000,
      }),
    });

    if (!response.ok) {
      console.error(`[Firecrawl] HTTP ${response.status} for ${result.url}`);
      return parseFromSearchResult(result);
    }

    const data: FirecrawlResult = await response.json();
    if (!data.success || !data.data) {
      return parseFromSearchResult(result);
    }

    const md = data.data.markdown || "";
    const meta = data.data.metadata || {};

    const name =
      meta.ogTitle || meta.title || result.title || "Unnamed Hackathon";
    const description =
      extractDescription(md) ||
      meta.ogDescription ||
      meta.description ||
      result.text.slice(0, 500);

    return {
      name: cleanText(name),
      description: cleanText(description),
      startDate: extractStartDate(md + " " + result.text),
      deadline: extractDeadline(md + " " + result.text),
      prizePool: extractPrizePool(md + " " + result.text),
      industry: classifyIndustry(name + " " + description),
      link: result.url,
      source: extractSource(result.url),
      foundAt: new Date().toISOString(),
      tags: extractTags(name + " " + description),
    };
  } catch (err) {
    console.error(`[Firecrawl] Error scraping ${result.url}:`, err);
    return parseFromSearchResult(result);
  }
}

// Fallback: parse from Exa search result text alone
function parseFromSearchResult(result: SearchResult): Hackathon {
  const combined = result.title + " " + result.text;
  return {
    name: cleanText(result.title || "Unnamed Event"),
    description: cleanText(result.text.slice(0, 600)),
    startDate: extractStartDate(combined),
    deadline: extractDeadline(combined),
    prizePool: extractPrizePool(combined),
    industry: classifyIndustry(combined),
    link: result.url,
    source: extractSource(result.url),
    foundAt: new Date().toISOString(),
    tags: extractTags(combined),
  };
}

// ─── Extraction helpers ───────────────────────────────────────────────────────

function extractDescription(md: string): string {
  // Take first meaningful paragraph (>50 chars)
  const paragraphs = md.split("\n\n").filter((p) => p.trim().length > 50);
  return paragraphs[0]?.slice(0, 800) || "";
}

function extractDeadline(text: string): string | null {
  const patterns = [
    /(?:submission|deadline|apply by|closes?|due|last date)[:\s]+([A-Z][a-z]+ \d{1,2},?\s?\d{4})/i,
    /(?:deadline|closes?)[:\s]+(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    /(?:deadline|closes?)[:\s]+(\d{4}-\d{2}-\d{2})/i,
    /(?:deadline|submission)[^\n]*?(\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractStartDate(text: string): string | null {
  const patterns = [
    /(?:starts?|begins?|kicks? off|launch)[:\s]+([A-Z][a-z]+ \d{1,2},?\s?\d{4})/i,
    /(?:event date|date)[:\s]+([A-Z][a-z]+ \d{1,2},?\s?\d{4})/i,
    /(?:from)[:\s]+(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    /(\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}).*?(?:to|-)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractPrizePool(text: string): string | null {
  const patterns = [
    /(?:prize[s]?|pool|reward|win|award)[:\s]*\$?([\d,]+(?:\.\d+)?[kKmM]?)/i,
    /\$([\d,]+(?:\.\d+)?[kKmM]?)\s*(?:prize|award|reward|pool|total)/i,
    /(?:total prize)[:\s]*\$?([\d,]+(?:\.\d+)?[kKmM]?)/i,
    /prize[:\s]+([^\n]{3,60})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const val = m[1].trim();
      if (val.match(/^\d/)) return `$${val}`;
      return val;
    }
  }
  return null;
}

function classifyIndustry(text: string): Industry {
  const t = text.toLowerCase();
  if (/(ai|artificial intelligence|machine learning|llm|gpt|nlp|deep learning|neural)/.test(t)) return "AI / Machine Learning";
  if (/(blockchain|web3|defi|nft|crypto|solidity|ethereum|solana|smart contract)/.test(t)) return "Web3 / Blockchain";
  if (/(fintech|finance|banking|payment|trading|insurtech)/.test(t)) return "FinTech";
  if (/(health|medical|biotech|pharma|med ?tech|clinical|genomics|biology)/.test(t)) return "HealthTech";
  if (/(climate|green|sustainability|carbon|energy|environment|clean ?tech)/.test(t)) return "Climate / GreenTech";
  if (/(gaming|game dev|game jam|unity|unreal|esport)/.test(t)) return "Gaming";
  if (/(cyber|security|ctf|capture the flag|vulnerability|pentest|infosec)/.test(t)) return "Cybersecurity";
  if (/(edtech|education|learning|e-learning|school|university|student)/.test(t)) return "EdTech";
  if (/(open source|developer tool|devtool|sdk|cli|api|infrastructure)/.test(t)) return "Open Source / Developer Tools";
  if (/(social|ngo|nonprofit|community|civic|charity|humanitarian)/.test(t)) return "Social Impact";
  if (/(space|satellite|aerospace|nasa|esa|deep tech|quantum|robotics)/.test(t)) return "Space / Deep Tech";
  if (/(design|ux|ui|figma|creative|product design)/.test(t)) return "Design / UX";
  if (/(data science|analytics|visualization|dataset|statistical)/.test(t)) return "Data Science";
  if (/(hackathon|competition|contest|challenge)/.test(t)) return "General / Multi-Track";
  return "Other";
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const t = text.toLowerCase();
  const keywords = [
    "hackathon", "competition", "contest", "challenge", "bounty",
    "ai", "ml", "web3", "blockchain", "fintech", "healthtech", "gaming",
    "open source", "remote", "in-person", "hybrid", "student", "global",
    "virtual", "prize", "sponsored",
  ];
  for (const kw of keywords) {
    if (t.includes(kw)) tags.push(kw);
  }
  return [...new Set(tags)].slice(0, 8);
}

function extractSource(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E\n]/g, "")
    .trim()
    .slice(0, 1000);
}
