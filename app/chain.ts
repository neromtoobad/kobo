// Shared Solana plumbing for the Kobo server: connection, keys, program client, PDAs.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "app/idl/kobo.json"), "utf8"));
export const PROGRAM_ID = new PublicKey(idl.address);
export const RPC = process.env.KOBO_RPC ?? "https://rpc.magicblock.app/devnet";
export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; // CAIP-2 id for Solana devnet
export const conn = new Connection(RPC, "confirmed");
export const DECIMALS = 6;

function loadKey(envName: string, file: string): Keypair {
  const raw = process.env[envName] ?? (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  if (!raw) throw new Error(`missing ${envName} (or ${file})`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/** Facilitator + sponsor: pays every network fee and rent, mints the test dollars. */
export const sponsor = loadKey("KOBO_SPONSOR_KEY", path.join(os.homedir(), ".kobo-deployer.json"));

export type Devnet = { mint: string; merchants: Record<string, string> };
const devnetFile = path.join(ROOT, "app/devnet.json");
export const devnet: Devnet = JSON.parse(process.env.KOBO_DEVNET_JSON ?? fs.readFileSync(devnetFile, "utf8"));
export const MINT = new PublicKey(devnet.mint);

/** Merchant payout wallets. Only public keys are needed to get paid. */
export const merchantWallet = (id: string) => new PublicKey(devnet.merchants[id]);

/** Each owner gets one agent key, derived from a server secret so nothing needs storing. */
const AGENT_SECRET = process.env.KOBO_AGENT_SECRET ?? "kobo-local-dev-secret";
export function agentFor(owner: PublicKey): Keypair {
  const seed = createHmac("sha256", AGENT_SECRET).update(owner.toBuffer()).digest();
  return Keypair.fromSeed(seed);
}

const wallet = new anchor.Wallet(sponsor);
export const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
export const program = new Program(idl as anchor.Idl, provider);

const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const allowancePda = (owner: PublicKey, agent: PublicKey) =>
  pda([Buffer.from("allowance"), owner.toBuffer(), agent.toBuffer()]);
export const vaultPda = (allowance: PublicKey) => pda([Buffer.from("vault"), allowance.toBuffer()]);
export const merchantPda = (allowance: PublicKey, wallet: PublicKey) =>
  pda([Buffer.from("merchant"), allowance.toBuffer(), wallet.toBuffer()]);
export const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner);

export const toUnits = (usd: number) => new BN(Math.round(usd * 10 ** DECIMALS));
export const fromUnits = (n: BN | number | bigint | string) => Number(n.toString()) / 10 ** DECIMALS;
export const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
