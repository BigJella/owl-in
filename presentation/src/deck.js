/*
 * OWL IN presentation runtime: slide navigation, animations, live data from the management API (with a sample-data
 * fallback), SVG diagrams and code highlighting. Plain browser JS, no dependencies besides the inlined qrcode-generator.
 */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SAMPLE = window.OWL_SAMPLE;

  // ---------- formatting (same conventions as the game: formatDD, −$900 for losses) ----------
  const fmtDD = (n) => `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
  const fmtSigned = (n) => (Math.round(n) > 0 ? `+${fmtDD(n)}` : fmtDD(n));
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const fmtSec = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const fmtUsd = (n) => `$${n.toFixed(n < 10 ? 3 : 2)}`;
  const fmtPct = (p) => `${(p * 100).toFixed(p > 0 && p < 0.1 ? 1 : 0)}%`;
  const plural = (n, one, many) => (Math.round(n) === 1 ? one : many);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ago = (at) => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
  };

  /** Count a number up/down to `to` (tabular digits, so nothing shifts while it runs). */
  function tween(el, to, fmt, from) {
    if (!el) return;
    const start = from ?? el._v ?? 0;
    el._v = to;
    cancelAnimationFrame(el._raf);
    if (reduced || start === to || document.hidden) {
      el.textContent = fmt(to);
      return;
    }
    const t0 = performance.now();
    const dur = 900;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(start + (to - start) * e);
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  /** Grow a bar to `pct` (0–100). On a slide's entrance it starts from 0 so it visibly grows. */
  function bar(fill, pct, intro, prop = "width") {
    if (intro && !reduced) {
      fill.style.transition = "none";
      fill.style[prop] = "0%";
      void fill.offsetWidth;
      fill.style.transition = "";
    }
    fill.style[prop] = `${Math.max(0, Math.min(100, pct))}%`;
  }

  // ---------- stage scaling ----------
  const stage = $("#stage");
  const fit = () => stage.style.setProperty("--scale", String(Math.min(innerWidth / 1920, innerHeight / 1080)));
  addEventListener("resize", fit);
  fit();

  // ---------- slides & navigation ----------
  const slides = $$(".slide");
  let current = -1;
  slides.forEach((slide) => $$("[data-reveal]", slide).forEach((el, i) => el.style.setProperty("--ri", String(i))));
  $("#foot-total").textContent = String(slides.length).padStart(2, "0");

  function go(index, dir) {
    index = Math.max(0, Math.min(slides.length - 1, index));
    if (index === current) return;
    dir = dir ?? (index > current ? 1 : -1);
    const old = slides[current];
    if (old) {
      old.style.setProperty("--x", `${-dir * 32}px`);
      old.classList.remove("active", "shown");
    }
    const next = slides[index];
    next.classList.add("prep");
    next.style.setProperty("--x", `${dir * 32}px`);
    void next.offsetWidth;
    next.classList.remove("prep");
    next.classList.add("active");
    current = index;
    $("#foot-n").textContent = String(index + 1).padStart(2, "0");
    $("#progress-bar").style.width = `${((index + 1) / slides.length) * 100}%`;
    $("#foot").style.visibility = index === 0 ? "hidden" : "visible";
    try {
      history.replaceState(null, "", `#${index + 1}`);
    } catch {
      // file:// in some browsers
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (current !== index) return;
        next.classList.add("shown");
        render(next);
      }),
    );
  }

  const editing = () => document.activeElement && document.activeElement.isContentEditable;
  addEventListener("keydown", (e) => {
    if (editing() || e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "ArrowDown") go(current + 1, 1);
    else if (k === "ArrowLeft" || k === "PageUp" || k === "ArrowUp" || k === "Backspace") go(current - 1, -1);
    else if (k === "Home") go(0, -1);
    else if (k === "End") go(slides.length - 1, 1);
    else if (k === "f" || k === "F") {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    } else return;
    e.preventDefault();
  });
  $("#viewport").addEventListener("click", (e) => {
    if (editing() || e.target.closest("#join-url")) return;
    const x = e.clientX / innerWidth;
    if (x < 1 / 3) go(current - 1, -1);
    else if (x > 2 / 3) go(current + 1, 1);
  });
  const fromHash = () => {
    const n = parseInt(location.hash.slice(1), 10);
    return Number.isFinite(n) ? n - 1 : 0;
  };
  addEventListener("hashchange", () => go(fromHash()));

  // ---------- live data ----------
  const SAME_ORIGIN = location.protocol.startsWith("http") && (location.hostname === "localhost" || location.hostname === "127.0.0.1") && location.port === "3000";
  const API = SAME_ORIGIN ? "/api/admin" : "http://localhost:3000/api/admin";
  const HISTORY_KEY = "owl-present-online";
  const D = { mode: "pending", snap: null, llm: [], hands: [], online: [], network: null };

  function loadHistory() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.filter((p) => Date.now() - p.at < 15 * 60_000) : [];
    } catch {
      return [];
    }
  }
  let liveHistory = loadHistory();
  let lastSample = 0;

  async function getJSON(path, timeoutMs = 2500) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch(API + path, { signal: ctrl.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function setMode(mode) {
    if (D.mode === mode) return;
    D.mode = mode;
    document.body.classList.toggle("online", mode === "online");
    document.body.classList.toggle("offline", mode === "offline");
    if (mode === "offline") {
      D.snap = SAMPLE.snapshot;
      D.llm = SAMPLE.snapshot.llm.recent;
      D.hands = SAMPLE.log;
      D.online = SAMPLE.history;
    } else {
      D.llm = [];
      D.hands = [];
      D.online = liveHistory;
    }
    seenNames = null;
    seenTicker = null;
    seenHands = null;
  }

  let misses = 0;
  async function pollSnapshot() {
    try {
      const snap = await getJSON("/snapshot");
      misses = 0;
      setMode("online");
      D.snap = snap;
      if (Date.now() - lastSample >= 5_000) {
        lastSample = Date.now();
        liveHistory.push({ at: snap.at, online: snap.totals.playersOnline });
        liveHistory = liveHistory.filter((p) => Date.now() - p.at < 15 * 60_000);
        D.online = liveHistory;
        try {
          sessionStorage.setItem(HISTORY_KEY, JSON.stringify(liveHistory));
        } catch {
          // storage blocked: the line just starts fresh on reload
        }
      }
    } catch {
      // One missed poll while live is tolerated (a slow response); after that, sample data.
      misses++;
      if (D.mode !== "online" || misses >= 2) setMode("offline");
    }
    render();
    setTimeout(pollSnapshot, D.mode === "online" ? 2_000 : 5_000);
  }

  async function pollDetails() {
    if (D.mode === "online") {
      const [llm, log, net] = await Promise.allSettled([
        getJSON("/llm?limit=500"),
        getJSON("/log?kinds=hand&humansOnly=1&limit=8"),
        D.network ? Promise.resolve(D.network) : getJSON("/network"),
      ]);
      if (D.mode === "online") {
        if (llm.status === "fulfilled") D.llm = llm.value.recent ?? [];
        if (log.status === "fulfilled") D.hands = log.value.entries ?? [];
        if (net.status === "fulfilled" && net.value) D.network = net.value;
        render();
      }
    }
    setTimeout(pollDetails, 4_000);
  }

  // ---------- rendering ----------
  /** Re-render every live component. `introSlide`: the slide just entered (its numbers count up from 0). */
  function render(introSlide) {
    if (D.mode === "pending" || !D.snap) return;
    const intro = (el) => introSlide !== undefined && introSlide.contains(el);
    renderJoin(intro);
    renderTables(intro);
    renderStates(intro);
    renderAi(intro);
    renderLeaderboard(intro);
    renderConservation(intro);
    renderOnline(intro);
    renderHands();
    renderItChat(intro);
  }

  // Join slide ------------------------------------------------------------
  const JOIN_KEY = "owl-present-join";
  const params = new URLSearchParams(location.search);
  const joinEl = $("#join-url");
  let joinShown = null;
  let seenNames = null;

  function joinHost() {
    const fromParam = params.get("join");
    let saved = null;
    try {
      saved = localStorage.getItem(JOIN_KEY);
    } catch {
      saved = null;
    }
    const raw = fromParam || saved || (D.network && D.network.addresses[0]) || null;
    if (!raw) return null;
    const host = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return host.includes(":") ? host : `${host}:${(D.network && D.network.clientPort) || 5173}`;
  }

  function fitJoin() {
    joinEl.style.fontSize = "";
    const max = joinEl.parentElement.clientWidth;
    let size = 120;
    while (joinEl.scrollWidth > max && size > 56) {
      size -= 4;
      joinEl.style.fontSize = `${size}px`;
    }
  }

  function drawQr(text, dim) {
    const box = $("#qr");
    box.style.opacity = dim ? "0.25" : "1";
    if (typeof qrcode !== "function") return;
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    box.innerHTML = `<svg viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges" aria-label="QR code for ${esc(text)}"><path d="${d}" fill="#000"/></svg>`;
  }

  function renderJoinUrl() {
    if (editing()) return;
    const host = joinHost();
    const key = host ?? "?";
    if (key === joinShown) return;
    joinShown = key;
    joinEl.innerHTML = `<span class="pfx">http://</span>${esc(host ?? "192.168.x.x:5173")}`;
    drawQr(`http://${host ?? "192.168.x.x:5173"}`, !host);
    $(".qr-cap").textContent = host ? "Scan to join" : "Click the address to set it";
    fitJoin();
  }

  joinEl.addEventListener("click", () => {
    if (joinEl.isContentEditable) return;
    joinEl.contentEditable = "true";
    joinEl.textContent = joinHost() ?? "";
    joinEl.focus();
    getSelection()?.selectAllChildren(joinEl);
  });
  joinEl.addEventListener("keydown", (e) => {
    if (!joinEl.isContentEditable) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      if (e.key === "Enter") {
        const value = joinEl.textContent.trim().replace(/^https?:\/\//, "");
        try {
          if (value) localStorage.setItem(JOIN_KEY, value);
          else localStorage.removeItem(JOIN_KEY);
        } catch {
          // not saved, but still shown below
        }
      }
      joinEl.blur();
    }
  });
  joinEl.addEventListener("blur", () => {
    joinEl.contentEditable = "false";
    joinShown = null;
    renderJoinUrl();
  });

  function renderJoin(intro) {
    renderJoinUrl();
    const { totals, tables, players } = D.snap;
    const from = intro($("#j-online")) ? 0 : undefined;
    tween($("#j-online"), totals.playersOnline, fmtInt, from);
    tween($("#j-seated"), totals.playersAtTables, fmtInt, from);
    tween($("#j-tables"), totals.pokerTables + totals.blackjackTables, fmtInt, from);
    tween($("#j-bots"), tables.reduce((s, t) => s + t.bots, 0), fmtInt, from);

    // Online names, in the order they showed up; new ones animate in. Only the newest that fit are shown.
    const online = players.filter((p) => p.online);
    const first = seenNames === null;
    if (first) seenNames = new Map();
    for (const p of [...online].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!seenNames.has(p.id)) seenNames.set(p.id, { name: p.name, fresh: !first, order: seenNames.size });
      else seenNames.get(p.id).name = p.name;
    }
    const ids = new Set(online.map((p) => p.id));
    const shown = [...seenNames.entries()].filter(([id]) => ids.has(id)).slice(-16);
    const box = $("#j-names");
    box.innerHTML = shown.length
      ? shown.map(([, v]) => `<span class="chip${v.fresh ? " new" : ""}">${esc(v.name)}</span>`).join("")
      : `<span class="empty">Waiting for the first player…</span>`;
    for (const [, v] of shown) v.fresh = false;
  }

  // Tables strip ----------------------------------------------------------
  function renderTables() {
    const tables = [...D.snap.tables].sort((a, b) => b.humans - a.humans || (a.game === b.game ? 0 : a.game === "poker" ? -1 : 1)).slice(0, 5);
    tables.sort((a, b) => (a.game === b.game ? 0 : a.game === "poker" ? -1 : 1));
    $("#tables-strip").innerHTML = tables
      .map((t) => {
        const seats = [...t.seats]
          .sort((a, b) => a.seat - b.seat)
          .map((s) => `<span class="seat ${s.kind === "human" ? "h" : s.botMode === "llm" ? "ai" : "b"}" title="${esc(s.name)}"></span>`)
          .join("");
        const unit = t.game === "poker" ? "Hand" : "Round";
        return `<div class="tcard"><div class="tn" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="ts">${t.game === "poker" ? "Hold'em" : "Blackjack"} · ${esc(t.stakes)}</div>
          <div class="tg">${esc(t.stage)} <span>· ${unit} #${t.handId}</span></div>
          <div class="seats">${seats}</div></div>`;
      })
      .join("");
  }

  // State machines --------------------------------------------------------
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, parent) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }
  function svgText(parent, x, y, text, cls, anchor = "middle") {
    const t = svgEl("text", { x, y, class: cls, "text-anchor": anchor }, parent);
    t.textContent = text;
    return t;
  }

  /**
   * Draw a diagram: nodes (state / box / decision / conn) and orthogonal edges given as point lists.
   * Elements get staggered --d delays so nodes appear one by one and edges draw in after them.
   */
  function drawDiagram(svg, nodes, edges) {
    svg.textContent = "";
    const gEdges = svgEl("g", {}, svg);
    const gNodes = svgEl("g", {}, svg);
    const refs = {};
    // Whole diagram in about 1.6 s however many parts it has.
    const nodeStep = Math.min(90, 650 / nodes.length);
    const edgeStep = Math.min(70, 500 / edges.length);
    nodes.forEach((n, i) => {
      const g = svgEl("g", { class: `node ${n.type}${n.cls ? ` ${n.cls}` : ""}`, style: `--d:${150 + i * nodeStep}ms` }, gNodes);
      const cx = n.x + n.w / 2;
      if (n.type === "decision") {
        const cy = n.y + n.h / 2;
        svgEl("polygon", { class: "n-box", points: `${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}` }, g);
      } else if (n.type === "conn") {
        svgEl("circle", { class: "n-box", cx, cy: n.y + n.h / 2, r: n.w / 2 }, g);
      } else {
        svgEl("rect", { class: "n-box", x: n.x, y: n.y, width: n.w, height: n.h }, g);
      }
      if (n.type === "state") {
        svgText(g, cx, n.y + 42, n.label, "n-label");
        refs[n.id] = {
          g,
          count: svgText(g, cx, n.y + 122, "0", "n-count"),
          unit: svgText(g, cx, n.y + 150, "people", "n-sub"),
          sub: svgText(g, cx, n.y + 176, "", "n-sub"),
        };
      } else {
        const lines = n.lines ?? [n.label];
        const lh = n.type === "conn" ? 0 : 26;
        const y0 = n.y + n.h / 2 - ((lines.length - 1) * lh) / 2 + 7;
        lines.forEach((line, li) => svgText(g, cx, y0 + li * lh, line, n.type === "conn" ? "" : n.bold === li ? "n-label" : "n-text"));
      }
    });
    edges.forEach((e, i) => {
      const g = svgEl("g", { class: `edge${e.cls ? ` ${e.cls}` : ""}`, style: `--d:${250 + nodes.length * nodeStep + i * edgeStep}ms` }, gEdges);
      const pts = e.pts;
      svgEl("path", { class: "ln", d: `M${pts.map((p) => p.join(" ")).join(" L")}`, pathLength: 1 }, g);
      const [ax, ay] = pts[pts.length - 1];
      const [bx, by] = pts[pts.length - 2];
      const ang = Math.atan2(ay - by, ax - bx);
      const s = 12;
      const p1 = [ax - s * Math.cos(ang) + (s / 2) * Math.sin(ang), ay - s * Math.sin(ang) - (s / 2) * Math.cos(ang)];
      const p2 = [ax - s * Math.cos(ang) - (s / 2) * Math.sin(ang), ay - s * Math.sin(ang) + (s / 2) * Math.cos(ang)];
      if (!e.noArrow) svgEl("path", { class: "ah", d: `M${ax} ${ay} L${p1.join(" ")} L${p2.join(" ")} Z` }, g);
      if (e.label) {
        const lg = svgEl("g", { class: "e-lab" }, g);
        const anchor = e.anchor ?? "middle";
        const bg = svgEl("rect", { class: "e-label-bg" }, lg);
        const t = svgText(lg, e.lx, e.ly, e.label, "e-label", anchor);
        let w = e.label.length * 9.4;
        try {
          w = t.getComputedTextLength() || w;
        } catch {
          // not laid out yet: keep the estimate
        }
        const x0 = anchor === "middle" ? e.lx - w / 2 : anchor === "end" ? e.lx - w : e.lx;
        bg.setAttribute("x", String(x0 - 8));
        bg.setAttribute("y", String(e.ly - 17));
        bg.setAttribute("width", String(w + 16));
        bg.setAttribute("height", "24");
        if (!e.labelBg) bg.remove();
      }
    });
    return refs;
  }

  // Poker: the real TableStage labels (STAGE_LABEL in packages/shared/src/poker.ts).
  const POKER_STATES = [
    ["waiting", "Waiting", "Waiting for players"],
    ["preflop", "Pre-flop", "Pre-flop"],
    ["flop", "Flop", "Flop"],
    ["turn", "Turn", "Turn"],
    ["river", "River", "River"],
    ["showdown", "Showdown", "Showdown"],
    ["handover", "Hand over", "Hand over"],
  ];
  // Blackjack: BJ_STAGE_LABEL in packages/shared/src/blackjack.ts.
  const BJ_STATES = [
    ["waiting", "Waiting", "Waiting"],
    ["betting", "Place bets", "Place bets"],
    ["insurance", "Insurance", "Insurance"],
    ["playing", "Playing", "Playing"],
    ["settled", "Round over", "Round over"],
  ];
  let pokerRefs = null;
  let bjRefs = null;

  function buildPokerStates() {
    const W = 196;
    const step = 252;
    const y = 150;
    const H = 190;
    const nodes = POKER_STATES.map(([id, label], i) => ({ id, type: "state", label, x: i * step, y, w: W, h: H }));
    const cy = y + H / 2;
    const mid = (i) => i * step + W / 2;
    const edges = [];
    for (let i = 0; i < nodes.length - 1; i++) edges.push({ pts: [[i * step + W, cy], [(i + 1) * step, cy]] });
    // Everyone else folds (from any betting street) → Hand over.
    for (let i = 1; i <= 4; i++) edges.push({ cls: "dash", noArrow: true, pts: [[mid(i), y], [mid(i), 84]] });
    edges.push({ cls: "dash", pts: [[mid(1), 84], [mid(6), 84], [mid(6), y]], label: "everyone else folds", lx: (mid(1) + mid(6)) / 2, ly: 70, labelBg: true });
    // Next hand.
    edges.push({ cls: "gold", pts: [[mid(6), y + H], [mid(6), 420], [mid(1), 420], [mid(1), y + H]], label: "every person ready → deal the next hand", lx: (mid(1) + mid(6)) / 2, ly: 427, labelBg: true });
    pokerRefs = drawDiagram($("#sm-poker"), nodes, edges);
    svgText($("#sm-poker"), mid(0), y - 14, "2+ players → deal", "e-label");
  }

  function buildBlackjackStates() {
    const W = 240;
    const H = 190;
    const xs = [0, 368, 736, 1104, 1472];
    const yMain = 240;
    const nodes = [
      { id: "waiting", type: "state", label: "Waiting", x: xs[0], y: yMain, w: W, h: H },
      { id: "betting", type: "state", label: "Place bets", x: xs[1], y: yMain, w: W, h: H },
      { id: "insurance", type: "state", label: "Insurance", x: xs[2], y: 6, w: W, h: H },
      { id: "playing", type: "state", label: "Playing", x: xs[3], y: yMain, w: W, h: H },
      { id: "settled", type: "state", label: "Round over", x: xs[4], y: yMain, w: W, h: H },
    ];
    const cy = yMain + H / 2;
    const mid = (i) => xs[i] + W / 2;
    const edges = [
      { pts: [[xs[0] + W, cy], [xs[1], cy]], label: "a player sits", lx: (xs[0] + W + xs[1]) / 2, ly: cy - 14 },
      { pts: [[mid(1), yMain], [mid(1), 100], [xs[2], 100]], label: "dealer shows an ace", lx: (mid(1) + xs[2]) / 2, ly: 86 },
      { pts: [[xs[1] + W, cy], [xs[3], cy]], label: "deal (no ace showing)", lx: (xs[1] + W + xs[3]) / 2, ly: cy - 14 },
      { pts: [[xs[2] + W, 150], [mid(3), 150], [mid(3), yMain]], label: "no dealer blackjack", lx: (xs[2] + W + mid(3)) / 2, ly: 138 },
      { cls: "dash", pts: [[xs[2] + W, 60], [mid(4), 60], [mid(4), yMain]], label: "dealer blackjack (peek)", lx: (xs[2] + W + mid(4)) / 2, ly: 48 },
      { pts: [[xs[3] + W, cy], [xs[4], cy]], label: "dealer to 17", lx: (xs[3] + W + xs[4]) / 2, ly: cy - 14 },
      { cls: "gold", pts: [[mid(4), yMain + H], [mid(4), 455], [mid(1), 455], [mid(1), yMain + H]], label: "3 s · sweep the cards · next round", lx: (mid(1) + mid(4)) / 2, ly: 461, labelBg: true },
    ];
    bjRefs = drawDiagram($("#sm-blackjack"), nodes, edges);
  }

  function stateCounts(game, states) {
    const byLabel = new Map(states.map(([id, , label]) => [label, id]));
    const counts = Object.fromEntries(states.map(([id]) => [id, { people: 0, bots: 0, tables: 0 }]));
    for (const t of D.snap.tables) {
      if (t.game !== game) continue;
      const id = byLabel.get(t.stage);
      if (!id) continue;
      counts[id].people += t.humans + t.waiting;
      counts[id].bots += t.bots;
      counts[id].tables += 1;
    }
    return counts;
  }

  function paintStates(refs, counts, intro) {
    for (const [id, ref] of Object.entries(refs)) {
      const c = counts[id];
      if (!c) continue;
      ref.g.classList.toggle("hot", c.tables > 0);
      tween(ref.count, c.people, fmtInt, intro(ref.count) ? 0 : undefined);
      ref.unit.textContent = plural(c.people, "person", "people");
      ref.sub.textContent = c.tables ? `${c.bots} ${plural(c.bots, "bot", "bots")} · ${c.tables} ${plural(c.tables, "table", "tables")}` : "no tables";
    }
  }

  function renderStates(intro) {
    if (pokerRefs) paintStates(pokerRefs, stateCounts("poker", POKER_STATES), intro);
    if (bjRefs) paintStates(bjRefs, stateCounts("blackjack", BJ_STATES), intro);
  }

  // Flowchart -------------------------------------------------------------
  function buildFlow() {
    const nodes = [
      { id: "join", type: "box", cls: "start", x: 0, y: 72, w: 230, h: 96, lines: ["Join a table", "buy in 20–100 BB"], bold: 0 },
      { id: "swap", type: "box", x: 290, y: 72, w: 330, h: 96, lines: ["At the next gap, take the bot", "seat closest to your buy-in"] },
      { id: "deal", type: "box", x: 680, y: 72, w: 270, h: 96, lines: ["Deal: post blinds,", "two cards to each seat"] },
      { id: "turn", type: "decision", x: 1005, y: 50, w: 250, h: 140, lines: ["Whose turn?"] },
      { id: "human", type: "box", x: 1330, y: 72, w: 382, h: 96, lines: ["Person: fold, check, call or raise.", "Clock at 0 → auto check / fold"] },
      { id: "bot", type: "box", x: 965, y: 255, w: 330, h: 120, lines: ["Bot: rule-based script,", "or Claude for AI bots", "(script if Claude fails)"] },
      { id: "engine", type: "box", x: 1330, y: 267, w: 382, h: 96, lines: ["Engine checks the action", "and returns events"] },
      { id: "anim", type: "box", x: 1330, y: 440, w: 382, h: 96, lines: ["Every screen animates the", "events, then syncs"] },
      { id: "over", type: "decision", x: 875, y: 418, w: 250, h: 140, lines: ["Hand over?"] },
      { id: "bust", type: "decision", x: 530, y: 423, w: 220, h: 130, lines: ["Busted?"] },
      { id: "ready", type: "box", x: 170, y: 440, w: 290, h: 96, lines: ["Ready up: 5 s, then", "your clock runs"] },
      { id: "rebuy", type: "box", x: 495, y: 600, w: 290, h: 96, lines: ["Reload (30 s) or", "cash out and leave"] },
      { id: "a1", type: "conn", x: 1112, y: 0, w: 36, h: 36, lines: ["A"] },
      { id: "a2", type: "conn", x: 982, y: 622, w: 36, h: 36, lines: ["A"] },
      { id: "b1", type: "conn", x: 797, y: 210, w: 36, h: 36, lines: ["B"] },
      { id: "b2", type: "conn", x: 92, y: 470, w: 36, h: 36, lines: ["B"] },
    ];
    const edges = [
      { pts: [[230, 120], [290, 120]] },
      { pts: [[620, 120], [680, 120]] },
      { pts: [[950, 120], [1005, 120]] },
      { pts: [[1130, 36], [1130, 50]] },
      { pts: [[1255, 120], [1330, 120]], label: "person", lx: 1292, ly: 108 },
      { pts: [[1130, 190], [1130, 255]], label: "bot", lx: 1144, ly: 228, anchor: "start" },
      { pts: [[1521, 168], [1521, 267]] },
      { pts: [[1295, 315], [1330, 315]] },
      { pts: [[1521, 363], [1521, 440]] },
      { pts: [[1330, 488], [1125, 488]] },
      { pts: [[1000, 558], [1000, 622]], label: "no: next turn", lx: 1014, ly: 596, anchor: "start" },
      { pts: [[875, 488], [750, 488]], label: "yes", lx: 812, ly: 476 },
      { pts: [[530, 488], [460, 488]], label: "no", lx: 495, ly: 476 },
      { pts: [[640, 553], [640, 600]], label: "yes", lx: 654, ly: 582, anchor: "start" },
      { pts: [[495, 648], [315, 648], [315, 536]], label: "reload", lx: 405, ly: 636 },
      { pts: [[170, 488], [128, 488]] },
      { pts: [[815, 210], [815, 168]] },
    ];
    drawDiagram($("#flow"), nodes, edges);
  }

  // AI slide --------------------------------------------------------------
  let seenTicker = null;
  const ACTION_ORDER = ["fold", "check", "call", "raise", "fallback"];

  function renderAi(intro) {
    const llm = D.snap.llm;
    $("#ai-model").textContent = llm.model;
    const from = intro($("#ai-calls")) ? 0 : undefined;
    tween($("#ai-calls"), llm.calls, fmtInt, from);
    tween($("#ai-avg"), llm.avgMs, fmtSec, from);
    tween($("#ai-p95"), llm.p95Ms, fmtSec, from);
    tween($("#ai-fb"), llm.calls ? llm.fallbacks / llm.calls : 0, fmtPct, from);
    tween($("#ai-cost"), llm.totalCostUsd, fmtUsd, from);

    // What the AI chose, from the recent decisions ("raise to $60" → raise; a script fallback counts separately).
    const counts = Object.fromEntries(ACTION_ORDER.map((a) => [a, 0]));
    for (const d of D.llm) {
      const key = d.fallback ? "fallback" : d.action.split(" ")[0];
      if (key in counts) counts[key]++;
    }
    const max = Math.max(1, ...Object.values(counts));
    const box = $("#ai-actions");
    if (!box.children.length) {
      box.innerHTML = ACTION_ORDER.map(
        (a) => `<div class="hbar${a === "fallback" ? " alt" : ""}" data-a="${a}"><span class="hl">${a === "fallback" ? "Script" : a}</span><span class="ht"><span class="hf"></span></span><span class="hv">0</span></div>`,
      ).join("");
    }
    for (const row of box.children) {
      const a = row.dataset.a;
      bar($(".hf", row), (counts[a] / max) * 100, intro(row));
      tween($(".hv", row), counts[a], fmtInt, intro(row) ? 0 : undefined);
    }

    // Ticker of the latest decisions.
    const list = $("#ai-ticker");
    const latest = D.llm.slice(0, 8);
    const first = seenTicker === null;
    if (first) seenTicker = new Set();
    if (!latest.length) {
      list.innerHTML = `<li><span class="ta fb" style="grid-column:1/-1">No AI decisions yet. AI bots use Claude while a person is at their table.</span></li>`;
      return;
    }
    list.innerHTML = latest
      .map((d) => {
        const key = `${d.at}|${d.bot}`;
        const fresh = !first && !seenTicker.has(key);
        seenTicker.add(key);
        const what = d.fallback ? `${d.action} · script (${d.fallback})` : d.action;
        return `<li class="${fresh ? "new" : ""}"><span class="tb">${esc(d.bot)}</span><span class="ta${d.fallback ? " fb" : ""}">${esc(what)} <span class="muted">· ${esc(d.table)}</span></span><span class="tm">${fmtSec(d.ms)}</span></li>`;
      })
      .join("");
  }

  // Leaderboard -----------------------------------------------------------
  const ROW_H = 64;
  const MAX_ROWS = 10;
  const lbRows = new Map();

  function renderLeaderboard(intro) {
    const box = $("#leaderboard");
    const players = [...D.snap.players].filter((p) => !p.banned).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, MAX_ROWS);
    const maxAbs = Math.max(100, ...players.map((p) => Math.abs(p.total - 10_000)));
    const keep = new Set(players.map((p) => p.id));
    for (const [id, row] of lbRows) {
      if (keep.has(id)) continue;
      row.style.opacity = "0";
      setTimeout(() => row.remove(), 500);
      lbRows.delete(id);
    }
    const empty = $(".empty", box);
    if (!players.length) {
      if (!empty) box.insertAdjacentHTML("beforeend", `<div class="empty">Nobody has played yet.</div>`);
      return;
    }
    empty?.remove();
    players.forEach((p, i) => {
      let row = lbRows.get(p.id);
      if (!row) {
        row = document.createElement("div");
        row.className = "lb-row enter";
        row.innerHTML = `<span class="lb-rank"></span><span class="lb-name"></span><span class="lb-track"><span class="lb-mid"></span><span class="lb-fill"></span></span><span class="lb-total num"></span><span class="lb-net"></span>`;
        row.style.transform = `translateY(${i * ROW_H}px)`;
        box.appendChild(row);
        lbRows.set(p.id, row);
        requestAnimationFrame(() => row.classList.remove("enter"));
      }
      const net = p.total - 10_000;
      row.classList.toggle("down", net < 0);
      row.classList.toggle("flat", net === 0);
      row.style.transform = `translateY(${i * ROW_H}px)`;
      $(".lb-rank", row).textContent = String(i + 1);
      $(".lb-name", row).textContent = p.name;
      $(".lb-name", row).title = p.name;
      const fill = $(".lb-fill", row);
      const w = (Math.abs(net) / maxAbs) * 50;
      // Diverging from the $10,000 start line in the middle: wins grow right, losses grow left.
      fill.style.left = net >= 0 ? "50%" : "auto";
      fill.style.right = net >= 0 ? "auto" : "50%";
      bar(fill, w, intro(box));
      const isIntro = intro(box);
      tween($(".lb-total", row), p.total, fmtDD, isIntro ? 10_000 : undefined);
      tween($(".lb-net", row), net, fmtSigned, isIntro ? 0 : undefined);
    });
  }

  // Conservation ----------------------------------------------------------
  function renderConservation(intro) {
    const t = D.snap.totals;
    const from = intro($("#c-total")) ? 0 : undefined;
    tween($("#c-total"), t.total, fmtDD, from);
    tween($("#c-expected"), t.expected, fmtDD, from);
    $("#c-op").textContent = t.conserved ? "=" : "≠";
    const status = $("#c-status");
    status.textContent = t.conserved ? "Conserved: every Dining Dollar accounted for" : "Mismatch";
    status.classList.toggle("bad", !t.conserved);
    const parts = [
      ["Players' bankrolls", t.bankrolls],
      ["House bank", t.house],
      ["On poker tables", t.onPokerTables],
      ["On blackjack tables", t.onBlackjackTables],
    ];
    const box = $("#c-split");
    if (!box.children.length) {
      box.innerHTML = parts.map(([label]) => `<div class="cs-row"><span>${label}</span><span class="ht"><span class="hf"></span></span><span class="v">$0</span></div>`).join("");
    }
    [...box.children].forEach((row, i) => {
      const value = parts[i][1];
      bar($(".hf", row), t.total ? (value / t.total) * 100 : 0, intro(row));
      tween($(".v", row), value, fmtDD, intro(row) ? 0 : undefined);
    });
  }

  // Players online line ---------------------------------------------------
  function renderOnline(intro) {
    const svg = $("#online-line");
    const pts = D.online.slice(-180);
    const now = D.snap.totals.playersOnline;
    tween($("#ol-now"), now, fmtInt, intro(svg) ? 0 : undefined);
    if (pts.length < 2) {
      svg.innerHTML = `<text x="400" y="66" text-anchor="middle" class="e-label">Collecting… one point every 5 s</text>`;
      return;
    }
    const W = 800;
    const H = 120;
    const t0 = pts[0].at;
    const t1 = pts[pts.length - 1].at;
    const max = Math.max(4, ...pts.map((p) => p.online));
    const x = (at) => ((at - t0) / Math.max(1, t1 - t0)) * W;
    const y = (v) => H - 6 - (v / max) * (H - 18);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)} ${y(p.online).toFixed(1)}`).join(" ");
    const replay = intro(svg) && !reduced;
    svg.innerHTML = `<line x1="0" x2="${W}" y1="${H - 6}" y2="${H - 6}" stroke="#2e2e2e" vector-effect="non-scaling-stroke"/>
      <path d="${d}" fill="none" stroke="#ffb81c" stroke-width="2.5" vector-effect="non-scaling-stroke" pathLength="1"
        style="stroke-dasharray:1 1;stroke-dashoffset:${replay ? 1 : 0};transition:stroke-dashoffset 1.2s cubic-bezier(.2,.7,.2,1)"/>`;
    if (replay) {
      const path = $("path", svg);
      void path.getBoundingClientRect();
      requestAnimationFrame(() => (path.style.strokeDashoffset = "0"));
    }
  }

  // Hands feed ------------------------------------------------------------
  let seenHands = null;
  function renderHands() {
    const list = $("#hands-feed");
    const first = seenHands === null;
    if (first) seenHands = new Set();
    const entries = D.hands.slice(0, 5);
    if (!entries.length) {
      list.innerHTML = `<li><span class="fs muted">No hands with players yet.</span></li>`;
      return;
    }
    list.innerHTML = entries
      .map((e) => {
        const fresh = !first && !seenHands.has(e.id);
        seenHands.add(e.id);
        const game = e.game === "blackjack" ? "Blackjack" : "Poker";
        return `<li class="${fresh ? "new" : ""}"><span class="fs" title="${esc(e.summary)}"><span class="ft">${game} · ${esc(e.table?.name ?? "")} · </span>${esc(e.summary)}</span><span class="fa">${ago(e.at)}</span></li>`;
      })
      .join("");
    // Show only whole rows: hide any row that would be cut off by the bottom of its panel.
    const panel = list.closest(".panel");
    for (const li of list.children) li.hidden = li.offsetTop + li.offsetHeight > panel.clientHeight - 14;
  }

  // itcan.do chat recreation ---------------------------------------------
  function renderItChat(intro) {
    const ranked = [...D.snap.players].sort((a, b) => b.total - a.total);
    const [a, b] = ranked;
    let text = "Nobody has joined yet.";
    if (a && a.total - 10_000 > 0) {
      text = `${a.name} is up ${fmtDD(a.total - 10_000)}`;
      text += b ? `, ahead of ${b.name} at ${fmtSigned(b.total - 10_000)}.` : ".";
    } else if (a) {
      text = `Nobody is up yet. ${a.name} leads with ${fmtDD(a.total)}.`;
    }
    $("#it-answer").textContent = text;
    const top = ranked.slice(0, 3);
    const max = Math.max(1, ...top.map((p) => Math.abs(p.total - 10_000)));
    const box = $("#it-chart");
    box.innerHTML = top
      .map((p) => `<div class="hbar${p.total < 10_000 ? " alt" : ""}"><span class="hl">${esc(p.name)}</span><span class="ht"><span class="hf"></span></span><span class="hv">${fmtSigned(p.total - 10_000)}</span></div>`)
      .join("");
    [...box.children].forEach((row, i) => {
      const fill = $(".hf", row);
      fill.style.transition = "none";
      fill.style.width = `${(box._w?.[i] ?? 0)}%`;
      void fill.offsetWidth;
      fill.style.transition = "";
      const w = (Math.abs(top[i].total - 10_000) / max) * 100;
      bar(fill, w, intro(box));
      (box._w ??= [])[i] = w;
    });
  }

  // ---------- code highlighting ----------
  const KEYWORDS = {
    ts: new Set(["async", "await", "const", "let", "return", "try", "catch", "throw", "if", "else", "new", "this", "function", "typeof"]),
    cpp: new Set(["const", "void", "return", "if", "else", "for", "static", "inline", "volatile", "bool"]),
  };
  const TYPES = /^(u?int\d+_t|[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*)$/;
  function highlight(src, lang) {
    const re = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\b(0b[01]+|\d+)\b|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/g;
    let out = "";
    let last = 0;
    for (let m; (m = re.exec(src)); ) {
      out += esc(src.slice(last, m.index));
      last = re.lastIndex;
      const [tok, comment, str, num, call, word] = m;
      let cls = null;
      if (comment) cls = "c";
      else if (str) cls = "s";
      else if (num) cls = "n";
      else if (call) cls = KEYWORDS[lang].has(call) ? "k" : "f";
      else if (word) cls = KEYWORDS[lang].has(word) ? "k" : TYPES.test(word) ? "t" : null;
      out += cls ? `<span class="tk-${cls}">${esc(tok)}</span>` : esc(tok);
    }
    return out + esc(src.slice(last));
  }
  function buildCode() {
    for (const pre of $$("pre.code")) {
      const src = document.getElementById(pre.dataset.src)?.textContent ?? "";
      pre.innerHTML = highlight(src.replace(/^\n/, ""), pre.dataset.lang);
      // Shrink until it fits its panel (the deck is a fixed 1920x1080 stage, so this runs once).
      let size = 20;
      pre.style.fontSize = `${size}px`;
      while ((pre.scrollHeight > pre.clientHeight || pre.scrollWidth > pre.clientWidth) && size > 13) {
        size -= 0.5;
        pre.style.fontSize = `${size}px`;
      }
    }
  }

  // ---------- HootBox wiring diagram ----------
  function buildWiring() {
    const svg = $("#wiring");
    const g = (cls, d) => svgEl("g", { class: cls, style: `--d:${d}ms` }, svg);
    // Board
    const board = g("node", 150);
    svgEl("rect", { class: "n-box", x: 40, y: 80, width: 380, height: 480 }, board);
    svgText(board, 70, 128, "ELEGOO MEGA2560 R3", "w-label", "start");
    svgText(board, 70, 154, "USB-B → PC (Web Serial)", "w-small", "start");
    const pins = [["D2", 180, "INT"], ["D3", 220, "INT"], ["D4", 260, ""], ["5V", 300, ""], ["GND", 340, ""], ["D5", 380, ""], ["D6", 420, ""]];
    for (const [name, y, note] of pins) {
      svgEl("rect", { x: 412, y: y - 8, width: 16, height: 16, fill: "#ffb81c" }, board);
      svgText(board, 400, y + 6, note ? `${name} · ${note}` : name, "w-label", "end");
    }
    svgEl("rect", { x: 372, y: 552, width: 16, height: 16, fill: "#ffb81c" }, board);
    svgText(board, 380, 540, "GND", "w-label", "middle");
    // Encoder
    const enc = g("node", 300);
    svgEl("rect", { class: "n-box", x: 620, y: 60, width: 290, height: 250 }, enc);
    svgText(enc, 765, 96, "KY-040 encoder", "w-label");
    svgEl("circle", { cx: 812, cy: 200, r: 56, fill: "#1c1c1c", stroke: "#8a8a8a", "stroke-width": 1.5 }, enc);
    svgEl("circle", { cx: 812, cy: 200, r: 30, fill: "#0a0a0a", stroke: "#ffb81c", "stroke-width": 1.5 }, enc);
    svgEl("line", { x1: 812, y1: 172, x2: 812, y2: 188, stroke: "#ffb81c", "stroke-width": 3 }, enc);
    const encPins = [["CLK", 120], ["DT", 160], ["SW", 200], ["+", 240], ["GND", 280]];
    for (const [name, y] of encPins) {
      svgEl("rect", { x: 612, y: y - 8, width: 16, height: 16, fill: "#ffb81c" }, enc);
      svgText(enc, 640, y + 6, name, "w-label", "start");
    }
    // Buttons
    for (const [name, y, d] of [["A", 430, 380], ["B", 510, 420]]) {
      const btn = g("node", d);
      svgEl("rect", { class: "n-box", x: 700, y, width: 60, height: 50 }, btn);
      svgEl("circle", { cx: 730, cy: y + 25, r: 15, fill: "#ffb81c" }, btn);
      svgText(btn, 808, y + 33, `Button ${name}`, "w-label", "start");
    }
    // Wires: signals gold, 5V white, GND grey. Channels chosen so no two wires cross.
    const wire = (color, d, delay) => {
      const eg = g("edge", delay);
      svgEl("path", { class: "ln", d, pathLength: 1, style: `stroke:${color};stroke-width:3` }, eg);
    };
    let t = 500;
    wire("#ffb81c", "M428 180 H470 V120 H612", (t += 90));
    wire("#ffb81c", "M428 220 H490 V160 H612", (t += 90));
    wire("#ffb81c", "M428 260 H510 V200 H612", (t += 90));
    wire("#f2f2f2", "M428 300 H530 V240 H612", (t += 90));
    wire("#7a7a7a", "M428 340 H550 V280 H612", (t += 90));
    wire("#ffb81c", "M428 380 H590 V445 H700", (t += 90));
    wire("#ffb81c", "M428 420 H570 V525 H700", (t += 90));
    wire("#7a7a7a", "M760 465 H790 V600 H380 V568", (t += 90));
    wire("#7a7a7a", "M760 545 H790", (t += 90));
  }

  // ---------- start ----------
  function start() {
    buildPokerStates();
    buildBlackjackStates();
    buildFlow();
    buildWiring();
    buildCode();
    go(fromHash(), 1);
    pollSnapshot();
    pollDetails();
  }
  // Wait for the inlined fonts so text measurements (labels, code fitting, the join URL) are right.
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(start, start);
})();
