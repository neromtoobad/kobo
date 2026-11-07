// Kobo web client. The owner wallet is a burner keypair kept in this browser; every
// owner transaction is built and fee-paid by the server, then signed here.
import { Keypair, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

type Merchant = { id: string; name: string; blurb: string; price: number; wallet: string };
type Config = { program: string; mint: string; sponsor: string; model: string; merchants: Merchant[] };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const usd = (n: number, d = 2) => "$" + n.toFixed(d);
const usdFine = (n: number) => (n < 0.01 && n > 0 ? "$" + n.toFixed(3) : "$" + n.toFixed(n < 1 ? 3 : 2));
const short = (s: string, n = 4) => `${s.slice(0, n)}…${s.slice(-n)}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const md = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

// ---------- burner owner wallet ----------
function loadOwner(): Keypair {
  try {
    const raw = localStorage.getItem("kobo.owner");
    if (raw) return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {}
  const kp = Keypair.generate();
  try {
    localStorage.setItem("kobo.owner", bs58.encode(kp.secretKey));
  } catch {}
  return kp;
}
const owner = loadOwner();
const OWNER = owner.publicKey.toBase58();

let cfg: Config;
let state: any = null;
let running = false;
const seenReceipts = new Set<string>();

async function api(path: string, body?: unknown) {
  const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

let toastT: any;
function toast(html: string, ms = 4200) {
  const t = $("toast");
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), ms);
}

async function busy<T>(btn: HTMLElement, fn: () => Promise<T>) {
  btn.classList.add("busy");
  (btn as HTMLButtonElement).disabled = true;
  try {
    return await fn();
  } catch (e: any) {
    toast(esc(String(e?.message ?? e)), 6000);
  } finally {
    btn.classList.remove("busy");
    (btn as HTMLButtonElement).disabled = false;
  }
}

/** Ask the server to build an owner tx (fee-paid by the facilitator), sign it here, relay it. */
async function act(action: string, args: Record<string, unknown> = {}) {
  const { txs } = await api("/api/tx", { owner: OWNER, action, args });
  const signed = (txs as string[]).map((t) => {
    const tx = Transaction.from(Uint8Array.from(atob(t), (c) => c.charCodeAt(0)));
    tx.partialSign(owner);
    return btoa(String.fromCharCode(...tx.serialize()));
  });
  const r = await api("/api/submit", { txs: signed });
  await refresh();
  return r;
}

// ---------- rendering ----------
function renderSetup() {
  const box = $("fMerchants");
  const defaults: Record<string, number> = { weather: 0.1, fx: 0.1, ticker: 0.1, wiki: 0.1, wire: 0.1, analyst: 0.3, dossier: 1 };
  box.innerHTML = cfg.merchants
    .map(
      (m) => `<label class="mopt">
        <input type="checkbox" data-m="${m.id}" checked />
        <span class="nm">${esc(m.name)}<small>${esc(m.blurb)}</small></span>
        <span class="pr">${usdFine(m.price)}/call</span>
        <span class="inp">$<input type="number" step="0.05" min="0" value="${defaults[m.id] ?? 0.1}" data-b="${m.id}" /></span>
      </label>`,
    )
    .join("");
}

function render() {
  const s = state;
  $("wallet").textContent = `${short(OWNER)} · ${usd(s?.ownerBalance ?? 0)}`;
  const a = s?.allowance;
  $("onboard").hidden = !!a;
  $("console").hidden = !a;
  if (!a) {
    const funded = (s?.ownerBalance ?? 0) > 0;
    $("step1").classList.toggle("done", funded);
    $("ownerBal").textContent = funded ? `${usd(s.ownerBalance)} in your wallet` : "";
    $("step2").classList.toggle("locked", !funded);
    ($("open") as HTMLButtonElement).disabled = !funded;
    return;
  }
  $("aVault").textContent = usd(a.vault, a.vault < 10 ? 3 : 2);
  ($("aLink") as HTMLAnchorElement).href = a.url;
  const pct = Math.min(100, (a.spentToday / a.daily) * 100);
  $("aToday").style.width = pct + "%";
  $("aTodayTxt").textContent = `${usdFine(a.spentToday)} of ${usd(a.daily)} daily cap used today`;
  $("aPerCall").textContent = usd(a.perCall, a.perCall < 0.1 ? 3 : 2);
  $("aTotal").textContent = usdFine(a.totalSpent);
  $("aCalls").textContent = String(a.calls);
  $("aExp").textContent = new Date(a.expiresAt * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  $("aAgent").textContent = short(s.agent);
  $("aAgent").title = s.agent;
  const kill = $("pause");
  kill.textContent = a.paused ? "Paused · tap to resume" : "Pause agent";
  kill.classList.toggle("on", a.paused);
  document.querySelector(".allowance")!.classList.toggle("paused", a.paused);

  $("mRows").innerHTML = s.merchants
    .map((m: any) => {
      const p = m.budget ? Math.min(100, (m.spent / m.budget) * 100) : 0;
      return `<div class="mrow ${m.listed && m.budget > 0 ? "" : "off"}" data-id="${m.id}">
        <div class="top2"><span>${esc(m.name)}</span><span class="mono">${usdFine(m.spent)} / ${m.listed ? usd(m.budget) : "not allowed"}</span></div>
        <div class="bar"><div style="width:${p}%"></div></div>
      </div>`;
    })
    .join("");

  const paid = s.receipts.filter((r: any) => r.kind === "paid");
  const tape = $("tape");
  if (!s.receipts.length) tape.innerHTML = `<div class="tape-empty">No receipts yet</div>`;
  else
    tape.innerHTML = s.receipts
      .map((r: any) => {
        const isNew = !seenReceipts.has(r.sig + r.kind);
        const t = r.time ? new Date(r.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
        if (r.kind === "paid")
          return `<div class="tline ${isNew ? "new" : ""}"><div class="a"><span>#${r.call} ${esc(r.name)}</span><span>${usdFine(r.amount)}</span></div>
            <div class="b"><span>${t} · ref ${r.reference.slice(0, 8)}</span><a href="${r.url}" target="_blank" rel="noopener">${short(r.sig, 5)} ↗</a></div></div>`;
        const label: Record<string, string> = { opened: "Allowance opened", merchantSet: "Merchant budget set", pausedSet: r.data?.paused ? "Paused by owner" : "Resumed by owner", toppedUp: "Topped up", withdrawn: "Withdrawn", limitsSet: "Caps changed", closed: "Closed" };
        const amt = r.data?.amount ? usd(Number(r.data.amount) / 1e6) : r.data?.budget ? usd(Number(r.data.budget) / 1e6) : "";
        return `<div class="tline sys ${isNew ? "new" : ""}"><div class="a"><span>${label[r.kind] ?? r.kind}</span><span>${amt}</span></div>
          <div class="b"><span>${t}</span><a href="${r.url}" target="_blank" rel="noopener">${short(r.sig, 5)} ↗</a></div></div>`;
      })
      .join("");
  for (const r of s.receipts) seenReceipts.add(r.sig + r.kind);
  const spent = paid.reduce((x: number, r: any) => x + r.amount, 0);
  const fees = paid.reduce((x: number, r: any) => x + (r.fee ?? 0), 0) / 1e9;
  $("tSpent").textContent = usdFine(spent);
  $("tFees").textContent = `${fees.toFixed(6)} SOL`;
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api(`/api/state?owner=${OWNER}`);
    render();
  } catch {
  } finally {
    refreshing = false;
  }
}

// ---------- agent run ----------
const CHIPS = [
  "I hold 2 SOL and I'm in Lagos. What is it worth in naira, and will it rain here this weekend?",
  "Brief me on Solana: what it is, its price, and the latest headlines. Get the premium dossier too.",
  "Compare today's weather in Nairobi and Accra, and convert $50 to KES and GHS.",
];

function feedAdd(html: string) {
  const f = $("feed");
  f.querySelector(".empty")?.remove();
  const d = document.createElement("div");
  d.innerHTML = html;
  const el = d.firstElementChild as HTMLElement;
  f.appendChild(el);
  f.scrollTop = f.scrollHeight;
  return el;
}

async function run(prompt: string) {
  if (running || !prompt.trim()) return;
  running = true;
  const send = $("send") as HTMLButtonElement;
  send.disabled = true;
  send.classList.add("busy");
  feedAdd(`<div class="msg user">${esc(prompt)}</div>`);
  const buys = new Map<string, HTMLElement>();
  const ts = Date.now();
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(`kobo:run:${OWNER}:${ts}`), owner.secretKey));
  const poll = setInterval(refresh, 2500);
  try {
    const r = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: OWNER, prompt, ts, sig }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const e = JSON.parse(line.slice(5));
        const el = buys.get(e.id);
        const step = (k: string, cls: string) => el?.querySelector(`[data-s="${k}"]`)?.classList.add(cls);
        switch (e.type) {
          case "text":
            feedAdd(`<div class="msg bot">${md(e.text)}</div>`);
            break;
          case "call":
            buys.set(
              e.id,
              feedAdd(`<div class="buy"><div class="h"><b>${esc(e.name)}</b><span class="mono">${usdFine(e.price)}</span></div>
                <div class="in">${esc(JSON.stringify(e.input))}</div>
                <div class="steps"><span data-s="req" class="on">request</span><span data-s="402">402 · pay ${usdFine(e.price)}</span><span data-s="sig">agent signs</span><span data-s="set">settled on Solana</span></div></div>`),
            );
            break;
          case "402":
            step("402", "on");
            break;
          case "signed":
            step("sig", "on");
            break;
          case "paid":
            step("402", "ok");
            step("sig", "ok");
            step("set", "ok");
            el?.insertAdjacentHTML("beforeend", `<a class="tx" href="${e.url}" target="_blank" rel="noopener">paid ${usdFine(e.amount)} · ${short(e.sig, 6)} · ${e.ms} ms ↗</a>`);
            refresh();
            break;
          case "refused":
            step("set", "no");
            el?.insertAdjacentHTML("beforeend", `<div class="why">Refused by the allowance: ${esc(e.reason)}. Not charged.</div>`);
            break;
          case "failed":
            step("set", "no");
            el?.insertAdjacentHTML("beforeend", `<div class="why">${esc(e.reason)}</div>`);
            break;
          case "error":
            feedAdd(`<div class="msg err">${esc(e.message)}</div>`);
            break;
          case "done":
            feedAdd(`<div class="summary">${e.calls} paid call${e.calls === 1 ? "" : "s"} · ${usdFine(e.spent)} spent${e.refused ? ` · ${e.refused} refused by the allowance` : ""}</div>`);
            break;
        }
      }
    }
  } catch (e: any) {
    feedAdd(`<div class="msg err">${esc(String(e?.message ?? e))}</div>`);
  } finally {
    clearInterval(poll);
    running = false;
    send.disabled = false;
    send.classList.remove("busy");
    refresh();
  }
}

// ---------- wiring ----------
async function main() {
  cfg = await api("/api/config");
  $("model").textContent = `${cfg.model} · ${cfg.merchants.length} paid tools`;
  const pl = $("progLink") as HTMLAnchorElement;
  pl.textContent = short(cfg.program, 6);
  pl.href = `https://explorer.solana.com/address/${cfg.program}?cluster=devnet`;
  renderSetup();
  $("chips").innerHTML = CHIPS.map((c) => `<button class="chip" type="button">${esc(c)}</button>`).join("");
  $("chips").addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest(".chip");
    if (b) run(b.textContent ?? "");
  });
  $("wallet").onclick = () => {
    navigator.clipboard?.writeText(OWNER).catch(() => {});
    toast(`Owner wallet ${short(OWNER, 6)} copied. It lives only in this browser.`);
  };
  $("faucet").onclick = () =>
    busy($("faucet"), async () => {
      const r = await api("/api/faucet", { owner: OWNER });
      toast(`+$5 test USD · <a href="${r.url}" target="_blank" rel="noopener">tx ↗</a>`);
      await refresh();
    });
  $("open").onclick = () =>
    busy($("open"), async () => {
      const merchants: Record<string, number> = {};
      document.querySelectorAll<HTMLInputElement>("[data-m]").forEach((cb) => {
        const b = document.querySelector<HTMLInputElement>(`[data-b="${cb.dataset.m}"]`);
        if (cb.checked) merchants[cb.dataset.m!] = Number(b?.value) || 0;
      });
      await act("open", {
        amount: Number(($("fAmount") as HTMLInputElement).value),
        perCall: Number(($("fPerCall") as HTMLInputElement).value),
        daily: Number(($("fDaily") as HTMLInputElement).value),
        hours: Number(($("fHours") as HTMLInputElement).value),
        merchants,
      });
      toast("Allowance opened on Solana");
    });
  $("pause").onclick = () => busy($("pause"), () => act("pause", { paused: !state?.allowance?.paused }));
  $("topup").onclick = () =>
    busy($("topup"), async () => {
      if ((state?.ownerBalance ?? 0) < 1) await api("/api/faucet", { owner: OWNER });
      await act("topup", { amount: 1 });
    });
  $("withdraw").onclick = () => busy($("withdraw"), () => act("withdraw", { amount: Math.min(1, state?.allowance?.vault ?? 0) }));
  $("limits").onclick = () => {
    const a = state?.allowance;
    const per = prompt("Max per call ($)", String(a?.perCall ?? 0.05));
    if (per === null) return;
    const day = prompt("Max per day ($)", String(a?.daily ?? 1));
    if (day === null) return;
    busy($("limits"), () => act("limits", { perCall: Number(per), daily: Number(day) }));
  };
  $("mRows").addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".mrow");
    if (!row) return;
    const m = state.merchants.find((x: any) => x.id === row.dataset.id);
    const v = prompt(`Budget for ${m.name} ($, 0 blocks it)`, String(m.budget));
    if (v === null) return;
    act("merchant", { id: m.id, budget: Number(v) }).catch((e) => toast(esc(String(e.message))));
  });
  $("ask").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const p = ($("prompt") as HTMLTextAreaElement).value;
    ($("prompt") as HTMLTextAreaElement).value = "";
    run(p);
  });
  $("prompt").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      $("ask").dispatchEvent(new Event("submit"));
    }
  });
  await refresh();
  setInterval(() => !running && document.visibilityState === "visible" && refresh(), 8000);
}
main();
