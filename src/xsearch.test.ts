import { test, expect, beforeEach, afterEach } from "bun:test";
import { searchX } from "./xsearch.js";

const originalFetch = globalThis.fetch;
let lastUrl = "";

const sample = {
  data: [
    {
      id: "1",
      author_id: "u1",
      created_at: "2026-09-20T10:00:00Z",
      text: "🔥 ETHGlobal Accra Hackathon\n$50,000 in prizes\nApply now https://t.co/abc https://t.co/pic",
      attachments: { media_keys: ["m1"] },
      entities: {
        urls: [
          { url: "https://t.co/abc", expanded_url: "https://ethglobal.com/events/accra?utm_source=x" },
          { url: "https://t.co/pic", expanded_url: "https://x.com/ethglobal/status/1/photo/1" },
        ],
      },
    },
    { id: "2", author_id: "u1", text: "no links here", entities: { urls: [] } },
  ],
  includes: {
    media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/img.jpg" }],
    users: [{ id: "u1", username: "ethglobal", name: "ETHGlobal" }],
  },
  meta: { newest_id: "2", result_count: 2 },
};

beforeEach(() => {
  process.env.X_BEARER_TOKEN = "test-token";
  globalThis.fetch = (async (input: string | URL | Request) => {
    lastUrl = String(input);
    return new Response(JSON.stringify(sample), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.X_BEARER_TOKEN;
});

test("maps posts to linked-page results with image + source post", async () => {
  const results = await searchX(["hackathon has:links"]);
  const linked = results.find((r) => r.url.startsWith("https://ethglobal.com"));
  expect(linked).toBeDefined();
  expect(linked!.imageUrl).toBe("https://pbs.twimg.com/media/img.jpg");
  expect(linked!.sourceUrl).toBe("https://x.com/ethglobal/status/1");
  expect(linked!.origin).toBe("x");
  expect(linked!.title).toBe("ETHGlobal Accra Hackathon");
  expect(linked!.text).not.toContain("t.co");

  // x.com media links are not treated as event pages
  expect(results.some((r) => r.url.includes("/photo/1"))).toBe(false);
  // link-less posts still surface as the post itself
  expect(results.some((r) => r.url === "https://x.com/ethglobal/status/2")).toBe(true);
});

test("requests media expansions and persists since_id for the next run", async () => {
  await searchX(["cursor-test-query has:links"]);
  const first = new URL(lastUrl);
  expect(first.searchParams.get("expansions")).toContain("attachments.media_keys");
  expect(first.searchParams.get("media.fields")).toContain("url");

  await searchX(["cursor-test-query has:links"]);
  expect(new URL(lastUrl).searchParams.get("since_id")).toBe("2");
});

test("returns nothing when X is not configured", async () => {
  delete process.env.X_BEARER_TOKEN;
  expect(await searchX(["hackathon"])).toEqual([]);
});
