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
}

export function formatTelegramMessage(h: Hackathon): string {
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
    `\n${escMd(h.description.slice(0, 600))}\n` +
    `\n*Apply →*\n${h.link}`
  );
}

function escMd(text: string): string {
  // Telegram parse_mode "Markdown" (legacy) only needs these four escaped
  return text.replace(/[_*`\[]/g, "\\$&");
}
