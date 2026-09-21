import { test, expect, beforeEach, afterEach } from "bun:test";
import { scrapeHackathonDetails } from "./scraper.js";

const originalFetch = globalThis.fetch;

function mockFirecrawl(markdown: string, metadata: Record<string, unknown> = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: true, data: { markdown, metadata } }), {
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.FIRECRAWL_API_KEY = "test";
  delete process.env.FIRESCRAPER_API_KEY;
});
afterEach(() => { globalThis.fetch = originalFetch; });

const page = `
[Skip to main content](#main) | [Log in](/login) | [Sign up](/signup)

We use cookies to improve your experience. Accept all cookies to continue.

![banner](https://cdn.example.com/banner.png)

# Accra AI Buildathon 2026

Build production-ready AI agents over one weekend with mentors from leading labs. Teams of up to four ship a working demo, and the best projects get fast-tracked into the accelerator programme.

Organized by: Lagos Labs, in collaboration with partners
Total prize pool: $50,000 USD across three tracks. Win 2 tickets to the finals.
Submission deadline: November 30, 2026
`;

test("extracts clean fields and drops nav/cookie boilerplate", async () => {
  mockFirecrawl(page, {
    title: "Accra AI Buildathon 2026 | Devpost",
    ogImage: "https://cdn.example.com/og.png",
  });
  const h = await scrapeHackathonDetails({ title: "fallback", url: "https://example.com/accra", text: "" });
  expect(h).not.toBeNull();
  expect(h!.name).toBe("Accra AI Buildathon 2026 | Devpost");
  expect(h!.description.startsWith("Build production-ready AI agents")).toBe(true);
  expect(h!.description).not.toContain("cookies");
  expect(h!.organizer).toBe("Lagos Labs");
  expect(h!.prizePool).toBe("$50,000");
  expect(h!.deadline).toBe("November 30, 2026");
  expect(h!.imageUrl).toBe("https://cdn.example.com/og.png");
});

test("X-origin results keep the post image, post title over login-wall titles, and source post", async () => {
  mockFirecrawl("Just a moment...", { title: "Log in to X / X" });
  const h = await scrapeHackathonDetails({
    title: "Solana Radar Hackathon is live",
    url: "https://solana.com/radar",
    text: "Solana Radar Hackathon is live. 400,000 USDC in prizes. Register by Oct 8, 2026",
    imageUrl: "https://pbs.twimg.com/media/x.jpg",
    sourceUrl: "https://x.com/solana/status/99",
    origin: "x",
  });
  expect(h!.name).toBe("Solana Radar Hackathon is live");
  expect(h!.imageUrl).toBe("https://pbs.twimg.com/media/x.jpg");
  expect(h!.sourceUrl).toBe("https://x.com/solana/status/99");
  expect(h!.source).toBe("x.com");
  expect(h!.prizePool).toBe("400,000 USDC");
});

test("does not invent a prize from unrelated small numbers", async () => {
  mockFirecrawl("Join our hackathon and win 2 free tickets. Register in 3 easy steps.", { title: "Fun Hack" });
  const h = await scrapeHackathonDetails({ title: "Fun Hack", url: "https://example.com/fun", text: "" });
  expect(h!.prizePool).toBeNull();
  expect(h!.organizer).toBeNull();
});
