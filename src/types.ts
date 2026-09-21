// ─── src/types.ts ─────────────────────────────────────────────────────────────

export interface Hackathon {
  id?: string; // Notion page ID after saving
  name: string;
  organizer: string | null;
  description: string;
  startDate: string | null;
  deadline: string | null;
  prizePool: string | null;
  format: "In-person" | "Remote" | "Hybrid" | null;
  industry: Industry;
  link: string;
  source: string;
  foundAt: string; // ISO timestamp
  tags: string[];
  imageUrl: string | null;
  sourceUrl?: string; // where it was discovered (e.g. the X post) when different from link
}

export type Industry =
  | "AI / Machine Learning"
  | "Web3 / Blockchain"
  | "FinTech"
  | "HealthTech"
  | "Climate / GreenTech"
  | "Gaming"
  | "Cybersecurity"
  | "EdTech"
  | "Open Source / Developer Tools"
  | "Social Impact"
  | "Space / Deep Tech"
  | "Design / UX"
  | "Data Science"
  | "General / Multi-Track"
  | "Other";

export const INDUSTRIES: Industry[] = [
  "AI / Machine Learning",
  "Web3 / Blockchain",
  "FinTech",
  "HealthTech",
  "Climate / GreenTech",
  "Gaming",
  "Cybersecurity",
  "EdTech",
  "Open Source / Developer Tools",
  "Social Impact",
  "Space / Deep Tech",
  "Design / UX",
  "Data Science",
  "General / Multi-Track",
  "Other",
];

export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression
  query: string;    // custom search query override
  enabled: boolean;
  lastRun?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
  author?: string;
  imageUrl?: string;
  sourceUrl?: string; // original discovery URL (X post) when url points to the linked page
  origin?: "exa" | "x";
}

export interface PipelineCallbacks {
  onStatus: (msg: string) => Promise<void>;
  onNew: (h: Hackathon) => Promise<void>;
  onSummary: (msg: string) => Promise<void>;
}

export const TELEGRAM_CAPTION_LIMIT = 1024;

export function formatTelegramMessage(h: Hackathon, descriptionLimit = 600): string {
  const category = [h.industry.split(" /")[0], h.format]
    .filter(Boolean)
    .join(" | ");

  return (
    `🆕 *New hackathon found:*\n\n` +
    `*${escMd(h.name)}*\n` +
    (h.organizer ? `Organizer: ${escMd(h.organizer)}\n` : "") +
    (h.prizePool ? `Prize Pool: ${escMd(h.prizePool)}\n` : "") +
    (h.deadline ? `Deadline: ${escMd(h.deadline)}\n` : "") +
    `Category: ${escMd(category)}\n` +
    (h.description ? `\n${escMd(h.description.slice(0, descriptionLimit))}\n` : "") +
    `\n*Apply →*\n${h.link}` +
    (h.sourceUrl && h.sourceUrl !== h.link ? `\n\n_Found on X:_ ${h.sourceUrl}` : "")
  );
}

// Shorter variant that fits Telegram's photo caption limit
export function formatTelegramCaption(h: Hackathon): string {
  for (const limit of [400, 250, 120, 0]) {
    const caption = formatTelegramMessage(h, limit);
    if (caption.length <= TELEGRAM_CAPTION_LIMIT) return caption;
  }
  return formatTelegramMessage(h, 0).slice(0, TELEGRAM_CAPTION_LIMIT);
}

export function escMd(text: string): string {
  // Telegram parse_mode "Markdown" (legacy) only needs these four escaped
  return text.replace(/[_*`\[]/g, "\\$&");
}
