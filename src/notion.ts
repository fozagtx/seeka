// ─── src/notion.ts ────────────────────────────────────────────────────────────
// Notion integration: push hackathons to a structured database

import { Client } from "@notionhq/client";
import type { Hackathon } from "./types.js";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DB_ID = process.env.NOTION_DATABASE_ID!;

// Track URLs already in Notion (deduplication)
const seenUrls = new Set<string>();

export async function initSeenUrls(): Promise<void> {
  try {
    let hasMore = true;
    let cursor: string | undefined;

    while (hasMore) {
      const res = await notion.databases.query({
        database_id: DB_ID,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const page of res.results) {
        const p = page as any;
        if (p.properties?.Link?.url) {
          seenUrls.add(p.properties.Link.url);
        }
      }

      hasMore = res.has_more;
      cursor = res.next_cursor ?? undefined;
    }

    console.log(`[Notion] Loaded ${seenUrls.size} existing URLs from database`);
  } catch (err) {
    console.error("[Notion] Error loading existing URLs:", err);
  }
}

export async function pushToNotion(hackathon: Hackathon): Promise<string | null> {
  if (seenUrls.has(hackathon.link)) {
    console.log(`[Notion] Skipping duplicate: ${hackathon.link}`);
    return null;
  }

  try {
    const page = await notion.pages.create({
      parent: { database_id: DB_ID },
      icon: { type: "emoji", emoji: getIndustryEmoji(hackathon.industry) } as any,
      properties: buildProperties(hackathon),
      children: buildPageContent(hackathon),
    } as any);

    seenUrls.add(hackathon.link);
    console.log(`[Notion] Created page: ${hackathon.name}`);
    return page.id;
  } catch (err) {
    console.error(`[Notion] Error creating page for ${hackathon.name}:`, err);
    return null;
  }
}

export async function pushBatchToNotion(
  hackathons: Hackathon[]
): Promise<{ pushed: number; skipped: number }> {
  let pushed = 0;
  let skipped = 0;

  for (const h of hackathons) {
    const id = await pushToNotion(h);
    if (id) pushed++;
    else skipped++;
    await sleep(350); // Rate limit: ~3 req/s
  }

  return { pushed, skipped };
}

// ─── Property builders ────────────────────────────────────────────────────────

function buildProperties(h: Hackathon): Record<string, any> {
  const props: Record<string, any> = {
    Name: {
      title: [{ type: "text", text: { content: h.name.slice(0, 2000) } }],
    },
    Industry: { select: { name: h.industry } },
    Source: { select: { name: h.source } },
    "Found At": { date: { start: h.foundAt } },
    Status: { select: { name: "Open" } },
    Link: { url: h.link },
  };

  if (h.prizePool) {
    props["Prize Pool"] = {
      rich_text: [{ type: "text", text: { content: h.prizePool.slice(0, 200) } }],
    };
  }
  if (h.deadline) {
    props["Deadline"] = {
      rich_text: [{ type: "text", text: { content: h.deadline.slice(0, 200) } }],
    };
  }
  if (h.startDate) {
    props["Start Date"] = {
      rich_text: [{ type: "text", text: { content: h.startDate.slice(0, 200) } }],
    };
  }
  if (h.tags.length > 0) {
    props["Tags"] = {
      multi_select: h.tags.map((t) => ({ name: t })),
    };
  }

  return props;
}

function buildPageContent(h: Hackathon): any[] {
  return [
    {
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "📋 Overview" } }] },
    },
    {
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "💡" },
        rich_text: [{ type: "text", text: { content: h.description.slice(0, 2000) || "No description available." } }],
      },
    },
    { type: "divider", divider: {} },
    {
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "🗓️ Key Dates & Prizes" } }] },
    },
    ...[
      h.startDate ? `📅 Start Date: ${h.startDate}` : null,
      h.deadline ? `⏰ Deadline: ${h.deadline}` : null,
      h.prizePool ? `🏆 Prize Pool: ${h.prizePool}` : null,
      `🌐 Industry: ${h.industry}`,
      `🔗 Link: ${h.link}`,
      `📡 Source: ${h.source}`,
    ]
      .filter(Boolean)
      .map((text) => ({
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: text! } }] },
      })),
    ...(h.tags.length > 0
      ? [
          { type: "divider", divider: {} },
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: `🏷️ Tags: ${h.tags.join(" · ")}` } }],
            },
          },
        ]
      : []),
  ];
}

function getIndustryEmoji(industry: string): string {
  const map: Record<string, string> = {
    "AI / Machine Learning": "🤖",
    "Web3 / Blockchain": "⛓️",
    FinTech: "💰",
    HealthTech: "🏥",
    "Climate / GreenTech": "🌿",
    Gaming: "🎮",
    Cybersecurity: "🔐",
    EdTech: "📚",
    "Open Source / Developer Tools": "🛠️",
    "Social Impact": "🤝",
    "Space / Deep Tech": "🚀",
    "Design / UX": "🎨",
    "Data Science": "📊",
    "General / Multi-Track": "🏆",
    Other: "📌",
  };
  return map[industry] || "🏆";
}

export async function setupNotionDatabase(): Promise<void> {
  try {
    const db = (await notion.databases.retrieve({ database_id: DB_ID })) as any;
    const props = db.properties ?? {};
    const required = [
      "Name", "Industry", "Source", "Found At", "Status",
      "Link", "Prize Pool", "Deadline", "Start Date", "Tags",
    ];
    const missing = required.filter((p) => !props[p]);
    if (missing.length > 0) {
      console.warn(`[Notion] Missing properties: ${missing.join(", ")} — creating...`);
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
    Industry: { select: {} },
    Source: { select: {} },
    "Found At": { date: {} },
    Status: {
      select: {
        options: [
          { name: "Open", color: "green" },
          { name: "Closed", color: "red" },
          { name: "Upcoming", color: "blue" },
        ],
      },
    },
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
