// ─── scripts/dedupe-notion.ts ─────────────────────────────────────────────────
// One-shot cleanup: scan Notion DB, find duplicates, delete the newer ones
// Usage: bun run scripts/dedupe-notion.ts [--dry-run]

import { config } from "dotenv";
config();

import { Client } from "@notionhq/client";
import { normalizeUrl, titleFingerprint } from "../src/dedupe.js";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DB_ID = process.env.NOTION_DATABASE_ID!;

const dryRun = process.argv.includes("--dry-run");

interface Page {
  id: string;
  url: string;
  normalizedUrl: string;
  titleKey: string;
  title: string;
  createdTime: string;
}

async function fetchAllPages(): Promise<Page[]> {
  const pages: Page[] = [];
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

function findDuplicates(pages: Page[]): Map<string, Page[]> {
  const groups = new Map<string, Page[]>();
  for (const p of pages) {
    const key = p.normalizedUrl || p.titleKey;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  return new Map([...groups].filter(([, v]) => v.length > 1));
}

async function main() {
  console.log(`🔍 Scanning Notion DB ${DB_ID}${dryRun ? " (DRY RUN)" : ""}...`);
  const pages = await fetchAllPages();
  console.log(`📦 Found ${pages.length} total pages`);

  const dupes = findDuplicates(pages);
  console.log(`🔁 Found ${dupes.size} duplicate groups`);

  if (dupes.size === 0) {
    console.log("✅ No duplicates — clean board!");
    return;
  }

  let toDelete = 0;
  for (const [key, group] of dupes) {
    group.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    const keep = group[0];
    const remove = group.slice(1);
    console.log(`\n📌 "${key}" (${group.length} copies)`);
    console.log(`   ✓ KEEP: ${keep.title} [${keep.createdTime}] (${keep.id})`);
    for (const r of remove) {
      console.log(`   ✗ DELETE: ${r.title} [${r.createdTime}] (${r.id})`);
      if (!dryRun) {
        try {
          await notion.pages.update({ page_id: r.id, archived: true });
          console.log(`     ✅ archived`);
        } catch (err) {
          console.error(`     ❌ failed:`, err);
        }
      }
      toDelete++;
    }
  }

  console.log(`\n${dryRun ? "Would delete" : "Deleted"} ${toDelete} duplicate pages.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
