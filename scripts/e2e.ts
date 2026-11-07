// Headless end-to-end: new owner -> faucet -> open allowance -> agent run over x402.
import { Keypair, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
const BASE = process.env.BASE ?? "http://127.0.0.1:4350";
const owner = Keypair.generate();
const post = async (p: string, b: any) => { const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error(p + " " + JSON.stringify(j)); return j; };
async function act(action: string, args: any) {
  const { txs } = await post("/api/tx", { owner: owner.publicKey.toBase58(), action, args });
  const signed = txs.map((t: string) => { const tx = Transaction.from(Buffer.from(t, "base64")); tx.partialSign(owner); return tx.serialize().toString("base64"); });
  return post("/api/submit", { txs: signed });
}
console.log("owner", owner.publicKey.toBase58());
console.log("faucet", (await post("/api/faucet", { owner: owner.publicKey.toBase58() })).url);
const merchants = { weather: 0.05, fx: 0.05, ticker: 0.05, wiki: 0.05, wire: 0.05, analyst: 0.2, dossier: 1 };
console.log("open", (await act("open", { perCall: 0.05, daily: 1, hours: 24, amount: 2, merchants })).urls);
const ts = Date.now();
const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(`kobo:run:${owner.publicKey.toBase58()}:${ts}`), owner.secretKey));
const prompt = process.argv[2] ?? "I'm in Lagos and holding 2 SOL. What's that worth in naira right now, and will it rain here this weekend? Also get me the premium dossier on Solana.";
const r = await fetch(BASE + "/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: owner.publicKey.toBase58(), prompt, ts, sig }) });
const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = "";
for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const line = chunk.split("\n").find((l) => l.startsWith("data:")); if (line) { const e = JSON.parse(line.slice(5)); console.log(e.type, JSON.stringify(e).slice(0, 200)); } } }
const st = await (await fetch(BASE + "/api/state?owner=" + owner.publicKey.toBase58())).json();
console.log("vault", st.allowance.vault, "spent", st.allowance.totalSpent, "calls", st.allowance.calls, "receipts", st.receipts.filter((x: any) => x.kind === "paid").length);
