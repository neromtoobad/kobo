// One-time devnet setup: test-dollar mint + one payout wallet (and token account) per merchant.
// Usage: npx tsx scripts/setup.ts
import { Keypair } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import fs from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RPC = process.env.KOBO_RPC ?? "https://rpc.magicblock.app/devnet";
const conn = new Connection(RPC, "confirmed");
const sponsor = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".kobo-deployer.json"), "utf8"))),
);
const MERCHANTS = ["weather", "fx", "ticker", "wiki", "wire", "analyst", "dossier"];

const out = path.join(ROOT, "app/devnet.json");
const keysDir = path.join(ROOT, "app/.keys");
fs.mkdirSync(keysDir, { recursive: true });
const cur = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { merchants: {} };

if (!cur.mint) {
  const mint = await createMint(conn, sponsor, sponsor.publicKey, null, 6);
  cur.mint = mint.toBase58();
  console.log("mint", cur.mint);
}
for (const id of MERCHANTS) {
  if (cur.merchants[id]) continue;
  const kp = Keypair.generate();
  fs.writeFileSync(path.join(keysDir, `${id}.json`), JSON.stringify(Array.from(kp.secretKey)));
  await getOrCreateAssociatedTokenAccount(conn, sponsor, new (await import("@solana/web3.js")).PublicKey(cur.mint), kp.publicKey);
  cur.merchants[id] = kp.publicKey.toBase58();
  console.log("merchant", id, cur.merchants[id]);
}
fs.writeFileSync(out, JSON.stringify(cur, null, 2) + "\n");
console.log("wrote", out);
