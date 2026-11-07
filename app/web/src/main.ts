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

// ---------- the street ----------
const ART: Record<string, number> = { weather: 1, fx: 2, ticker: 3, wiki: 4, wire: 5, analyst: 6, dossier: 7 };
const DEFAULT_BUDGET: Record<string, number> = { weather: 0.1, fx: 0.1, ticker: 0.1, wiki: 0.1, wire: 0.1, analyst: 0.3, dossier: 1 };
const art = (id: string) => `/art/stall-${ART[id] ?? 1}.webp`;
const POSE = { idle: "/art/agent-1.webp", pay: "/art/agent-2.webp", no: "/art/agent-3.webp", sleep: "/art/agent-4.webp" } as const;
const shortWhy = (r: string) =>
  /per-call/.test(r) ? "over per-call cap" : /paused/.test(r) ? "paused" : /today/.test(r) ? "over daily cap" : /budget/.test(r) ? "over shop budget" : /expired/.test(r) ? "expired" : /allow|unknown/i.test(r) ? "not allowed" : "refused";
const runMarks = new Map<string, { cls: "paid" | "no" | "calling"; note?: string }>();
const offSetup = new Set<string>();
let mode: "setup" | "live" | "" = "";

function stallEl(id: string) {
  return document.querySelector<HTMLElement>(`.stall[data-id="${id}"]`);
}
function buildStalls() {
  $("stalls").innerHTML = cfg.merchants
    .map((m) => `<div class="stall" data-id="${m.id}" title="${esc(m.blurb)}"><div class="tag"></div><img src="${art(m.id)}" alt="${esc(m.name)}" /><span class="plate"></span></div>`)
    .join("");
  for (const m of cfg.merchants) {
    const st = stallEl(m.id)!;
    st.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).tagName === "INPUT") return;
      if (mode === "setup") {
        offSetup.has(m.id) ? offSetup.delete(m.id) : offSetup.add(m.id);
        renderStreet();
        return;
      }
      const sm = state?.merchants?.find((x: any) => x.id === m.id);
      if (!sm) return;
      const v = prompt(`Budget for ${m.name} ($, 0 keeps the agent out)`, String(sm.budget));
      if (v === null) return;
      act("merchant", { id: m.id, budget: Number(v) }).catch((e) => toast(esc(String(e.message))));
    });
  }
}

function renderStreet() {
  const a = state?.allowance;
  const nextMode = a ? "live" : "setup";
  for (const m of cfg.merchants) {
    const st = stallEl(m.id)!;
    const tag = st.querySelector(".tag")!;
    const plate = st.querySelector<HTMLElement>(".plate")!;
    if (nextMode === "setup") {
      if (mode !== "setup") tag.innerHTML = `<b>${esc(m.name)}</b>${usdFine(m.price)}/call<span class="bud">budget $<input type="number" step="0.05" min="0" value="${DEFAULT_BUDGET[m.id] ?? 0.1}" data-b="${m.id}" /></span>`;
      st.className = "stall" + (offSetup.has(m.id) ? " off" : "");
      plate.textContent = offSetup.has(m.id) ? "kept out" : "";
      continue;
    }
    const sm = state.merchants.find((x: any) => x.id === m.id);
    const allowed = sm?.listed && sm.budget > 0;
    const mark = runMarks.get(m.id);
    st.className = "stall" + (!allowed ? " off" : "") + (mark ? " " + mark.cls : "");
    const name = mark?.cls === "paid" ? `${m.name} ✓` : mark?.cls === "no" ? `${m.name} ✕` : m.name;
    tag.innerHTML = `<b>${esc(name)}</b>${usdFine(m.price)}<span class="bud">${mark?.cls === "no" ? esc(mark.note ?? "refused") : allowed ? `${usdFine(sm.spent)} of ${usd(sm.budget)}` : "not allowed"}</span>`;
    plate.textContent = "";
  }
  mode = nextMode;
  const paused = !!a?.paused;
  $("street").classList.toggle("paused", paused);
  $("pausedSign").hidden = !paused;
  if (!walking) pose(paused ? "sleep" : lastPose === "sleep" ? "idle" : lastPose);
}

// the agent: where it stands, how it looks, what it says
let lastPose: keyof typeof POSE = "idle";
let walking = false;
function pose(p: keyof typeof POSE) {
  lastPose = p;
  const img = $<HTMLImageElement>("agentImg");
  if (!img.src.endsWith(POSE[p])) img.src = POSE[p];
  $("stop").hidden = p !== "no";
}
function say(text: string | null, cls = "") {
  const s = $("say");
  s.hidden = !text;
  if (text) { s.textContent = text; s.className = "say " + cls; }
}
function agentX(id: string | null) {
  const lane = $("lane"), ag = $("agent");
  const st = id ? stallEl(id) : null;
  if (!st) return lane.clientWidth / 2 - ag.offsetWidth / 2;
  return st.offsetLeft + st.offsetWidth / 2 - ag.offsetWidth * 0.78;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function walkTo(id: string | null) {
  const ag = $("agent");
  const x = agentX(id);
  const from = parseFloat(ag.style.left || "0");
  if (Math.abs(x - from) < 4) return;
  walking = true;
  ag.classList.add("walk");
  ag.style.left = x + "px";
  const st = id ? stallEl(id) : null;
  st?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "center" });
  await wait(780);
  ag.classList.remove("walk");
  walking = false;
}
function placeAgent() {
  const ag = $("agent");
  ag.style.transition = "none";
  ag.style.left = agentX(currentStall) + "px";
  const wrap = document.querySelector<HTMLElement>(".lane-wrap")!;
  if (wrap.scrollWidth > wrap.clientWidth) wrap.scrollLeft = ag.offsetLeft + ag.offsetWidth / 2 - wrap.clientWidth / 2;
  void ag.offsetWidth;
  ag.style.transition = "";
}
let currentStall: string | null = null;
async function flyCoin(id: string) {
  const st = stallEl(id), ag = $("agent"), lane = $("lane");
  if (!st) return;
  const tag = st.querySelector<HTMLElement>(".tag")!;
  const x0 = ag.offsetLeft + ag.offsetWidth * 0.95, y0 = ag.offsetTop + ag.offsetHeight * 0.42;
  const tagBox = tag.getBoundingClientRect(), laneBox = lane.getBoundingClientRect();
  const x1 = tagBox.left - laneBox.left + tagBox.width / 2, y1 = tagBox.top - laneBox.top + tagBox.height / 2;
  const c = document.createElement("div");
  c.className = "flycoin";
  lane.appendChild(c);
  const T = 620, t0 = performance.now();
  await new Promise<void>((done) => {
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / T), e = 1 - Math.pow(1 - k, 2);
      c.style.left = x0 + (x1 - x0) * e + "px";
      c.style.top = y0 + (y1 - y0) * e - Math.sin(Math.PI * k) * 90 + "px";
      c.style.transform = `scale(${1 - k * 0.35}) rotateY(${k * 720}deg)`;
      k < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  });
  c.remove();
}

// visual events queue, so walking and coins never overlap
let anim: Promise<void> = Promise.resolve();
const queue = (fn: () => Promise<void> | void) => (anim = anim.then(fn).catch(() => {}));

// ---------- rendering ----------
function render() {
  const s = state;
  $("wallet").textContent = `${short(OWNER)} · ${usd(s?.ownerBalance ?? 0)}`;
  const a = s?.allowance;
  $("loading").hidden = true;
  $("onboard").hidden = !!a;
  $("console").hidden = !a;
  $("pitch").hidden = !!a;
  $("purse").hidden = !a;
  renderStreet();
  if (!a) {
    const funded = (s?.ownerBalance ?? 0) > 0;
    $("step1").classList.toggle("done", funded);
    $("ownerBal").textContent = funded ? `${usd(s.ownerBalance)} in your wallet` : "";
    $("step2").classList.toggle("locked", !funded);
    ($("open") as HTMLButtonElement).disabled = !funded;
    return;
  }
  const v = a.vault.toFixed(3).split(".");
  $("aVault").innerHTML = `$${v[0]}<small>.${v[1]}</small>`;
  ($("aLink") as HTMLAnchorElement).href = a.url;
  $("aToday").style.width = Math.min(100, (a.spentToday / a.daily) * 100) + "%";
  $("aTodayTxt").textContent = `${usdFine(a.spentToday)} today`;
  $("aDaily").textContent = `${usd(a.daily)} a day`;
  $("aPerCall").textContent = `≤ ${usd(a.perCall, a.perCall < 0.1 ? 3 : 2)} a call`;
  const shops = s.merchants.filter((m: any) => m.listed && m.budget > 0).length;
  $("aShops").textContent = `${shops} shop${shops === 1 ? "" : "s"}`;
  $("aExp").textContent = "till " + new Date(a.expiresAt * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const kill = $("pause");
  kill.textContent = a.paused ? "Paused · tap to resume" : "Pause agent";
  kill.classList.toggle("on", a.paused);

  const paid = s.receipts.filter((r: any) => r.kind === "paid");
  const tape = $("tape");
  // one line per owner transaction: "Allowance opened · 7 shops" instead of eight lines
  const lines: any[] = [];
  for (const r of s.receipts) {
    if (r.kind === "merchantSet") {
      const host = lines.find((x) => x.sig === r.sig && x.kind !== "paid");
      if (host) { host.merchants = (host.merchants ?? 0) + 1; continue; }
      lines.push({ ...r, merchants: 1 });
      continue;
    }
    if (r.kind === "opened") {
      const kids = lines.filter((x) => x.kind === "merchantSet" && Math.abs(x.time - r.time) <= 20);
      const n = kids.reduce((acc, x) => acc + x.merchants, 0);
      for (const k of kids) lines.splice(lines.indexOf(k), 1);
      lines.push({ ...r, merchants: n });
      continue;
    }
    lines.push(r);
  }
  if (!lines.length) tape.innerHTML = `<div class="tape-empty">No receipts yet</div>`;
  else
    tape.innerHTML = lines
      .map((r: any) => {
        const isNew = seenReceipts.size > 0 && !seenReceipts.has(r.sig + r.kind);
        const t = r.time ? new Date(r.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
        if (r.kind === "paid")
          return `<div class="tline ${isNew ? "new" : ""}"><div class="a"><span><i class="dot"></i>#${r.call} ${esc(r.name)}</span><span>${usdFine(r.amount)}</span></div>
            <div class="b"><span>${t} · ref ${r.reference.slice(0, 8)}</span><a href="${r.url}" target="_blank" rel="noopener">${short(r.sig, 5)} ↗</a></div></div>`;
        const label: Record<string, string> = { opened: r.merchants ? `Allowance opened · ${r.merchants} shops` : "Allowance opened", merchantSet: r.merchants > 1 ? `${r.merchants} shop budgets set` : "Shop budget set", pausedSet: r.data?.paused ? "Paused by owner" : "Resumed by owner", toppedUp: "Topped up", withdrawn: "Withdrawn", limitsSet: "Caps changed", closed: "Closed" };
        const amt = r.kind === "opened" || r.kind === "toppedUp" || r.kind === "withdrawn" ? usd(Number(r.data?.amount ?? 0) / 1e6) : r.kind === "merchantSet" && r.merchants === 1 ? usd(Number(r.data?.budget ?? 0) / 1e6) : "";
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
  "Brief me on Solana: what it is, its price, and the latest headlines. Get the premium dossier too.",
  "I hold 2 SOL and I'm in Lagos. What is it worth in naira, and will it rain here this weekend?",
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
  runMarks.clear();
  renderStreet();
  feedAdd(`<div class="msg user">${esc(prompt)}</div>`);
  const buys = new Map<string, HTMLElement>();
  const merchantOf = new Map<string, string>();
  const ts = Date.now();
  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(`kobo:run:${OWNER}:${ts}`), owner.secretKey));
  const poll = setInterval(refresh, 2500);
  if (!state?.allowance?.paused) { pose("idle"); say("thinking…"); }
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
        const mid = merchantOf.get(e.id) ?? "";
        const step = (k: string, cls: string) => el?.querySelector(`[data-s="${k}"]`)?.classList.add(cls);
        switch (e.type) {
          case "text":
            queue(() => { feedAdd(`<div class="msg bot">${md(e.text)}</div>`); });
            break;
          case "note":
            feedAdd(`<div class="note">${md(e.text)}</div>`);
            break;
          case "call":
            merchantOf.set(e.id, e.merchant);
            buys.set(
              e.id,
              feedAdd(`<div class="buy"><img src="${art(e.merchant)}" alt="" /><div class="bd"><div class="h"><b>${esc(e.name)}</b><span>${usdFine(e.price)}</span></div>
                <div class="in">${esc(JSON.stringify(e.input))}</div>
                <div class="steps"><span data-s="req" class="on">request</span><span data-s="402">402 · pay ${usdFine(e.price)}</span><span data-s="sig">agent signs</span><span data-s="set">settles on Solana</span></div></div></div>`),
            );
            queue(async () => {
              currentStall = e.merchant;
              runMarks.set(e.merchant, { cls: "calling" });
              renderStreet();
              say(null);
              if (!state?.allowance?.paused) pose("idle");
              await walkTo(e.merchant);
              say(`402 · ${usdFine(e.price)}`);
            });
            break;
          case "402":
            step("402", "on");
            break;
          case "signed":
            step("sig", "on");
            queue(() => { if (!state?.allowance?.paused) pose("pay"); say("signing…"); });
            break;
          case "paid":
            step("402", "ok");
            step("sig", "ok");
            step("set", "ok");
            { const x = el?.querySelector('[data-s="set"]'); if (x) x.textContent = "settled on Solana"; }
            el?.classList.add("good");
            el?.querySelector(".bd")?.insertAdjacentHTML("beforeend", `<a class="tx" href="${e.url}" target="_blank" rel="noopener">paid ${usdFine(e.amount)} · ${short(e.sig, 6)} · ${e.ms} ms ↗</a>`);
            queue(async () => {
              pose("pay");
              await flyCoin(mid);
              runMarks.set(mid, { cls: "paid" });
              renderStreet();
              say(`paid in ${(e.ms / 1000).toFixed(1)} s`, "ok");
              await wait(500);
            });
            refresh();
            break;
          case "refused":
            step("set", "no");
            { const x = el?.querySelector('[data-s="set"]'); if (x) x.textContent = "refused on chain"; }
            el?.classList.add("bad");
            el?.querySelector(".bd")?.insertAdjacentHTML("beforeend", `<div class="why">Refused by the allowance: ${esc(e.reason)}. Not charged.</div>`);
            queue(async () => {
              runMarks.set(mid, { cls: "no", note: shortWhy(e.reason) });
              renderStreet();
              pose(state?.allowance?.paused ? "sleep" : "no");
              say(`refused · ${shortWhy(e.reason)}`, "no");
              await wait(1100);
            });
            break;
          case "failed":
            step("set", "no");
            { const x = el?.querySelector('[data-s="set"]'); if (x) x.textContent = "not charged"; }
            el?.classList.add("bad");
            el?.querySelector(".bd")?.insertAdjacentHTML("beforeend", `<div class="why">${esc(e.reason)}</div>`);
            queue(async () => {
              runMarks.set(mid, { cls: "no", note: "failed · not charged" });
              renderStreet();
              say("tool failed · not charged", "no");
              await wait(800);
            });
            break;
          case "error":
            feedAdd(`<div class="msg err">${esc(e.message)}</div>`);
            break;
          case "done":
            queue(async () => {
              feedAdd(`<div class="summary">${e.calls} paid call${e.calls === 1 ? "" : "s"} · ${usdFine(e.spent)} spent${e.refused ? ` · ${e.refused} refused by the allowance` : ""}</div>`);
              say(null);
              currentStall = null;
              pose(state?.allowance?.paused ? "sleep" : "idle");
              await walkTo(null);
            });
            break;
        }
      }
    }
  } catch (e: any) {
    feedAdd(`<div class="msg err">${esc(String(e?.message ?? e))}</div>`);
  } finally {
    clearInterval(poll);
    await anim;
    say(null);
    running = false;
    send.disabled = false;
    send.classList.remove("busy");
    refresh();
  }
}

// ---------- wiring ----------
async function main() {
  cfg = await api("/api/config");
  $("model").textContent = `${cfg.model} · ${cfg.merchants.length} paid APIs · x402 on Solana devnet`;
  const pl = $("progLink") as HTMLAnchorElement;
  pl.textContent = short(cfg.program, 6);
  pl.href = `https://explorer.solana.com/address/${cfg.program}?cluster=devnet`;
  buildStalls();
  placeAgent();
  addEventListener("resize", placeAgent);
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
      for (const m of cfg.merchants) {
        if (offSetup.has(m.id)) continue;
        const b = document.querySelector<HTMLInputElement>(`[data-b="${m.id}"]`);
        merchants[m.id] = Number(b?.value) || 0;
      }
      try {
        await act("open", {
          amount: Number(($("fAmount") as HTMLInputElement).value),
          perCall: Number(($("fPerCall") as HTMLInputElement).value),
          daily: Number(($("fDaily") as HTMLInputElement).value),
          hours: Number(($("fHours") as HTMLInputElement).value),
          merchants,
        });
      } catch (e) {
        await refresh();
        if (!state?.allowance) throw e; // the open itself failed; a later merchant batch failing is recoverable
      }
      // list any shop a failed batch left out, one at a time with a retry
      for (const [id, budget] of Object.entries(merchants)) {
        if (!budget || state?.merchants?.find((m: any) => m.id === id)?.listed) continue;
        for (let k = 0; k < 2; k++) {
          try { await act("merchant", { id, budget }); break; } catch { await new Promise((r) => setTimeout(r, 1200)); }
        }
      }
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
  placeAgent();
  setInterval(() => !running && document.visibilityState === "visible" && refresh(), 8000);
}
main();
