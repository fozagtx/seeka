// ─── src/notion.ts ────────────────────────────────────────────────────────────
// Notion integration: push hackathons to a structured database

import { Client } from "@notionhq/client";
import type { Hackathon } from "./types.js";
import {
  loadHistory,
  isDuplicate,
  recordEntry,
  saveHistory,
  normalizeUrl,
  normalizeTitle,
  titleFingerprint,
} from "./dedupe.js";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DB_ID = process.env.NOTION_DATABASE_ID!;

const seenUrls = new Set<string>();
const seenTitles = new Set<string>();

export { normalizeUrl, normalizeTitle, titleFingerprint };

export async function initSeenUrls(): Promise<void> {
  try {
    let hasMore = true;
    let cursor: string | undefined;
    while (hasMore) {
      const res = await notion.databases.query({ database_id: DB_ID, start_cursor: cursor, page_size: 100 });
      for (const page of res.results) {
        const p = page as any;
        const url = p.properties?.Link?.url;
        if (url) {
          seenUrls.add(normalizeUrl(url));
          const title = p.properties?.Name?.title?.[0]?.plain_text || "";
          if (title) {
            const key = titleFingerprint(title);
            if (key) seenTitles.add(key);
          }
        }
      }
      hasMore = res.has_more;
      cursor = res.next_cursor ?? undefined;
    }
    console.log(`[Notion] Loaded ${seenUrls.size} existing URLs, ${seenTitles.size} title fingerprints`);
  } catch (err) {
    console.error("[Notion] Error loading existing URLs:", err);
  }
}

export async function pushToNotion(hackathon: Hackathon): Promise<string | null> {
  const normUrl = normalizeUrl(hackathon.link);
  const titleKey = titleFingerprint(hackathon.name);

  if (seenUrls.has(normUrl)) {
    console.log(`[Notion] Skipped (URL dup): ${hackathon.name}`);
    return null;
  }
  if (titleKey && seenTitles.has(titleKey)) {
    console.log(`[Notion] Skipped (title dup): ${hackathon.name}`);
    return null;
  }

  const dup = isDuplicate(hackathon.link, hackathon.name);
  if (dup.dup) {
    console.log(`[Notion] Skipped (history ${dup.reason}): ${hackathon.name}`);
    return null;
  }

  try {
    const page = await notion.pages.create({
      parent: { database_id: DB_ID },
      icon: { type: "emoji", emoji: getIndustryEmoji(hackathon.industry) } as any,
      properties: buildProperties(hackathon),
      children: buildPageContent(hackathon),
    } as any);

    seenUrls.add(normUrl);
    if (titleKey) seenTitles.add(titleKey);
    recordEntry(hackathon.link, hackathon.name, page.id);
    await saveHistory();

    console.log(`[Notion] Created: ${hackathon.name}`);
    return page.id;
  } catch (err) {
    console.error(`[Notion] Error for ${hackathon.name}:`, err);
    return null;
  }
}

// ─── Property builders ────────────────────────────────────────────────────────

function buildProperties(h: Hackathon): Record<string, any> {
  const props: Record<string, any> = {
    Name: { title: [{ type: "text", text: { content: h.name.slice(0, 2000) } }] },
    Industry: { select: { name: h.industry } },
    Source: { select: { name: h.source } },
    "Found At": { date: { start: h.foundAt } },
    Status: { select: { name: "Open" } },
    Link: { url: h.link },
  };

  if (h.organizer) props["Organizer"] = { rich_text: [{ type: "text", text: { content: h.organizer.slice(0, 200) } }] };
  if (h.prizePool) props["Prize Pool"] = { rich_text: [{ type: "text", text: { content: h.prizePool.slice(0, 200) } }] };
  if (h.deadline) props["Deadline"] = { rich_text: [{ type: "text", text: { content: h.deadline.slice(0, 200) } }] };
  if (h.startDate) props["Start Date"] = { rich_text: [{ type: "text", text: { content: h.startDate.slice(0, 200) } }] };
  if (h.format) props["Format"] = { select: { name: h.format } };
  if (h.tags.length > 0) props["Tags"] = { multi_select: h.tags.map((t) => ({ name: t })) };

  return props;
}

function buildPageContent(h: Hackathon): any[] {
  // Header callout matching the Telegram format exactly
  const details = [
    h.organizer ? `🏢 Organizer: ${h.organizer}` : null,
    h.prizePool ? `🏆 Prize Pool: ${h.prizePool}` : null,
    h.deadline ? `⏰ Deadline: ${h.deadline}` : null,
    h.startDate ? `📅 Start Date: ${h.startDate}` : null,
    `🏷 Category: ${h.industry}${h.format ? ` | ${h.format}` : ""}`,
    `🔗 Source: ${h.source}`,
  ].filter(Boolean).join("\n");

  return [
    {
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: getIndustryEmoji(h.industry) },
        rich_text: [{ type: "text", text: { content: details } }],
      },
    },
    { type: "divider", divider: {} },
    {
      type: "heading_3",
      heading_3: { rich_text: [{ type: "text", text: { content: "📋 Description" } }] },
    },
    {
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: h.description.slice(0, 2000) || "No description available." } }],
      },
    },
    { type: "divider", divider: {} },
    {
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: `Apply → ${h.link}` }, annotations: { bold: true } }],
      },
    },
    ...(h.tags.length > 0
      ? [{
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: `🏷️ ${h.tags.join(" · ")}` } }] },
        }]
      : []),
  ];
}

function getIndustryEmoji(industry: string): string {
  const map: Record<string, string> = {
    "AI / Machine Learning": "🤖",
    "Web3 / Blockchain": "⛓️",
    FinTech: "💰", HealthTech: "🏥",
    "Climate / GreenTech": "🌿", Gaming: "🎮",
    Cybersecurity: "🔐", EdTech: "📚",
    "Open Source / Developer Tools": "🛠️",
    "Social Impact": "🤝", "Space / Deep Tech": "🚀",
    "Design / UX": "🎨", "Data Science": "📊",
    "General / Multi-Track": "🏆", Other: "📌",
  };
  return map[industry] || "🏆";
}

export async function setupNotionDatabase(): Promise<void> {
  try {
    const db = (await notion.databases.retrieve({ database_id: DB_ID })) as any;
    const props = db.properties ?? {};
    const required = ["Name", "Organizer", "Industry", "Format", "Source", "Found At",
      "Status", "Link", "Prize Pool", "Deadline", "Start Date", "Tags"];
    const missing = required.filter((p) => !props[p]);
    if (missing.length > 0) {
      console.warn(`[Notion] Creating missing properties: ${missing.join(", ")}`);
      await createMissingProperties(missing);
    } else {
      console.log("[Notion] Database schema ✅");
    }
  } catch (err) {
    console.error("[Notion] Error checking database:", err);
    throw err;
  }
}

async function createMissingProperties(missing: string[]): Promise<void> {
  const defs: Record<string, any> = {
    Organizer: { rich_text: {} },
    Industry: { select: {} },
    Format: { select: { options: [
      { name: "In-person", color: "green" },
      { name: "Remote", color: "blue" },
      { name: "Hybrid", color: "purple" },
    ]}},
    Source: { select: {} },
    "Found At": { date: {} },
    Status: { select: { options: [
      { name: "Open", color: "green" },
      { name: "Closed", color: "red" },
      { name: "Upcoming", color: "blue" },
    ]}},
    Link: { url: {} },
    "Prize Pool": { rich_text: {} },
    Deadline: { rich_text: {} },
    "Start Date": { rich_text: {} },
    Tags: { multi_select: {} },
  };
  const updates: Record<string, any> = {};
  for (const prop of missing) {
    if (defs[prop]) updates[prop] = defs[prop];
  }
  if (Object.keys(updates).length > 0) {
    await (notion.databases as any).update({ database_id: DB_ID, properties: updates });
    console.log(`[Notion] Created: ${Object.keys(updates).join(", ")}`);
  }
}


