import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
const idl = JSON.parse(require("fs").readFileSync(__dirname + "/../target/idl/kobo.json", "utf8"));
import type { Kobo } from "../target/types/kobo";

const usd = (n: number) => new BN(Math.round(n * 1e6));

describe("kobo", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program<Kobo>(idl as any, provider);
  const conn = provider.connection;
  const sponsor = (provider.wallet as anchor.Wallet).payer; // facilitator: pays rent + fees

  const owner = Keypair.generate();
  const agent = Keypair.generate(); // never funded with SOL
  const weather = Keypair.generate();
  const oracle = Keypair.generate();
  const stranger = Keypair.generate();
  let mint: PublicKey;
  let ownerToken: PublicKey;
  let allowance: PublicKey;
  let vault: PublicKey;

  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const merchantPda = (w: PublicKey) => pda([Buffer.from("merchant"), allowance.toBuffer(), w.toBuffer()]);

  async function pay(merchant: PublicKey, amount: BN, ref = new Uint8Array(32).fill(7)) {
    // agent signs, sponsor pays the fee: the same shape the x402 facilitator co-signs
    const ix = await program.methods
      .pay(amount, Array.from(ref))
      .accountsPartial({
        agent: agent.publicKey,
        allowance,
        vault,
        merchant: merchantPda(merchant),
        merchantToken: getAssociatedTokenAddressSync(mint, merchant),
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = sponsor.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.partialSign(agent);
    tx.partialSign(sponsor);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  }

  async function expectFail(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const s = String(e?.message ?? e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? "");
      expect(s).to.contain(code);
      return;
    }
    throw new Error(`expected ${code}`);
  }

  before(async () => {
    const sig = await conn.requestAirdrop(owner.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    mint = await createMint(conn, sponsor, sponsor.publicKey, null, 6);
    ownerToken = (await getOrCreateAssociatedTokenAccount(conn, sponsor, mint, owner.publicKey)).address;
    await mintTo(conn, sponsor, mint, ownerToken, sponsor, 20_000_000);
    for (const m of [weather, oracle, stranger]) await getOrCreateAssociatedTokenAccount(conn, sponsor, mint, m.publicKey);
    allowance = pda([Buffer.from("allowance"), owner.publicKey.toBuffer(), agent.publicKey.toBuffer()]);
    vault = pda([Buffer.from("vault"), allowance.toBuffer()]);
  });

  it("opens an allowance funded with $5, rent paid by the sponsor", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await program.methods
      .open(agent.publicKey, usd(0.05), usd(0.2), new BN(expires), usd(5))
      .accountsPartial({ payer: sponsor.publicKey, owner: owner.publicKey, mint, allowance, vault, ownerToken })
      .signers([owner])
      .rpc();
    const a = await program.account.allowance.fetch(allowance);
    expect(a.agent.toBase58()).to.eq(agent.publicKey.toBase58());
    expect((await getAccount(conn, vault)).amount).to.eq(5_000_000n);
  });

  it("lists two merchants with budgets", async () => {
    for (const [m, b] of [[weather, 0.1], [oracle, 1]] as const) {
      await program.methods
        .setMerchant(usd(b))
        .accountsPartial({ payer: sponsor.publicKey, owner: owner.publicKey, allowance, merchantWallet: m.publicKey })
        .signers([owner])
        .rpc();
    }
    expect((await program.account.allowance.fetch(allowance)).merchants).to.eq(2);
  });

  it("agent with zero SOL pays a merchant; merchant receives exactly the amount", async () => {
    expect(await conn.getBalance(agent.publicKey)).to.eq(0);
    await pay(weather.publicKey, usd(0.01));
    const got = await getAccount(conn, getAssociatedTokenAddressSync(mint, weather.publicKey));
    expect(got.amount).to.eq(10_000n);
    const a = await program.account.allowance.fetch(allowance);
    expect(a.calls.toNumber()).to.eq(1);
    expect(a.spentToday.toNumber()).to.eq(10_000);
  });

  it("refuses a payment over the per-call cap", async () => {
    await expectFail(pay(oracle.publicKey, usd(0.06)), "OverPerCallCap");
  });

  it("refuses a merchant that is not on the list", async () => {
    await expectFail(pay(stranger.publicKey, usd(0.01)), "AccountNotInitialized");
  });

  it("stops at the merchant budget", async () => {
    for (let i = 0; i < 2; i++) await pay(weather.publicKey, usd(0.04)); // 0.01 + 0.08 = 0.09
    await expectFail(pay(weather.publicKey, usd(0.02)), "OverMerchantBudget");
  });

  it("stops at the daily cap", async () => {
    // spent today 0.09; cap 0.20
    await pay(oracle.publicKey, usd(0.05));
    await pay(oracle.publicKey, usd(0.05));
    await expectFail(pay(oracle.publicKey, usd(0.02)), "OverDailyCap");
  });

  it("kill switch: paused refuses, unpaused works again", async () => {
    await program.methods.setLimits(usd(0.05), usd(1), new BN(Math.floor(Date.now() / 1000) + 3600))
      .accountsPartial({ owner: owner.publicKey, allowance }).signers([owner]).rpc();
    await program.methods.setPaused(true).accountsPartial({ owner: owner.publicKey, allowance }).signers([owner]).rpc();
    await expectFail(pay(oracle.publicKey, usd(0.01)), "Paused");
    await program.methods.setPaused(false).accountsPartial({ owner: owner.publicKey, allowance }).signers([owner]).rpc();
    await pay(oracle.publicKey, usd(0.01));
  });

  it("only the owner can pause", async () => {
    await expectFail(
      program.methods.setPaused(true).accountsPartial({ owner: agent.publicKey, allowance }).signers([agent]).rpc(),
      "ConstraintHasOne",
    );
  });

  it("emits a Paid event carrying the request reference", async () => {
    const ref = new Uint8Array(32).map((_, i) => i);
    const sig = await pay(oracle.publicKey, usd(0.01), ref);
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(program.programId, program.coder);
    const evs = [...parser.parseLogs(tx!.meta!.logMessages!)];
    const paid = evs.find((e) => e.name === "paid")!;
    expect(Buffer.from(paid.data.reference as number[]).toString("hex")).to.eq(Buffer.from(ref).toString("hex"));
  });

  it("withdraw and close return every unspent cent to the owner", async () => {
    const before = (await getAccount(conn, ownerToken)).amount;
    const inVault = (await getAccount(conn, vault)).amount;
    await program.methods.withdraw(usd(1)).accountsPartial({ owner: owner.publicKey, allowance, vault, ownerToken })
      .signers([owner]).rpc();
    await program.methods.close()
      .accountsPartial({ owner: owner.publicKey, allowance, vault, ownerToken, rentTo: sponsor.publicKey })
      .signers([owner]).rpc();
    const after = (await getAccount(conn, ownerToken)).amount;
    expect(after - before).to.eq(inVault);
    expect(await conn.getAccountInfo(allowance)).to.eq(null);
    expect(await conn.getAccountInfo(vault)).to.eq(null);
  });
});
