// ─── src/xsearch.ts ───────────────────────────────────────────────────────────
// X API v2 recent search → SearchResult[] (with attached images + expanded links)
// Runs inside the normal sweep loop; keeps a since_id cursor so each run only
// pulls posts newer than the previous one.

import type { SearchResult } from "./types.js";

const X_API_URL = "https://api.x.com/2/tweets/search/recent";
const CURSOR_FILE = "./data/x-cursor.json";

const OPPORTUNITY_TERMS = `(hackathon OR #hackathon OR buildathon OR "coding competition" OR "developer challenge")`;
const ACTION_TERMS = `(apply OR register OR registration OR deadline OR prize OR prizes OR "submissions open" OR "applications open")`;
const FILTERS = `has:links -is:retweet -is:reply lang:en`;

export const X_SWEEP_QUERIES = [
  `${OPPORTUNITY_TERMS} ${ACTION_TERMS} ${FILTERS}`,
  `(hackathon OR buildathon) (ethereum OR solana OR web3 OR blockchain OR crypto) (prize OR register OR apply) ${FILTERS}`,
  `(hackathon OR buildathon) (AI OR "machine learning" OR LLM OR agents) (prize OR register OR apply) ${FILTERS}`,
];

interface XMedia {
  media_key: string;
  type: "photo" | "video" | "animated_gif";
  url?: string;
  preview_image_url?: string;
}

interface XUser {
  id: string;
  username: string;
  name: string;
}

interface XPost {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  attachments?: { media_keys?: string[] };
  entities?: {
    urls?: Array<{ url: string; expanded_url?: string; unwound_url?: string; display_url?: string }>;
  };
}

interface XSearchResponse {
  data?: XPost[];
  includes?: { media?: XMedia[]; users?: XUser[] };
  meta?: { newest_id?: string; oldest_id?: string; result_count: number; next_token?: string };
  errors?: unknown[];
}

interface CursorStore {
  [queryKey: string]: { sinceId: string; updatedAt: string };
}

export function isXConfigured(): boolean {
  return Boolean(process.env.X_BEARER_TOKEN);
}

class XApiError extends Error {
  constructor(public status: number, body: string) {
    super(`X API ${status}: ${body.slice(0, 300)}`);
  }
}

function describeError(err: unknown): string {
  if (err instanceof XApiError) {
    if (err.status === 401) return "401 unauthorized — X\\_BEARER\\_TOKEN is invalid";
    if (err.status === 403) return "403 forbidden — this X app/tier cannot use recent search";
    if (err.status === 429) return "429 rate limited — X tier quota exhausted, retry next run";
    return err.message.replace(/_/g, "\\_");
  }
  return String(err).slice(0, 200).replace(/_/g, "\\_");
}

export async function searchX(
  queries: string[],
  onStatus?: (msg: string) => void
): Promise<SearchResult[]> {
  if (!isXConfigured()) return [];

  const cursors = await loadCursors();
  const results: SearchResult[] = [];
  let posts = 0;

  const errors: string[] = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const key = cursorKey(query);
    const sinceId = cursors[key]?.sinceId;
    try {
      let res: XSearchResponse;
      try {
        res = await fetchRecent(query, sinceId);
      } catch (err) {
        // since_id older than the 7-day window is rejected with 400 — drop the cursor and retry
        if (err instanceof XApiError && err.status === 400 && sinceId) {
          console.warn(`[X] since_id ${sinceId} rejected, retrying without cursor`);
          delete cursors[key];
          res = await fetchRecent(query, undefined);
        } else {
          throw err;
        }
      }
      const batch = toSearchResults(res);
      posts += res.data?.length ?? 0;
      results.push(...batch);
      if (res.meta?.newest_id) {
        cursors[key] = { sinceId: res.meta.newest_id, updatedAt: new Date().toISOString() };
      }
    } catch (err) {
      console.error(`[X] Search failed for "${query.slice(0, 60)}…":`, err);
      errors.push(describeError(err));
      if (err instanceof XApiError && (err.status === 429 || err.status === 401 || err.status === 403)) {
        const remaining = queries.length - i - 1;
        if (remaining > 0) errors.push(`skipped ${remaining} remaining X quer${remaining > 1 ? "ies" : "y"}`);
        break;
      }
    }
    if (i < queries.length - 1) await sleep(1100); // recent search is rate limited per 15 min window; be gentle
  }

  await saveCursors(cursors);

  const deduped = dedupeByUrl(results);
  const summary = `🐦 X API: ${posts} new posts → ${deduped.length} candidate links`;
  onStatus?.(errors.length > 0 ? `${summary}\n⚠️ ${errors.join("; ")}` : summary);
  console.log(`[X] ${posts} posts → ${deduped.length} candidates${errors.length ? ` (${errors.length} errors)` : ""}`);
  return deduped;
}

async function fetchRecent(query: string, sinceId?: string): Promise<XSearchResponse> {
  const params = new URLSearchParams({
    query: query.replace(/\s+/g, " ").trim(),
    max_results: "100",
    "tweet.fields": "created_at,author_id,entities,attachments,public_metrics",
    expansions: "author_id,attachments.media_keys",
    "media.fields": "media_key,type,url,preview_image_url",
    "user.fields": "username,name",
  });
  if (sinceId) params.set("since_id", sinceId);

  const response = await fetch(`${X_API_URL}?${params}`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` },
  });

  if (!response.ok) {
    throw new XApiError(response.status, await response.text());
  }
  return (await response.json()) as XSearchResponse;
}

// One SearchResult per (post, outbound link). The linked page becomes `url`
// so the scraper fetches the real event page; the post stays as `sourceUrl`.
function toSearchResults(res: XSearchResponse): SearchResult[] {
  const media = new Map((res.includes?.media ?? []).map((m) => [m.media_key, m]));
  const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u]));
  const out: SearchResult[] = [];

  for (const post of res.data ?? []) {
    const author = post.author_id ? users.get(post.author_id) : undefined;
    const postUrl = `https://x.com/${author?.username ?? "i/web"}/status/${post.id}`;
    const imageUrl = firstImage(post, media);
    const title = deriveTitle(post.text);
    const text = stripTcoLinks(post.text);

    const links = (post.entities?.urls ?? [])
      .map((u) => u.unwound_url || u.expanded_url || "")
      .filter((u) => u && !isXHost(u) && !isMediaLink(u));

    if (links.length === 0) {
      out.push({ title, url: postUrl, text, publishedDate: post.created_at, author: author?.name, imageUrl, origin: "x" });
      continue;
    }

    for (const link of links.slice(0, 2)) {
      out.push({
        title,
        url: link,
        text,
        publishedDate: post.created_at,
        author: author?.name,
        imageUrl,
        sourceUrl: postUrl,
        origin: "x",
      });
    }
  }
  return out;
}

function firstImage(post: XPost, media: Map<string, XMedia>): string | undefined {
  for (const key of post.attachments?.media_keys ?? []) {
    const m = media.get(key);
    if (!m) continue;
    if (m.type === "photo" && m.url) return m.url;
    if (m.preview_image_url) return m.preview_image_url;
  }
  return undefined;
}

// First meaningful line of the post, minus hashtags/emoji noise
function deriveTitle(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/https:\/\/t\.co\/\w+/g, "").replace(/#\w+/g, "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim())
    .find((l) => l.length >= 8);
  return (line ?? text).slice(0, 120);
}

function stripTcoLinks(text: string): string {
  return text.replace(/https:\/\/t\.co\/\w+/g, "").replace(/\s+/g, " ").trim();
}

function isXHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ["x.com", "twitter.com", "t.co"].some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return true;
  }
}

function isMediaLink(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|mp4)(\?|$)/i.test(url) || /pic\.twitter\.com/.test(url);
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

function cursorKey(query: string): string {
  return Bun.hash(query.replace(/\s+/g, " ").trim()).toString(16);
}

async function loadCursors(): Promise<CursorStore> {
  try {
    const file = Bun.file(CURSOR_FILE);
    if (await file.exists()) return (await file.json()) as CursorStore;
  } catch (err) {
    console.error("[X] Failed to read cursor file:", err);
  }
  return {};
}

async function saveCursors(cursors: CursorStore): Promise<void> {
  try {
    await Bun.write(CURSOR_FILE, JSON.stringify(cursors, null, 2));
  } catch (err) {
    console.error("[X] Failed to save cursor file:", err);
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
