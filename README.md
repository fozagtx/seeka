# Seeka 🔍

**Telegram bot that hunts hackathons, competitions & contests across the web and delivers them to your Notion.**

## What it does

1. **Searches** — Uses [Exa](https://exa.ai) to scan the web, X/Twitter, and major hackathon platforms (Devpost, HackerEarth, Devfolio, MLH, Lablab, etc.)
2. **Scrapes details** — Uses [Firecrawl](https://firecrawl.dev) to extract full details: name, description, start date, deadline, prize pool
3. **Classifies by industry** — AI/ML, Web3, FinTech, HealthTech, Climate, Gaming, Cybersecurity, EdTech, etc.
4. **Pushes to Notion** — Creates structured, rich pages in your Notion database with deduplication
5. **Cron jobs** — Fully configurable scheduled searches (set via Telegram)

---

## Setup

### 1. Clone & install

```bash
git clone <your-repo>
cd seeka
bun install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|----------|----------------|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) on Telegram |
| `TELEGRAM_ADMIN_CHAT_ID` | Message [@userinfobot](https://t.me/userinfobot) |
| `EXA_API_KEY` | [exa.ai/api](https://exa.ai) |
| `FIRECRAWL_API_KEY` | [firecrawl.dev](https://firecrawl.dev) |
| `NOTION_API_KEY` | [notion.so/my-integrations](https://www.notion.so/my-integrations) |
| `NOTION_DATABASE_ID` | Copy from your Notion database URL |

### 3. Set up Notion database

1. Create a new Notion database (or use an existing one)
2. Share it with your integration (3-dot menu → Add connections → your integration)
3. The bot will **auto-create any missing properties** on first start

Required database properties (auto-created if missing):
- `Name` (title)
- `Organizer` (text)
- `Industry` (select)
- `Format` (select: In-person / Remote / Hybrid)
- `Source` (select)
- `Prize Pool` (text)
- `Deadline` (text)
- `Start Date` (text)
- `Found At` (date)
- `Status` (select)
- `Link` (URL)
- `Tags` (multi-select)

### 4. Run

```bash
bun start           # Production
bun dev             # Dev mode with hot reload
```

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/search` | Run a full hackathon sweep right now |
| `/custom <query>` | Search with your own query |
| `/jobs` | List all scheduled cron jobs |
| `/addjob` | Add a new scheduled search (interactive) |
| `/removejob` | Remove a cron job |
| `/togglejob` | Pause or resume a cron job |
| `/setschedule` | Change a job's cron expression |
| `/runjob` | Manually run a specific job now |

---

## Default Cron Jobs

| Job | Schedule | Query |
|-----|----------|-------|
| Every 4 Hours | `0 */4 * * *` | Full sweep |
| Daily AI/ML | `0 10 * * *` (10 AM daily) | AI/ML hackathons |
| Daily Web3 | `0 14 * * *` (2 PM daily) | Blockchain/Web3 hackathons |

Tap **/start** in Telegram to run the first sweep. After that it runs every 4 hours automatically. Each **new** hackathon is sent to Telegram as its own message (name, organizer, prize, deadline, category, apply link) and written to Notion. All jobs are configurable via Telegram — no code changes needed.

---

## HTTP API

The bot also runs an HTTP server (default port 3000):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/run?q=<query>` | POST | Trigger a search externally |

---

## Project Structure

```
seeka/
├── index.ts          # Entry point
├── src/
│   ├── bot.ts        # Telegram bot + commands
│   ├── searcher.ts   # Exa search (web + X/Twitter)
│   ├── scraper.ts    # Firecrawl detail extraction
│   ├── notion.ts     # Notion push + deduplication
│   ├── pipeline.ts   # Orchestration
│   ├── jobs.ts       # Cron job manager
│   └── types.ts      # TypeScript types
├── jobs.json         # Persisted cron jobs (auto-created)
├── .env              # Your API keys (not committed)
└── .env.example      # Template
```

---

## Industries Tracked

AI/ML · Web3/Blockchain · FinTech · HealthTech · Climate/GreenTech · Gaming · Cybersecurity · EdTech · Open Source/Dev Tools · Social Impact · Space/Deep Tech · Design/UX · Data Science · General/Multi-Track
