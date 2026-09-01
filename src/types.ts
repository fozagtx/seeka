// ─── src/types.ts ─────────────────────────────────────────────────────────────
// Central type definitions for the hackathon tracker bot

export interface Hackathon {
  id?: string; // Notion page ID after saving
  name: string;
  description: string;
  startDate: string | null;
  deadline: string | null;
  prizePool: string | null;
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
  query: string; // custom search query override
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
  author?: string;
}
