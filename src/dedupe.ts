// ─── src/dedupe.ts ────────────────────────────────────────────────────────────
// Multi-layer dedupe: URL normalization + title fingerprint + persistent history

import { promises as fs } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const HISTORY_FILE = join(DATA_DIR, "seen-hackathons.json");

export interface HistoryEntry {
  url: string;        // normalized URL
  title: string;      // normalized title
  titleKey: string;   // fingerprint key
  notionId: string;   // Notion page id
  pushedAt: string;   // ISO timestamp
}

interface History {
  entries: HistoryEntry[];
}

let history: History = { entries: [] };
let loaded = false;
const titleKeys = new Set<string>();
const urls = new Set<string>();

const STOP_WORDS = new Set([
  "hackathon", "hack", "athon", "challenge", "competition", "contest",
  "2025", "2026", "2027", "edition", "global", "online", "world",
  "the", "and", "of", "for", "in", "to", "a", "an",
  "build", "with", "on", "by", "from", "at",
  "official", "main", "season", "spring", "summer", "fall", "autumn", "winter",
  "register", "registration", "apply", "now", "open",
  "powered", "presented", "brought", "sponsored", "sponsor",
]);

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_name", "ref", "source", "fbclid", "gclid", "mc_cid", "mc_eid",
  "yclid", "_ga", "_gl", "icid", "igshid",
]);

const HOST_ALIASES: Record<string, string> = {
  "www.devpost.com": "devpost.com",
  "devpost.com": "devpost.com",
  "hackathon.io": "hackathon.io",
  "www.hackathon.io": "hackathon.io",
  "taikai.network": "taikai.network",
  "www.taikai.network": "taikai.network",
  "mlh.io": "mlh.io",
  "www.mlh.io": "mlh.io",
  "ethglobal.com": "ethglobal.com",
  "www.ethglobal.com": "ethglobal.com",
  "dorahacks.io": "dorahacks.io",
  "www.dorahacks.io": "dorahacks.io",
  "lablab.ai": "lablab.ai",
  "www.lablab.ai": "lablab.ai",
  "unstop.com": "unstop.com",
  "www.unstop.com": "unstop.com",
  "hackerearth.com": "hackerearth.com",
  "www.hackerearth.com": "hackerearth.com",
  "hackclub.com": "hackclub.com",
  "www.hackclub.com": "hackclub.com",
};

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";

    let host = u.hostname.toLowerCase();
    host = HOST_ALIASES[host] || host;

    let pathname = u.pathname.replace(/\/+$/, "") || "/";
    pathname = pathname.replace(/\/index\.(html|php)$/i, "/");

    const params: string[] = [];
    u.searchParams.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (TRACKING_PARAMS.has(lk)) return;
      if (lk.startsWith("utm_")) return;
      params.push(`${k}=${v}`);
    });
    params.sort();

    return `${host}${pathname}${params.length ? "?" + params.join("&") : ""}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[|—–\-:•·]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleFingerprint(title: string): string {
  const normalized = normalizeTitle(title);
  const tokens = normalized
    .split(" ")
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t))
    .filter((t) => !/^\d+$/.test(t));

  if (tokens.length === 0) {
    return normalized.replace(/\s+/g, "");
  }

  const sorted = [...tokens].sort();
  return sorted.join("-").slice(0, 200);
}

export function isDuplicate(url: string, title: string): { dup: boolean; reason?: string } {
  const normUrl = normalizeUrl(url);
  const titleKey = titleFingerprint(title);

  if (urls.has(normUrl)) {
    return { dup: true, reason: `url:${normUrl}` };
  }

  if (titleKeys.has(titleKey) && titleKey.length > 0) {
    return { dup: true, reason: `title:${titleKey}` };
  }

  return { dup: false };
}

export function recordEntry(url: string, title: string, notionId: string): void {
  const normUrl = normalizeUrl(url);
  const titleKey = titleFingerprint(title);

  urls.add(normUrl);
  if (titleKey) titleKeys.add(titleKey);

  history.entries.push({
    url: normUrl,
    title: normalizeTitle(title),
    titleKey,
    notionId,
    pushedAt: new Date().toISOString(),
  });
}

export async function loadHistory(): Promise<void> {
  if (loaded) return;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(HISTORY_FILE, "utf-8");
    history = JSON.parse(raw);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error("[Dedupe] Error loading history:", err);
    }
    history = { entries: [] };
  }

  urls.clear();
  titleKeys.clear();
  for (const e of history.entries) {
    urls.add(e.url);
    if (e.titleKey) titleKeys.add(e.titleKey);
  }

  loaded = true;
  console.log(`[Dedupe] Loaded ${urls.size} URLs, ${titleKeys.size} title fingerprints`);
}

export async function saveHistory(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("[Dedupe] Error saving history:", err);
  }
}

export function getStats() {
  return {
    urls: urls.size,
    titleKeys: titleKeys.size,
    totalEntries: history.entries.length,
  };
}
