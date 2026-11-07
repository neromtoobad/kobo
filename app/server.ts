// Kobo server: facilitator + merchants (x402 paid tools) + agent runner + owner tx builder + web.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAccount,
} from "@solana/spl-token";
import { BN, EventParser } from "@coral-xyz/anchor";
import nacl from "tweetnacl";
import bs58 from "bs58";
import path from "node:path";
import {
  conn, sponsor, program, PROGRAM_ID, MINT, NETWORK, RPC, ata, agentFor, allowancePda, vaultPda, merchantPda,
  merchantWallet, devnet, toUnits, fromUnits, explorer, explorerAddr, ROOT,
} from "./chain.js";
import { MERCHANTS, merchantById } from "./tools.js";
import { challenge, encodeRequired, encodeResponse, settle, Refused, rememberOwner } from "./x402.js";
import { runAgent, MODEL } from "./agent.js";

const PORT = Number(process.env.PORT ?? 4350);
const BASE = `http://127.0.0.1:${PORT}`;
const app = new Hono();

// ---------- tiny rate limiter ----------
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return true;
  arr.push(now);
  hits.set(key, arr);
  return false;
}
const ipOf = (c: any) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
const pk = (s: unknown) => {
  try {
    return new PublicKey(String(s));
  } catch {
    return null;
  }
};

// ---------- config ----------
app.get("/api/config", (c) =>
  c.json({
    program: PROGRAM_ID.toBase58(),
    mint: MINT.toBase58(),
    sponsor: sponsor.publicKey.toBase58(),
    network: NETWORK,
    rpc: RPC,
    model: MODEL,
    merchants: MERCHANTS.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb, price: m.price, wallet: devnet.merchants[m.id] })),
  }),
);

// ---------- the merchants: x402 paid endpoints ----------
app.get("/tools", (c) =>
  c.json({ x402: true, scheme: "kobo-allowance", network: NETWORK, tools: MERCHANTS.map((m) => ({ id: m.id, name: m.name, price: m.price, path: `/tools/${m.id}`, input: m.tool.input_schema })) }),
);
app.post("/tools/:id", async (c) => {
  const m = merchantById(c.req.param("id"));
  if (!m) return c.json({ error: "no such tool" }, 404);
  const input = await c.req.json().catch(() => ({}));
  const pay = c.req.header("PAYMENT-SIGNATURE");
  if (!pay) {
    const required = challenge({
      merchant: m.id,
      payTo: merchantWallet(m.id),
      price: m.price,
      resource: `${new URL(c.req.url).origin}/tools/${m.id}`,
      description: `${m.name}: ${m.blurb}`,
      requestKey: `POST /tools/${m.id}\n${JSON.stringify(input)}`,
    });
    c.header("PAYMENT-REQUIRED", encodeRequired(required));
    return c.json({ ...required, error: "payment required" }, 402);
  }
  try {
    const r = await settle(pay, () => m.run(input));
    c.header("PAYMENT-RESPONSE", encodeResponse({ success: true, transaction: r.sig, network: NETWORK, payer: r.agent, ms: r.ms }));
    return c.json({ data: r.data, receipt: { tx: r.sig, url: explorer(r.sig), amount: m.price } });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (e instanceof Refused || /reference|allowance|instruction|signature|amount|merchant|scheme|fee payer/.test(msg)) {
      c.header("PAYMENT-RESPONSE", encodeResponse({ success: false, network: NETWORK, errorReason: msg }));
      return c.json({ error: msg }, 402);
    }
    return c.json({ error: `tool failed, not charged: ${msg}` }, 502);
  }
});

// ---------- faucet: test dollars for a new owner ----------
app.post("/api/faucet", async (c) => {
  const { owner } = await c.req.json().catch(() => ({}));
  const o = pk(owner);
  if (!o) return c.json({ error: "bad owner" }, 400);
  if (limited(`faucet:${o}`, 3, 86_400_000) || limited(`faucetip:${ipOf(c)}`, 10, 86_400_000)) return c.json({ error: "faucet limit reached for today" }, 429);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(sponsor.publicKey, ata(o), o, MINT),
    createMintToInstruction(MINT, ata(o), sponsor.publicKey, 5_000_000),
  );
  const sig = await conn.sendTransaction(tx, [sponsor]);
  await conn.confirmTransaction(sig, "confirmed");
  return c.json({ sig, url: explorer(sig), amount: 5 });
});

// ---------- owner transactions: server builds + co-signs as fee payer, browser signs as owner ----------
async function ownerTx(owner: PublicKey, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = sponsor.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(sponsor);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

app.post("/api/tx", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const owner = pk(body.owner);
  if (!owner) return c.json({ error: "bad owner" }, 400);
  if (limited(`tx:${owner}`, 40, 3_600_000)) return c.json({ error: "slow down" }, 429);
  const agent = agentFor(owner).publicKey;
  const allowance = allowancePda(owner, agent);
  const vault = vaultPda(allowance);
  const ownerToken = ata(owner);
  const a = body.args ?? {};
  const txs: string[] = [];
  const merchantIx = (id: string, budget: number) =>
    program.methods.setMerchant(toUnits(budget))
      .accountsPartial({ payer: sponsor.publicKey, owner, allowance, merchantWallet: merchantWallet(id) })
      .instruction();
  try {
    switch (body.action) {
      case "open": {
        const perCall = Math.min(Math.max(Number(a.perCall) || 0.05, 0.001), 5);
        const daily = Math.min(Math.max(Number(a.daily) || 1, perCall), 50);
        const hours = Math.min(Math.max(Number(a.hours) || 24, 1), 24 * 30);
        const amount = Math.min(Math.max(Number(a.amount) || 0, 0), 100);
        const budgets: Record<string, number> = a.merchants ?? {};
        const open = await program.methods
          .open(agent, toUnits(perCall), toUnits(daily), new BN(Math.floor(Date.now() / 1000) + hours * 3600), toUnits(amount))
          .accountsPartial({ payer: sponsor.publicKey, owner, mint: MINT, allowance, vault, ownerToken })
          .instruction();
        const ids = Object.keys(budgets).filter((id) => merchantById(id) && budgets[id] > 0);
        const first = ids.slice(0, 3), rest = ids.slice(3);
        txs.push(await ownerTx(owner, [open, ...(await Promise.all(first.map((id) => merchantIx(id, budgets[id]))))]));
        for (let i = 0; i < rest.length; i += 4)
          txs.push(await ownerTx(owner, await Promise.all(rest.slice(i, i + 4).map((id) => merchantIx(id, budgets[id])))));
        rememberOwner(agent, owner);
        break;
      }
      case "merchant": {
        if (!merchantById(a.id)) return c.json({ error: "no such merchant" }, 400);
        txs.push(await ownerTx(owner, [await merchantIx(a.id, Math.max(0, Number(a.budget) || 0))]));
        break;
      }
      case "pause":
        txs.push(await ownerTx(owner, [await program.methods.setPaused(!!a.paused).accountsPartial({ owner, allowance }).instruction()]));
        break;
      case "limits": {
        const perCall = Math.max(Number(a.perCall) || 0.001, 0.000001);
        const daily = Math.max(Number(a.daily) || perCall, perCall);
        const cur: any = await program.account.allowance.fetch(allowance);
        txs.push(await ownerTx(owner, [await program.methods.setLimits(toUnits(perCall), toUnits(daily), cur.expiresAt).accountsPartial({ owner, allowance }).instruction()]));
        break;
      }
      case "topup":
      case "withdraw": {
        const amt = toUnits(Math.max(0, Number(a.amount) || 0));
        const m = body.action === "topup" ? program.methods.topUp(amt) : program.methods.withdraw(amt);
        txs.push(await ownerTx(owner, [await m.accountsPartial({ owner, allowance, vault, ownerToken }).instruction()]));
        break;
      }
      case "close":
        txs.push(await ownerTx(owner, [await program.methods.close().accountsPartial({ owner, allowance, vault, ownerToken, rentTo: sponsor.publicKey }).instruction()]));
        break;
      default:
        return c.json({ error: "unknown action" }, 400);
    }
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 400);
  }
  return c.json({ txs });
});

// Relay owner-signed txs. The sponsor signature already binds the message, so these
// cannot be altered; we only check they are fully signed.
app.post("/api/submit", async (c) => {
  const { txs } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(txs) || !txs.length || txs.length > 4) return c.json({ error: "bad txs" }, 400);
  const sigs: string[] = [];
  for (const t of txs) {
    const tx = Transaction.from(Buffer.from(String(t), "base64"));
    if (!tx.feePayer?.equals(sponsor.publicKey) || !tx.verifySignatures()) return c.json({ error: "bad signature" }, 400);
    if (!tx.instructions.every((ix) => ix.programId.equals(PROGRAM_ID))) return c.json({ error: "foreign instruction" }, 400);
    try {
      const sig = await conn.sendRawTransaction(tx.serialize());
      const r = await conn.confirmTransaction(sig, "confirmed");
      if (r.value.err) return c.json({ error: "failed on chain", sigs }, 400);
      sigs.push(sig);
    } catch (e: any) {
      return c.json({ error: String(e?.transactionMessage ?? e?.message ?? e).slice(0, 300), sigs }, 400);
    }
  }
  return c.json({ sigs, urls: sigs.map(explorer) });
});

// ---------- state: everything read straight from chain ----------
const parser = new EventParser(PROGRAM_ID, program.coder);
const receiptCache = new Map<string, any>(); // signature -> parsed receipt (immutable once confirmed)
const nameByWallet = Object.fromEntries(MERCHANTS.map((m) => [devnet.merchants[m.id], m]));

async function receipts(allowance: PublicKey, limit = 30) {
  const sigs = (await conn.getSignaturesForAddress(allowance, { limit }, "confirmed")).sort((a, b) => (b.slot - a.slot) || ((b.blockTime ?? 0) - (a.blockTime ?? 0)));
  const todo = sigs.filter((s) => !s.err && !receiptCache.has(s.signature)).map((s) => s.signature);
  for (let i = 0; i < todo.length; i += 10) {
    const txs = await conn.getTransactions(todo.slice(i, i + 10), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    txs.forEach((t, j) => {
      const sig = todo[i + j];
      const evs = t?.meta?.logMessages ? [...parser.parseLogs(t.meta.logMessages)] : [];
      receiptCache.set(sig, { evs: evs.map((e) => ({ name: e.name, data: e.data })), time: t?.blockTime ?? 0, fee: t?.meta?.fee ?? 0 });
    });
  }
  const out: any[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const r = receiptCache.get(s.signature);
    for (const e of r?.evs ?? []) {
      const d: any = e.data;
      if (e.name === "paid") {
        const m = nameByWallet[d.merchant.toBase58()];
        out.push({ kind: "paid", sig: s.signature, url: explorer(s.signature), time: r.time, fee: r.fee, merchant: m?.id ?? d.merchant.toBase58(), name: m?.name ?? "unknown", amount: fromUnits(d.amount), call: Number(d.call), reference: Buffer.from(d.reference).toString("hex") });
      } else {
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(d)) data[k] = v instanceof PublicKey ? v.toBase58() : BN.isBN(v) ? (v as BN).toString() : v;
        out.push({ kind: e.name, sig: s.signature, url: explorer(s.signature), time: r.time, data });
      }
    }
  }
  return out.sort((a, b) => (b.time - a.time) || ((b.call ?? 0) - (a.call ?? 0)));
}

app.get("/api/state", async (c) => {
  const owner = pk(c.req.query("owner"));
  if (!owner) return c.json({ error: "bad owner" }, 400);
  const agent = agentFor(owner).publicKey;
  const allowance = allowancePda(owner, agent);
  const [a, ownerBal] = await Promise.all([
    program.account.allowance.fetchNullable(allowance) as Promise<any>,
    getAccount(conn, ata(owner)).then((x) => fromUnits(x.amount)).catch(() => 0),
  ]);
  if (!a) return c.json({ owner: owner.toBase58(), agent: agent.toBase58(), ownerBalance: ownerBal, allowance: null });
  rememberOwner(agent, owner);
  const mPdas = MERCHANTS.map((m) => merchantPda(allowance, merchantWallet(m.id)));
  const [vaultBal, mAccs, recs] = await Promise.all([
    getAccount(conn, vaultPda(allowance)).then((x) => fromUnits(x.amount)).catch(() => 0),
    program.account.merchant.fetchMultiple(mPdas) as Promise<any[]>,
    receipts(allowance),
  ]);
  const today = Math.floor(Date.now() / 1000 / 86400);
  return c.json({
    owner: owner.toBase58(),
    agent: agent.toBase58(),
    ownerBalance: ownerBal,
    allowance: {
      address: allowance.toBase58(),
      url: explorerAddr(allowance.toBase58()),
      vault: vaultBal,
      perCall: fromUnits(a.perCallCap),
      daily: fromUnits(a.dailyCap),
      spentToday: Number(a.day) === today ? fromUnits(a.spentToday) : 0,
      totalSpent: fromUnits(a.totalSpent),
      calls: Number(a.calls),
      paused: a.paused,
      expiresAt: Number(a.expiresAt),
    },
    merchants: MERCHANTS.map((m, i) => ({
      id: m.id,
      name: m.name,
      price: m.price,
      listed: !!mAccs[i],
      budget: mAccs[i] ? fromUnits(mAccs[i].budget) : 0,
      spent: mAccs[i] ? fromUnits(mAccs[i].spent) : 0,
      calls: mAccs[i] ? Number(mAccs[i].calls) : 0,
    })),
    receipts: recs,
  });
});

// ---------- run the agent (owner proves it is them with a signed message) ----------
let runsToday = { day: 0, n: 0 };
app.post("/api/run", async (c) => {
  const { owner, prompt, ts, sig } = await c.req.json().catch(() => ({}));
  const o = pk(owner);
  if (!o || typeof prompt !== "string" || !prompt.trim()) return c.json({ error: "bad request" }, 400);
  const msg = new TextEncoder().encode(`kobo:run:${o.toBase58()}:${ts}`);
  let ok = false;
  try {
    ok = Math.abs(Date.now() - Number(ts)) < 5 * 60_000 && nacl.sign.detached.verify(msg, bs58.decode(String(sig)), o.toBytes());
  } catch {}
  if (!ok) return c.json({ error: "owner signature invalid" }, 401);
  const day = Math.floor(Date.now() / 86_400_000);
  if (runsToday.day !== day) runsToday = { day, n: 0 };
  if (runsToday.n >= Number(process.env.KOBO_MAX_RUNS_PER_DAY ?? 400)) return c.json({ error: "demo is at its daily run limit" }, 429);
  if (limited(`run:${o}`, 25, 86_400_000) || limited(`runip:${ipOf(c)}`, 40, 86_400_000)) return c.json({ error: "run limit reached for today" }, 429);
  runsToday.n++;
  const agent = agentFor(o);
  return streamSSE(c, async (s) => {
    let chain: Promise<unknown> = Promise.resolve();
    const send = (e: unknown) => (chain = chain.then(() => s.writeSSE({ data: JSON.stringify(e) })));
    try {
      await runAgent(prompt, agent, BASE, send);
    } catch (e: any) {
      send({ type: "error", message: String(e?.message ?? e).slice(0, 300) });
    }
    await chain;
  });
});

app.get("/health", (c) => c.json({ ok: true }));
app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(ROOT, "app/web")) || "." }));

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, () => console.log(`kobo on :${PORT}  sponsor ${sponsor.publicKey.toBase58()}`));
