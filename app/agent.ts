// The agent: Claude with paid tools. Every tool call is an HTTP request to a merchant that
// answers 402, gets paid from the owner's Kobo allowance, then returns the data.
import Anthropic from "@anthropic-ai/sdk";
import { Keypair } from "@solana/web3.js";
import { MERCHANTS, merchantById } from "./tools.js";
import { payingFetch } from "./x402.js";
import { explorer } from "./chain.js";

const client = new Anthropic();
export const MODEL = "claude-opus-5-5";
const MAX_TURNS = 8;

const SYSTEM = `You are a research agent running on a prepaid allowance called Kobo. Your owner funded it with a stablecoin on Solana and set limits: a cap per call, a cap per day and a budget per merchant.
Every tool is a separate paid API. Each call is charged to the allowance, and the price is in the tool description.
- Buy only the data you need to answer well. Prefer the cheaper tool when two would do.
- You may call several tools at once when they are independent.
- If a purchase is refused (for example over a cap, or the merchant is not allowed), do not retry the same purchase. Say briefly that the allowance refused it and why, then answer with what you have.
- Finish with a short, concrete answer for the owner (under 170 words). Name the sources you bought from in one line at the end, like: "Bought: Skyline Weather, Naira Desk FX".`;

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "note"; text: string }
  | { type: "call"; id: string; merchant: string; name: string; input: unknown; price: number }
  | { type: "402"; id: string; amount: number; payTo: string; reference: string }
  | { type: "signed"; id: string }
  | { type: "paid"; id: string; sig: string; url: string; ms: number; amount: number }
  | { type: "refused"; id: string; reason: string }
  | { type: "failed"; id: string; reason: string }
  | { type: "result"; id: string; preview: string }
  | { type: "error"; message: string }
  | { type: "done"; spent: number; calls: number; refused: number; turns: number };

export async function runAgent(prompt: string, agent: Keypair, base: string, emit: (e: AgentEvent) => void) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt.slice(0, 1500) }];
  const tools = MERCHANTS.map((m) => ({ ...m.tool, strict: true })) as Anthropic.Tool[];
  let spent = 0, calls = 0, refused = 0, turns = 0;

  for (; turns < MAX_TURNS; turns++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: "low" },
      tools,
      messages,
    } as any);
    messages.push({ role: "assistant", content: res.content });
    const midTurn = res.stop_reason === "tool_use";
    for (const b of res.content) if (b.type === "text" && b.text.trim()) emit({ type: midTurn ? "note" : "text", text: b.text });
    if (res.stop_reason === "refusal") {
      emit({ type: "error", message: "The model declined this request." });
      break;
    }
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) break;

    const results = await Promise.all(
      uses.map(async (u): Promise<Anthropic.ToolResultBlockParam> => {
        const m = merchantById(u.name);
        if (!m) return { type: "tool_result", tool_use_id: u.id, content: "unknown tool", is_error: true };
        emit({ type: "call", id: u.id, merchant: m.id, name: m.name, input: u.input, price: m.price });
        try {
          const r = await payingFetch(
            `${base}/tools/${m.id}`,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(u.input) },
            agent,
            (e) => {
              if (e.phase === "402") {
                const q: any = e.requirement;
                emit({ type: "402", id: u.id, amount: Number(q.amount) / 1e6, payTo: q.payTo, reference: q.extra.reference });
              } else if (e.phase === "signed") emit({ type: "signed", id: u.id });
            },
          );
          if (r.refused) {
            refused++;
            emit({ type: "refused", id: u.id, reason: r.refused });
            return { type: "tool_result", tool_use_id: u.id, content: `Payment refused by the allowance: ${r.refused}. Not charged.`, is_error: true };
          }
          if (r.status !== 200) {
            emit({ type: "failed", id: u.id, reason: r.body?.error ?? `HTTP ${r.status}` });
            return { type: "tool_result", tool_use_id: u.id, content: `Tool failed (not charged): ${r.body?.error ?? r.status}`, is_error: true };
          }
          const sig = r.receipt?.transaction ?? "";
          const amount = Number(r.requirement?.amount ?? 0) / 1e6;
          spent += amount;
          calls++;
          emit({ type: "paid", id: u.id, sig, url: explorer(sig), ms: r.receipt?.ms ?? 0, amount });
          const text = JSON.stringify(r.body?.data ?? r.body);
          emit({ type: "result", id: u.id, preview: text.slice(0, 220) });
          return { type: "tool_result", tool_use_id: u.id, content: text.slice(0, 12000) };
        } catch (err: any) {
          emit({ type: "failed", id: u.id, reason: String(err?.message ?? err) });
          return { type: "tool_result", tool_use_id: u.id, content: `Tool error: ${err?.message ?? err}`, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  emit({ type: "done", spent: Math.round(spent * 1e6) / 1e6, calls, refused, turns: turns + 1 });
}
