// x402 over a Kobo allowance.
//
// Flow (x402 v2 headers):
//   1. Client calls a paid route with no payment  -> 402 + PAYMENT-REQUIRED (base64 JSON).
//   2. Client builds a Kobo `pay` instruction for exactly the asked amount and the given
//      reference, sets the facilitator as fee payer, signs as the agent, and retries with
//      PAYMENT-SIGNATURE (base64 JSON carrying the partially signed transaction).
//   3. Facilitator verifies the transaction instruction by instruction, co-signs as fee
//      payer, simulates, sends, waits for confirmation, then the route runs and the
//      response carries PAYMENT-RESPONSE (base64 JSON with the signature).
// Scheme name: "kobo-allowance". The on-chain program enforces the owner's limits, so a
// tricked or buggy agent still cannot overspend: the facilitator just reports the refusal.
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createHash, randomBytes } from "node:crypto";
import { BN } from "@coral-xyz/anchor";
import {
  conn, sponsor, program, PROGRAM_ID, MINT, NETWORK, ata, allowancePda, vaultPda, merchantPda, DECIMALS,
} from "./chain.js";

export const SCHEME = "kobo-allowance";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

export type Requirement = {
  scheme: string;
  network: string;
  amount: string; // atomic units
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  extra: { program: string; feePayer: string; reference: string; decimals: number; merchant: string };
};
export type PaymentRequired = { x402Version: 2; error?: string; accepts: Requirement[] };
export type PaymentPayload = { x402Version: 2; scheme: string; network: string; payload: { transaction: string } };
export type PaymentResponse = { success: boolean; transaction?: string; network: string; payer?: string; errorReason?: string; ms?: number };

// Outstanding challenges: reference -> requirement. One settle per reference (replay guard).
const pending = new Map<string, { req: Requirement; at: number }>();
const used = new Set<string>();
setInterval(() => {
  const cut = Date.now() - 5 * 60_000;
  for (const [k, v] of pending) if (v.at < cut) pending.delete(k);
}, 60_000).unref();

export function challenge(opts: { merchant: string; payTo: PublicKey; price: number; resource: string; description: string; requestKey: string }): PaymentRequired {
  const nonce = randomBytes(16).toString("hex");
  const reference = createHash("sha256").update(`${opts.requestKey}\n${nonce}`).digest("hex");
  const req: Requirement = {
    scheme: SCHEME,
    network: NETWORK,
    amount: String(Math.round(opts.price * 10 ** DECIMALS)),
    asset: MINT.toBase58(),
    payTo: opts.payTo.toBase58(),
    resource: opts.resource,
    description: opts.description,
    maxTimeoutSeconds: 60,
    extra: { program: PROGRAM_ID.toBase58(), feePayer: sponsor.publicKey.toBase58(), reference, decimals: DECIMALS, merchant: opts.merchant },
  };
  pending.set(reference, { req, at: Date.now() });
  return { x402Version: 2, accepts: [req] };
}
export const encodeRequired = b64;

const ERR: Record<string, string> = {
  Paused: "allowance is paused by its owner",
  Expired: "allowance has expired",
  OverPerCallCap: "price is over the owner's per-call cap",
  OverDailyCap: "would go over today's cap",
  OverMerchantBudget: "would go over this merchant's budget",
  AccountNotInitialized: "merchant is not on the owner's allow-list",
  InsufficientFunds: "vault is empty",
  "insufficient funds": "vault is empty",
};
export function reason(logs: string[] | null | undefined, fallback = "payment refused"): string {
  const s = (logs ?? []).join("\n");
  for (const k of Object.keys(ERR)) if (s.includes(k)) return ERR[k];
  return fallback;
}

const PAY_DISC = Buffer.from((program.idl.instructions.find((i) => i.name === "pay") as any).discriminator);

export class Refused extends Error {}

/**
 * Verify, co-sign and simulate the payment, run `work`, and only then send the payment.
 * If `work` throws, nothing is sent: the agent is never charged for a failed call.
 */
export async function settle<T>(header: string, work: (req: Requirement) => Promise<T>): Promise<{ sig: string; req: Requirement; ms: number; agent: string; data: T }> {
  const t0 = Date.now();
  const p = unb64<PaymentPayload>(header);
  if (p.scheme !== SCHEME || p.network !== NETWORK) throw new Error("unsupported scheme or network");
  const tx = Transaction.from(Buffer.from(p.payload.transaction, "base64"));
  if (!tx.feePayer?.equals(sponsor.publicKey)) throw new Error("fee payer must be the facilitator");

  // Only compute-budget instructions and exactly one Kobo `pay` are allowed: the sponsor
  // signs as fee payer, so nothing else may touch its account.
  const pays = tx.instructions.filter((ix) => ix.programId.equals(PROGRAM_ID));
  const others = tx.instructions.filter((ix) => !ix.programId.equals(PROGRAM_ID) && !ix.programId.equals(ComputeBudgetProgram.programId));
  if (pays.length !== 1 || others.length) throw new Error("transaction must hold exactly one Kobo pay instruction");
  const ix = pays[0];
  if (!Buffer.from(ix.data.subarray(0, 8)).equals(PAY_DISC)) throw new Error("not a pay instruction");
  const amount = new BN(ix.data.subarray(8, 16), "le");
  const reference = Buffer.from(ix.data.subarray(16, 48)).toString("hex");
  const open = pending.get(reference);
  if (!open || used.has(reference)) throw new Error("unknown or already used payment reference");
  const req = open.req;
  if (amount.toString() !== req.amount) throw new Error("amount does not match the price");

  // Accounts: agent, allowance, vault, merchant, merchant_token, token_program, ata_program
  const k = ix.keys.map((x) => x.pubkey);
  const agent = k[0];
  const payTo = new PublicKey(req.payTo);
  if (k[0].equals(sponsor.publicKey) || ix.keys.some((x) => x.pubkey.equals(sponsor.publicKey))) throw new Error("facilitator cannot appear in the instruction");
  if (!k[4].equals(ata(payTo))) throw new Error("payment does not go to the merchant");
  // allowance/vault/merchant PDAs are re-derived from the allowance account's owner
  const a: any = await program.account.allowance.fetchNullable(k[1]);
  if (!a) throw new Error("no allowance for this agent");
  if (!a.agent.equals(agent) || !allowancePda(a.owner, agent).equals(k[1]) || !vaultPda(k[1]).equals(k[2]) || !merchantPda(k[1], payTo).equals(k[3]))
    throw new Error("instruction accounts do not match the allowance");
  if (!tx.signatures.find((s) => s.publicKey.equals(agent))?.signature) throw new Error("agent signature missing");

  used.add(reference);
  tx.partialSign(sponsor);
  if (!tx.verifySignatures()) {
    used.delete(reference);
    throw new Error("bad signatures");
  }
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    used.delete(reference);
    pending.delete(reference);
    throw new Refused(reason(sim.value.logs));
  }
  let data: T;
  try {
    data = await work(req);
  } catch (e) {
    used.delete(reference); // not charged; the same challenge may be retried
    throw e;
  }
  const t1 = Date.now();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const done = await conn.confirmTransaction(sig, "confirmed");
  if (done.value.err) throw new Refused(reason(null, "payment failed on chain"));
  pending.delete(reference);
  return { sig, req, ms: Date.now() - t1, agent: agent.toBase58(), data };
}

export const encodeResponse = b64;

// ---------- client side (the agent's wallet) ----------

export type PaidResult = {
  status: number;
  body: any;
  requirement?: Requirement;
  receipt?: PaymentResponse;
  refused?: string;
};

/** fetch that answers a 402 by paying from the agent's Kobo allowance. */
export async function payingFetch(url: string, init: RequestInit, agent: Keypair, onEvent?: (e: { phase: string; [k: string]: unknown }) => void): Promise<PaidResult> {
  const first = await fetch(url, init);
  if (first.status !== 402) return { status: first.status, body: await first.json().catch(() => null) };
  const hdr = first.headers.get("PAYMENT-REQUIRED");
  const required: PaymentRequired = hdr ? unb64(hdr) : await first.json();
  const req = required.accepts.find((r) => r.scheme === SCHEME && r.network === NETWORK);
  if (!req) return { status: 402, body: required, refused: "no supported payment option" };
  onEvent?.({ phase: "402", requirement: req });

  const owner = await ownerOf(agent.publicKey);
  if (!owner) return { status: 402, body: required, requirement: req, refused: "this agent has no allowance yet" };
  const allowance = allowancePda(owner, agent.publicKey);
  const payTo = new PublicKey(req.payTo);
  const ix = await program.methods
    .pay(new BN(req.amount), Array.from(Buffer.from(req.extra.reference, "hex")))
    .accountsPartial({
      agent: agent.publicKey,
      allowance,
      vault: vaultPda(allowance),
      merchant: merchantPda(allowance, payTo),
      merchantToken: ata(payTo),
    })
    .instruction();
  const tx = new Transaction().add(ix);
  tx.feePayer = new PublicKey(req.extra.feePayer);
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(agent);
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: SCHEME,
    network: NETWORK,
    payload: { transaction: tx.serialize({ requireAllSignatures: false }).toString("base64") },
  };
  onEvent?.({ phase: "signed" });
  const second = await fetch(url, { ...init, headers: { ...(init.headers as any), "PAYMENT-SIGNATURE": b64(payload) } });
  const rh = second.headers.get("PAYMENT-RESPONSE");
  const receipt: PaymentResponse | undefined = rh ? unb64(rh) : undefined;
  const body = await second.json().catch(() => null);
  if (second.status === 402) return { status: 402, body, requirement: req, receipt, refused: receipt?.errorReason ?? body?.error ?? "payment refused" };
  return { status: second.status, body, requirement: req, receipt };
}

// agent -> owner lookup (Allowance.agent is at offset 8 + 32)
const ownerCache = new Map<string, PublicKey>();
export async function ownerOf(agent: PublicKey): Promise<PublicKey | null> {
  const hit = ownerCache.get(agent.toBase58());
  if (hit) return hit;
  const found = await program.account.allowance.all([{ memcmp: { offset: 8 + 32, bytes: agent.toBase58() } }]);
  if (!found.length) return null;
  const o = (found[0].account as any).owner as PublicKey;
  ownerCache.set(agent.toBase58(), o);
  return o;
}
export function rememberOwner(agent: PublicKey, owner: PublicKey) {
  ownerCache.set(agent.toBase58(), owner);
}
