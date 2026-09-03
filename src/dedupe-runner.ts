// ─── src/dedupe-runner.ts ─────────────────────────────────────────────────────
// Runtime dedupe: scan Notion DB, remove duplicates, keep oldest

import { Client } from "@notionhq/client";
import { normalizeUrl, titleFingerprint } from "./dedupe.js";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DB_ID = process.env.NOTION_DATABASE_ID!;

export interface DedupePage {
  id: string;
  url: string;
  normalizedUrl: string;
  titleKey: string;
  title: string;
  createdTime: string;
}

export interface DedupeResult {
  scanned: number;
  groups: number;
  deleted: number;
  dryRun: boolean;
  details: Array<{
    key: string;
    kept: { id: string; title: string; createdTime: string };
    removed: Array<{ id: string; title: string; createdTime: string }>;
  }>;
}

async function fetchAllPages(): Promise<DedupePage[]> {
  const pages: DedupePage[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const res = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      const p = page as any;
      const url = p.properties?.Link?.url || "";
      const title = p.properties?.Name?.title?.[0]?.plain_text || "";
      pages.push({
        id: p.id,
        url,
        normalizedUrl: normalizeUrl(url),
        titleKey: titleFingerprint(title),
        title,
        createdTime: p.created_time,
      });
    }
    hasMore = res.has_more;
    cursor = res.next_cursor ?? undefined;
  }
  return pages;
}

export async function dedupeNotion(dryRun: boolean = false): Promise<DedupeResult> {
  const pages = await fetchAllPages();

  const groups = new Map<string, DedupePage[]>();
  for (const p of pages) {
    const key = p.normalizedUrl || p.titleKey;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const dupGroups = new Map([...groups].filter(([, v]) => v.length > 1));

  const result: DedupeResult = {
    scanned: pages.length,
    groups: dupGroups.size,
    deleted: 0,
    dryRun,
    details: [],
  };

  for (const [key, group] of dupGroups) {
    group.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    const keep = group[0];
    const remove = group.slice(1);
    const detail = {
      key,
      kept: { id: keep.id, title: keep.title, createdTime: keep.createdTime },
      removed: remove.map((r) => ({ id: r.id, title: r.title, createdTime: r.createdTime })),
    };
    for (const r of remove) {
      if (!dryRun) {
        try {
          await notion.pages.update({ page_id: r.id, archived: true });
        } catch (err) {
          console.error(`[Dedupe] Failed to archive ${r.id}:`, err);
          continue;
        }
      }
      result.deleted++;
    }
    result.details.push(detail);
  }

  return result;
}

export function formatDedupeResult(r: DedupeResult): string {
  if (r.groups === 0) {
    return `✅ *No duplicates found*\n\nScanned: ${r.scanned} pages`;
  }
  const lines = [
    `${r.dryRun ? "🔍 *DRY RUN — Preview Only*" : "✅ *Dedupe Complete*"}`,
    ``,
    `📦 Scanned: *${r.scanned}* pages`,
    `🔁 Duplicate groups: *${r.groups}*`,
    `🗑️ ${r.dryRun ? "Would delete" : "Deleted"}: *${r.deleted}* pages`,
    ``,
  ];
  const sample = r.details.slice(0, 8);
  lines.push(`*Top duplicates:*`);
  for (const d of sample) {
    lines.push(`• _${d.kept.title.slice(0, 40)}_ — ${d.removed.length + 1} copies`);
  }
  if (r.details.length > sample.length) {
    lines.push(`…and ${r.details.length - sample.length} more`);
  }
  return lines.join("\n");
}
