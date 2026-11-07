// The merchants: small paid APIs, each with its own payout wallet and price per call.
// They wrap free public data sources; the point is that each call is bought, per call.
import Anthropic from "@anthropic-ai/sdk";

export type Merchant = {
  id: string;
  name: string;
  blurb: string;
  price: number; // USD per call
  tool: Anthropic.Tool; // what the agent sees
  run: (input: any) => Promise<unknown>;
};

const UA = { "user-agent": "kobo-hackathon-demo/1.0" };
async function getJson(url: string, tries = 2): Promise<any> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return await r.json();
  } catch (e) {
    if (tries > 1) return getJson(url, tries - 1);
    throw e;
  }
}
const str = (v: unknown, max = 120) => String(v ?? "").slice(0, max).trim();

const anthropic = new Anthropic();

export const MERCHANTS: Merchant[] = [
  {
    id: "weather",
    name: "Skyline Weather",
    blurb: "Current weather + 3-day forecast for any city",
    price: 0.002,
    tool: {
      name: "weather",
      description: "Current weather and a 3-day forecast for a city. Costs $0.002 per call.",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
    },
    async run({ city }) {
      const g: any = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(str(city, 60))}`);
      const p = g.results?.[0];
      if (!p) return { error: `no city called ${city}` };
      const w: any = await getJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto`,
      );
      return { place: `${p.name}, ${p.country}`, current: w.current, daily: w.daily };
    },
  },
  {
    id: "fx",
    name: "Naira Desk FX",
    blurb: "Live exchange rates, NGN and 160 others",
    price: 0.001,
    tool: {
      name: "fx",
      description: "Exchange rates from one currency to others, e.g. base USD to NGN, GHS, KES. Costs $0.001 per call.",
      input_schema: {
        type: "object",
        properties: { base: { type: "string", description: "ISO code, e.g. USD" }, symbols: { type: "array", items: { type: "string" } } },
        required: ["base", "symbols"],
        additionalProperties: false,
      },
    },
    async run({ base, symbols }) {
      const d: any = await getJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(str(base, 3).toUpperCase())}`);
      const rates: Record<string, number> = {};
      for (const s of (symbols ?? []).slice(0, 12)) rates[String(s).toUpperCase()] = d.rates?.[String(s).toUpperCase()];
      return { base: d.base_code, updated: d.time_last_update_utc, rates };
    },
  },
  {
    id: "ticker",
    name: "Ticker",
    blurb: "Spot crypto prices",
    price: 0.001,
    tool: {
      name: "ticker",
      description: "Spot price of a crypto asset in USD, e.g. SOL, BTC, ETH. Costs $0.001 per call.",
      input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    },
    async run({ symbol }) {
      const s = str(symbol, 10).toUpperCase();
      try {
        const d: any = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(s === "BTC" ? "XBT" : s)}USD`);
        const t: any = Object.values(d.result ?? {})[0];
        if (t?.c?.[0]) return { symbol: s, usd: Number(t.c[0]), change24hOpen: Number(t.o), source: "Kraken", at: new Date().toISOString() };
      } catch {}
      const ids: Record<string, string> = { SOL: "solana", BTC: "bitcoin", ETH: "ethereum", USDC: "usd-coin", BONK: "bonk", JUP: "jupiter-exchange-solana" };
      const id = ids[s] ?? s.toLowerCase();
      const g: any = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`);
      if (!g[id]?.usd) return { error: `no price for ${s}` };
      return { symbol: s, usd: g[id].usd, source: "CoinGecko", at: new Date().toISOString() };
    },
  },
  {
    id: "wiki",
    name: "Encyclo",
    blurb: "Encyclopedia summaries",
    price: 0.002,
    tool: {
      name: "wiki",
      description: "Short encyclopedia summary of a topic, person or place. Costs $0.002 per call.",
      input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false },
    },
    async run({ topic }) {
      const s: any = await getJson(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=${encodeURIComponent(str(topic, 100))}`,
      );
      const title = s.query?.search?.[0]?.title;
      if (!title) return { error: `nothing found for ${topic}` };
      const d: any = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
      return { title: d.title, summary: d.extract, url: d.content_urls?.desktop?.page };
    },
  },
  {
    id: "wire",
    name: "Wire",
    blurb: "Latest tech headlines on a topic",
    price: 0.003,
    tool: {
      name: "wire",
      description: "The most recent tech/news headlines about a topic (last ~30 days). Costs $0.003 per call.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    },
    async run({ query }) {
      const since = Math.floor(Date.now() / 1000) - 30 * 86400;
      const d: any = await getJson(
        `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=8&numericFilters=created_at_i%3E${since}&query=${encodeURIComponent(str(query, 80))}`,
      );
      return {
        query,
        headlines: (d.hits ?? []).map((h: any) => ({ title: h.title, url: h.url, points: h.points, date: h.created_at?.slice(0, 10) })),
      };
    },
  },
  {
    id: "analyst",
    name: "Second Opinion",
    blurb: "A second model critiques a draft answer",
    price: 0.02,
    tool: {
      name: "analyst",
      description:
        "Send a draft conclusion plus the facts behind it; a separate analyst model checks it for errors and missing caveats. Costs $0.02 per call.",
      input_schema: {
        type: "object",
        properties: { draft: { type: "string" }, facts: { type: "string" } },
        required: ["draft", "facts"],
        additionalProperties: false,
      },
    },
    async run({ draft, facts }) {
      const r = await anthropic.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 1200,
        output_config: { effort: "low" },
        system: "You are a blunt fact-checker. In at most 5 short bullet points, say what is wrong, unsupported or missing in the draft given the facts. No preamble.",
        messages: [{ role: "user", content: `FACTS:\n${str(facts, 6000)}\n\nDRAFT:\n${str(draft, 3000)}` }],
      } as any);
      const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      return { review: text };
    },
  },
  {
    id: "dossier",
    name: "Dossier Pro",
    blurb: "Premium bundled briefing (pricey on purpose)",
    price: 0.25,
    tool: {
      name: "dossier",
      description: "Premium all-in-one briefing on a topic: encyclopedia summary plus latest headlines in one call. Costs $0.25 per call.",
      input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false },
    },
    async run({ topic }) {
      const [w, n] = await Promise.all([MERCHANTS[3].run({ topic }), MERCHANTS[4].run({ query: topic })]);
      return { topic, background: w, news: n };
    },
  },
];

export const merchantById = (id: string) => MERCHANTS.find((m) => m.id === id);
