// ─── src/scraper.ts ───────────────────────────────────────────────────────────
// Firecrawl-powered deep scraping of hackathon detail pages

import type { SearchResult, Hackathon, Industry } from "./types.js";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v1";
const FIRESCRAPER_BASE = "https://firescraper.com/api/v1";

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
  let markdown = "";
  let metadata: NonNullable<FirecrawlResult["data"]>["metadata"] = {};
  const twitterUrl = isTwitterUrl(result.url);

  if (twitterUrl) {
    markdown = await scrapeWithFireScraper(result.url);
  }

  if (!twitterUrl || markdown.length < 300) {
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

      if (response.ok) {
        const data: FirecrawlResult = await response.json();
        if (data.success && data.data) {
          const firecrawlMarkdown = data.data.markdown || "";
          markdown = [markdown, firecrawlMarkdown].filter(Boolean).join("\n\n");
          metadata = data.data.metadata || {};
        }
      } else {
        console.error(`[Firecrawl] HTTP ${response.status} for ${result.url}`);
      }
    } catch (err) {
      console.error(`[Firecrawl] Error scraping ${result.url}:`, err);
    }
  }

  if (!twitterUrl && markdown.length < 300) {
    const fireScraperText = await scrapeWithFireScraper(result.url);
    if (fireScraperText) {
      markdown = [markdown, fireScraperText].filter(Boolean).join("\n\n");
    }
  }

  if (!markdown && !result.text) {
    return parseFromSearchResult(result);
  }

  const combined = markdown + " " + result.text;

  // ── Drop pages that explicitly say the event has ended ──────────────────
  if (isEventEnded(combined)) {
    console.log(`[Scraper] Skipping ended event: ${result.url}`);
    return null;
  }

  const name = metadata?.ogTitle || metadata?.title || result.title || "Unnamed Opportunity";
  const description =
    extractDescription(markdown) ||
    metadata?.ogDescription ||
    metadata?.description ||
    result.text.slice(0, 500) ||
    "No description found.";

  return {
    name: cleanText(name),
    organizer: extractOrganizer(combined),
    description: cleanText(description),
    startDate: extractStartDate(combined),
    deadline: extractDeadline(combined),
    prizePool: extractPrizePool(combined),
    format: extractFormat(combined),
    industry: classifyIndustry(name + " " + description + " " + combined),
    link: result.url,
    source: extractSource(result.url),
    foundAt: new Date().toISOString(),
    tags: extractTags(name + " " + description + " " + combined),
  };
}

async function scrapeWithFireScraper(url: string): Promise<string> {
  const apiKey = process.env.FIRESCRAPER_API_KEY;
  if (!apiKey) return "";

  try {
    const sessionRes = await fetch(`${FIRESCRAPER_BASE}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `Seeka scrape ${new Date().toISOString()}`,
        urls: [url],
        maxDepth: isTwitterUrl(url) ? 1 : 0,
        minTextLength: isTwitterUrl(url) ? 5 : 50,
        scraper: isTwitterUrl(url) ? "full" : "article",
        uniqueTextDownloads: true,
        respectRobotsTxt: !isTwitterUrl(url),
      }),
    });

    if (!sessionRes.ok) {
      console.error(`[FireScraper] HTTP ${sessionRes.status} starting ${url}`);
      return "";
    }

    const session = await sessionRes.json() as { id?: string; session?: { id?: string } };
    const sessionId = session.id || session.session?.id;
    if (!sessionId) return "";

    const done = await waitForFireScraperSession(sessionId, apiKey);
    if (!done) return "";

    return await getFireScraperResults(sessionId, apiKey);
  } catch (err) {
    console.error(`[FireScraper] Error scraping ${url}:`, err);
    return "";
  }
}

async function waitForFireScraperSession(sessionId: string, apiKey: string): Promise<boolean> {
  for (let attempt = 0; attempt < 18; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1000 : 2500));

    const res = await fetch(`${FIRESCRAPER_BASE}/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) continue;

    const data = await res.json() as {
      session?: { status?: string; downloadFilesReady?: boolean };
    };
    const status = data.session?.status?.toLowerCase();
    if (data.session?.downloadFilesReady || status === "done" || status === "completed") return true;
    if (status === "failed" || status === "error") return false;
  }
  return false;
}

async function getFireScraperResults(sessionId: string, apiKey: string): Promise<string> {
  const jsonRes = await fetch(`${FIRESCRAPER_BASE}/sessions/${sessionId}/results?format=json`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (jsonRes.ok) {
    const contentType = jsonRes.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await jsonRes.json();
      const text = extractFireScraperText(payload);
      if (text) return text;
    } else {
      const text = await jsonRes.text();
      if (text) return text;
    }
  }

  const mdRes = await fetch(`${FIRESCRAPER_BASE}/sessions/${sessionId}/results?format=markdown`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return mdRes.ok ? await mdRes.text() : "";
}

function extractFireScraperText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload.map(extractFireScraperText).filter(Boolean).join("\n\n");
  }
  if (!payload || typeof payload !== "object") return "";

  const obj = payload as Record<string, unknown>;
  const direct = [obj.markdown, obj.text, obj.content, obj.title]
    .filter((value): value is string => typeof value === "string")
    .join("\n\n");
  const nested = [obj.data, obj.results, obj.pages, obj.documents]
    .map(extractFireScraperText)
    .filter(Boolean)
    .join("\n\n");
  return [direct, nested].filter(Boolean).join("\n\n");
}

function isTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

function parseFromSearchResult(result: SearchResult): Hackathon | null {
  const combined = result.title + " " + result.text;
  if (isEventEnded(combined)) {
    console.log(`[Scraper] Skipping ended (fallback): ${result.url}`);
    return null;
  }
  return {
    name: cleanText(result.title || "Unnamed Event"),
    organizer: extractOrganizer(combined),
    description: cleanText(result.text.slice(0, 600)),
    startDate: extractStartDate(combined),
    deadline: extractDeadline(combined),
    prizePool: extractPrizePool(combined),
    format: extractFormat(combined),
    industry: classifyIndustry(combined),
    link: result.url,
    source: extractSource(result.url),
    foundAt: new Date().toISOString(),
    tags: extractTags(combined),
  };
}

// ─── Extraction helpers ───────────────────────────────────────────────────────

function extractDescription(md: string): string {
  const paragraphs = md.split("\n\n").filter((p) => p.trim().length > 50);
  return paragraphs[0]?.slice(0, 800) || "";
}

function extractOrganizer(text: string): string | null {
  const patterns = [
    /(?:organized by|organizer|hosted by|presented by|sponsor)[:\s]+([^\n,\.]{3,80})/i,
    /(?:by|from)\s+([A-Z][A-Za-z\s&,]+(?:Inc|LLC|Labs|Foundation|Community|Network)?)/,
    /(?:partner|partnered with)[:\s]+([^\n,\.]{3,60})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().slice(0, 100);
  }
  return null;
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
    /prize[:\s]+([^\n]{3,80})/i,
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

function extractFormat(text: string): "In-person" | "Remote" | "Hybrid" | null {
  const t = text.toLowerCase();
  if (/(hybrid)/.test(t)) return "Hybrid";
  if (/(in.person|on.site|onsite|physical|local event|host a fest|in your city)/.test(t)) return "In-person";
  if (/(virtual|online|remote|digital event)/.test(t)) return "Remote";
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

function isEventEnded(text: string): boolean {
  const t = text.toLowerCase();
  const deadline = extractDeadline(text);
  if (deadline) {
    const parsed = new Date(deadline);
    if (!isNaN(parsed.getTime()) && parsed < new Date()) return true;
  }
  const endedPatterns = [
    /(?:event|competition|hackathon|submission)\s+(?:has|have)\s+(ended|closed|finished|concluded)/i,
    /(?:thank you|thanks).{0,40}(?:participat|apply|submit|interest)/i,
    /(?:closed|ended)\s+(?:on|:)\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
    /(?:submissions?\s+(?:are|have?\s+been)?\s*(?:closed|ended|finished))/i,
    /(?:no longer|not currently)\s+(?:accepting|open)/i,
    /(?:this\s+(?:event|edition|competition|hackathon)\s+(?:is|has)\s+(?:over|finished|completed|done))/i,
    /(?:past\s+event|past\s+(?:edition|competition|hackathon))/i,
    /(?:the\s+results?\s+(?:are|have\s+been)\s+(?:announced|out|published|released))/i,
    /(?:winners?\s+(?:announced|selected|chosen|revealed))/i,
  ];
  for (const p of endedPatterns) {
    if (p.test(t)) return true;
  }
  return false;
}
