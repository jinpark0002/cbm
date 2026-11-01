// Paper Radar — static front-end. Data: data/papers.json (daily build) + live OpenAlex for custom keywords.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SLOTS = 8;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  data: null,
  view: store.get("pr.view", "feed"),
  selected: new Set(store.get("pr.selected", [])),
  query: "",
  custom: store.get("pr.custom", []),        // [{id,name,query}]
  customData: {},                            // id -> topic payload
  saved: store.get("pr.saved", {}),          // id -> {paper, status, at}
  hiddenSeries: new Set(),
  journal: null,
};

/* ---------- theme ---------- */
const themeBtn = $("#theme-toggle");
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(store.get("pr.theme", null));
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  applyTheme(next); store.set("pr.theme", next);
  if (state.view === "trends") render();
});

/* ---------- helpers ---------- */
const TODAY = new Date();
const daysAgo = (d) => d ? Math.floor((TODAY - new Date(d + "T00:00:00")) / 864e5) : 9999;
const fmtDate = (d) => {
  if (!d) return "";
  const n = daysAgo(d);
  if (n <= 0) return "오늘";
  if (n === 1) return "어제";
  if (n < 7) return `${n}일 전`;
  const dt = new Date(d + "T00:00:00");
  return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, "0")}.${String(dt.getDate()).padStart(2, "0")}`;
};
const fmtNum = (n) => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
const authorLine = (p) => {
  if (!p.authors?.length) return "";
  const shown = p.authors.slice(0, 3).join(", ");
  const extra = (p.n_authors || p.authors.length) - 3;
  return extra > 0 ? `${shown} 외 ${extra}명` : shown;
};

function allTopics() {
  const base = state.data?.topics ?? [];
  const custom = state.custom.map((c) => state.customData[c.id] ?? { ...c, latest: [], hot: [], trend: [], keywords: [], loading: true });
  return [...base, ...custom.map((t) => ({ ...t, custom: true }))];
}
function topicColor(i) { return i < SLOTS ? `var(--s${i + 1})` : "var(--ink-3)"; }
function colorOf(topicId) {
  const i = allTopics().findIndex((t) => t.id === topicId);
  return i < 0 ? "var(--line)" : topicColor(i);
}
function activeTopics() {
  const ts = allTopics();
  return state.selected.size ? ts.filter((t) => state.selected.has(t.id)) : ts;
}
function matches(p) {
  if (!state.query) return true;
  const hay = [p.title, p.venue, p.abstract, ...(p.authors || []), ...(p.keywords || [])].join(" ").toLowerCase();
  return state.query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
function collect(kind) {
  const seen = new Map();
  for (const t of activeTopics()) {
    for (const p of t[kind] || []) {
      if (!seen.has(p.id)) seen.set(p.id, { ...p, topic: t.id, topicName: t.name });
    }
  }
  return [...seen.values()].filter(matches);
}

/* ---------- live OpenAlex for custom keywords ---------- */
const OA = "https://api.openalex.org/works";
const SELECT = "id,doi,display_name,publication_date,publication_year,authorships,primary_location,cited_by_count,counts_by_year,abstract_inverted_index,keywords,open_access,primary_topic";
function iso(d) { return d.toISOString().slice(0, 10); }
function slim(w) {
  const loc = w.primary_location || {}; const src = loc.source || {};
  const inv = w.abstract_inverted_index; let abs = "";
  if (inv) { const pos = []; for (const [word, idx] of Object.entries(inv)) for (const i of idx) pos[i] = word; abs = pos.filter(Boolean).join(" ").slice(0, 1800); }
  const authors = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
  return {
    id: w.id.split("/").pop(), title: w.display_name || "", doi: w.doi,
    url: loc.landing_page_url || w.doi || w.id, oa_url: w.open_access?.oa_url,
    date: w.publication_date, year: w.publication_year, venue: src.display_name,
    authors: authors.slice(0, 8), n_authors: authors.length, cites: w.cited_by_count || 0,
    cites_by_year: Object.fromEntries((w.counts_by_year || []).map((c) => [String(c.year), c.cited_by_count])),
    abstract: abs, keywords: (w.keywords || []).map((k) => k.display_name).filter(Boolean).slice(0, 6),
  };
}
function hotScore(p) {
  const age = Math.max(daysAgo(p.date) / 30.44, 0) + 3;
  return Math.round(((p.cites / Math.pow(age, 1.1)) * 10 + (p.cites_by_year[String(TODAY.getFullYear())] || 0) * 0.5) * 100) / 100;
}
async function fetchCustom(t) {
  const cacheKey = "pr.cache." + t.id + "." + iso(TODAY);
  try { const c = sessionStorage.getItem(cacheKey); if (c) return JSON.parse(c); } catch { /* ignore */ }
  const fields = "primary_topic.field.id:14|32";
  const q = (params) => fetch(OA + "?" + new URLSearchParams(params)).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const since = (days) => iso(new Date(TODAY - days * 864e5));
  const [latest, hot, trend] = await Promise.all([
    q({ search: t.query, filter: `from_publication_date:${since(120)},to_publication_date:${iso(TODAY)},type:article,${fields}`, sort: "publication_date:desc", "per-page": 40, select: SELECT }),
    q({ search: t.query, filter: `from_publication_date:${since(730)},to_publication_date:${iso(TODAY)},type:article,${fields}`, sort: "cited_by_count:desc", "per-page": 100, select: SELECT }),
    q({ search: t.query, filter: `publication_year:${TODAY.getFullYear() - 9}-${TODAY.getFullYear()},type:article,${fields}`, group_by: "publication_year" }),
  ]);
  const hotList = hot.results.map(slim).map((p) => ({ ...p, hot: hotScore(p), gain30: 0 })).sort((a, b) => b.hot - a.hot).slice(0, 40);
  const latestList = latest.results.map(slim);
  const kw = {};
  for (const p of [...latestList, ...hotList]) for (const k of p.keywords) kw[k.toLowerCase()] = (kw[k.toLowerCase()] || 0) + 1;
  const payload = {
    id: t.id, name: t.name, en: "", query: t.query, latest: latestList, hot: hotList,
    trend: trend.group_by.map((g) => ({ year: +g.key, count: g.count })).sort((a, b) => a.year - b.year),
    keywords: Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => ({ k, n })),
  };
  try { sessionStorage.setItem(cacheKey, JSON.stringify(payload)); } catch { /* ignore */ }
  return payload;
}
async function loadCustom(t) {
  try { state.customData[t.id] = await fetchCustom(t); }
  catch (e) { state.customData[t.id] = { ...t, latest: [], hot: [], trend: [], keywords: [], error: true }; }
  renderChips(); render();
}

/* ---------- chips ---------- */
function renderChips() {
  const el = $("#topic-chips");
  const ts = allTopics();
  el.innerHTML = `<button class="chip" aria-pressed="${state.selected.size === 0}" data-topic="">전체</button>` +
    ts.map((t, i) => `<button class="chip${t.custom ? " custom" : ""}" style="--c:${topicColor(i)}" aria-pressed="${state.selected.has(t.id)}" data-topic="${esc(t.id)}" title="${esc(t.en || t.query)}">
      <span class="swatch"></span>${esc(t.name)}${t.loading ? " …" : ""}${t.error ? " ⚠" : ""}
      ${t.custom ? `<span class="x" data-remove="${esc(t.id)}" role="button" aria-label="${esc(t.name)} 삭제">×</span>` : ""}
    </button>`).join("");
}
$("#topic-chips").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-remove]");
  if (rm) {
    e.stopPropagation();
    const id = rm.dataset.remove;
    if (!confirm("이 키워드를 삭제할까요?")) return;
    state.custom = state.custom.filter((c) => c.id !== id); state.selected.delete(id);
    store.set("pr.custom", state.custom); store.set("pr.selected", [...state.selected]);
    renderChips(); render(); return;
  }
  const b = e.target.closest("[data-topic]"); if (!b) return;
  const id = b.dataset.topic;
  if (!id) state.selected.clear();
  else if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  store.set("pr.selected", [...state.selected]);
  renderChips(); render();
});

/* ---------- custom topic dialog ---------- */
const dlg = $("#topic-dialog");
$("#add-topic").addEventListener("click", () => { $("#topic-form").reset(); dlg.showModal(); });
dlg.addEventListener("close", () => {
  if (dlg.returnValue !== "ok") return;
  const f = new FormData($("#topic-form"));
  const t = { id: "c" + Date.now().toString(36), name: f.get("name").trim(), query: f.get("query").trim() };
  if (!t.name || !t.query) return;
  state.custom.push(t); store.set("pr.custom", state.custom);
  state.selected = new Set([t.id]); store.set("pr.selected", [...state.selected]);
  renderChips(); render(); loadCustom(t);
});

/* ---------- search & tabs ---------- */
let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); render(); }, 150);
});
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]"); if (!b) return;
  setView(b.dataset.view);
});
function setView(v) {
  state.view = v; store.set("pr.view", v);
  document.querySelectorAll(".tabs [data-view]").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === v));
  render(); window.scrollTo({ top: 0 });
}

/* ---------- saved ---------- */
const STATUS = { todo: "읽을 것", reading: "읽는 중", done: "다 읽음" };
function toggleSave(p) {
  if (state.saved[p.id]) delete state.saved[p.id];
  else state.saved[p.id] = { paper: p, status: "todo", at: Date.now() };
  store.set("pr.saved", state.saved); updateSavedCount();
}
function updateSavedCount() {
  const n = Object.values(state.saved).filter((s) => s.status !== "done").length;
  $("#saved-count").textContent = n || "";
}

/* ---------- card ---------- */
const ICON = {
  save: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  pdf: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
};
function spark(p) {
  const y = TODAY.getFullYear();
  const yrs = [y - 4, y - 3, y - 2, y - 1, y];
  const vals = yrs.map((yy) => p.cites_by_year?.[yy] || 0);
  const max = Math.max(...vals, 1);
  if (vals.every((v) => v === 0)) return "";
  const w = 64, h = 18, bw = 10, gap = 3.5;
  const bars = vals.map((v, i) => {
    const bh = Math.max((v / max) * h, v ? 2 : 0.8);
    return `<rect x="${i * (bw + gap)}" y="${h - bh}" width="${bw}" height="${bh}" rx="2"${i === 4 ? ' opacity="1"' : ' opacity=".55"'}><title>${yrs[i]}년 인용 ${v}회</title></rect>`;
  }).join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="최근 5년 연도별 인용 수: ${vals.join(", ")}">${bars}</svg>`;
}
function card(p, opts = {}) {
  const c = colorOf(p.topic);
  const isNew = daysAgo(p.date) <= 7;
  const saved = !!state.saved[p.id];
  const body = `
    <div class="card-meta">
      ${p.venue ? `<span class="venue">${esc(p.venue)}</span><span aria-hidden="true">·</span>` : ""}
      <span>${fmtDate(p.date)}</span>
      ${isNew ? '<span class="badge new">NEW</span>' : ""}
      ${opts.hot && p.gain30 > 0 ? `<span class="badge hot">▲ 30일 +${p.gain30}</span>` : ""}
      ${p.topicName && !opts.noTopic ? `<span class="badge" style="color:var(--ink-2)"><span style="width:7px;height:7px;border-radius:50%;background:${c};display:inline-block"></span>${esc(p.topicName)}</span>` : ""}
    </div>
    <h3><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a></h3>
    ${p.authors?.length ? `<p class="authors">${esc(authorLine(p))}</p>` : ""}
    ${p.abstract ? `<p class="abstract">${esc(p.abstract)}</p><button class="more" type="button" data-more>초록 더 보기</button>` : ""}
    ${p.keywords?.length ? `<div class="kw">${p.keywords.slice(0, 4).map((k) => `<span>${esc(k)}</span>`).join("")}</div>` : ""}
    <div class="card-foot">
      <div class="stats"><span title="총 인용 수">인용 <b>${fmtNum(p.cites)}</b></span>${spark(p)}</div>
      <div class="actions">
        ${p.oa_url ? `<a class="act" href="${esc(p.oa_url)}" target="_blank" rel="noopener" title="무료 원문">${ICON.pdf}<span>원문</span></a>` : ""}
        <button class="act" type="button" data-save="${esc(p.id)}" aria-pressed="${saved}" title="${saved ? "읽을 목록에서 빼기" : "읽을 목록에 담기"}">${ICON.save}<span>${saved ? "담음" : "담기"}</span></button>
      </div>
    </div>`;
  if (opts.rank) {
    return `<article class="card" style="--c:${c}" data-id="${esc(p.id)}"><div class="rank">${String(opts.rank).padStart(2, "0")}</div><div class="card-body">${body}</div></article>`;
  }
  return `<article class="card" style="--c:${c}" data-id="${esc(p.id)}">${body}</article>`;
}
let paperIndex = new Map();
function indexPapers(list) { for (const p of list) paperIndex.set(p.id, p); }
$("#view").addEventListener("click", (e) => {
  const more = e.target.closest("[data-more]");
  if (more) {
    const abs = more.previousElementSibling; const open = abs.classList.toggle("open");
    more.textContent = open ? "접기" : "초록 더 보기"; return;
  }
  const sv = e.target.closest("[data-save]");
  if (sv) {
    const p = paperIndex.get(sv.dataset.save) || state.saved[sv.dataset.save]?.paper; if (!p) return;
    toggleSave(p);
    const on = !!state.saved[p.id];
    sv.setAttribute("aria-pressed", on); sv.querySelector("span").textContent = on ? "담음" : "담기";
    if (state.view === "saved") render();
    return;
  }
  const kw = e.target.closest("[data-kw]");
  if (kw) { $("#search").value = kw.dataset.kw; state.query = kw.dataset.kw; setView("feed"); return; }
  const j = e.target.closest("[data-journal]");
  if (j) { state.journal = state.journal === j.dataset.journal ? null : j.dataset.journal; render(); }
});
$("#view").addEventListener("change", (e) => {
  const s = e.target.closest("[data-status]"); if (!s) return;
  const it = state.saved[s.dataset.status]; if (!it) return;
  it.status = s.value; store.set("pr.saved", state.saved); updateSavedCount(); render();
});

/* ---------- views ---------- */
function emptyState(title, msg) { return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(msg)}</p></div>`; }

function viewFeed() {
  const list = collect("latest").sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  indexPapers(list);
  const week = list.filter((p) => daysAgo(p.date) <= 7).length;
  const month = list.filter((p) => daysAgo(p.date) <= 30).length;
  const oa = list.filter((p) => p.oa_url).length;
  const tiles = `<div class="tiles">
    <div class="tile"><div class="label">이번 주 새 논문</div><div class="value">${week}</div><div class="sub">최근 7일</div></div>
    <div class="tile"><div class="label">이번 달</div><div class="value">${month}</div><div class="sub">최근 30일</div></div>
    <div class="tile"><div class="label">무료로 읽을 수 있는 논문</div><div class="value">${oa}</div><div class="sub">전체 ${list.length}편 중</div></div>
  </div>`;
  if (!list.length) return tiles + emptyState("조건에 맞는 논문이 없어요", "주제나 검색어를 바꿔 보세요.");
  return tiles + `<div class="section-head"><h2>최신 논문</h2><span class="note">최근 120일 · 최신순</span></div>
    <div class="grid">${list.slice(0, 90).map((p) => card(p)).join("")}</div>`;
}

function viewHot() {
  const list = collect("hot").sort((a, b) => b.hot - a.hot).slice(0, 40);
  indexPapers(list);
  if (!list.length) return emptyState("조건에 맞는 논문이 없어요", "주제나 검색어를 바꿔 보세요.");
  return `<div class="section-head"><h2>지금 뜨는 논문</h2><span class="note">최근 2년 논문 · 나이 대비 인용 속도와 최근 30일 인용 증가로 순위</span></div>
    <div class="ranked">${list.map((p, i) => card(p, { rank: i + 1, hot: true })).join("")}</div>`;
}

function viewJournals() {
  const feed = (state.data?.journal_feed || []).filter(matches);
  const journals = state.data?.journals || [];
  const counts = journals.map((j) => ({ ...j, n: feed.filter((p) => (p.venue || "").toLowerCase() === j.name.toLowerCase()).length }));
  const max = Math.max(...counts.map((c) => c.n), 1);
  const list = (state.journal ? feed.filter((p) => (p.venue || "").toLowerCase() === state.journal.toLowerCase()) : feed)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  indexPapers(list);
  const bars = `<div class="panel"><h3>저널별 신간 수</h3><p class="desc">최근 90일 · 막대를 누르면 그 저널만 볼 수 있어요</p>
    <div class="bars">${counts.sort((a, b) => b.n - a.n).map((j) => `
      <button class="bar-row" data-journal="${esc(j.name)}" style="border:0;background:none;padding:2px 0;text-align:left;${state.journal && state.journal !== j.name ? "opacity:.45" : ""}" title="${esc(j.name)}: ${j.n}편">
        <span class="name">${esc(j.short)} <span style="color:var(--ink-3)">${esc(j.name)}</span></span>
        <span class="track"><span class="fill" style="display:block;width:${(j.n / max) * 100}%;--c:var(--accent)"></span></span>
        <span class="n">${j.n}</span>
      </button>`).join("")}</div></div>`;
  return bars + `<div class="section-head"><h2>${state.journal ? esc(state.journal) : "주요 저널 신간"}</h2><span class="note">${list.length}편</span></div>` +
    (list.length ? `<div class="grid">${list.map((p) => card(p, { noTopic: true })).join("")}</div>` : emptyState("아직 신간이 없어요", "데이터가 업데이트되면 여기에 나타나요."));
}

function viewSaved() {
  const items = Object.values(state.saved).filter((s) => matches(s.paper)).sort((a, b) => b.at - a.at);
  indexPapers(items.map((s) => s.paper));
  if (!items.length) return emptyState("읽을 목록이 비어 있어요", "논문 카드의 '담기'를 누르면 여기에 모여요.");
  const groups = Object.entries(STATUS).map(([k, label]) => {
    const g = items.filter((s) => s.status === k);
    if (!g.length) return "";
    return `<div class="section-head"><h2>${label}</h2><span class="note">${g.length}편</span></div>
      <div class="grid">${g.map((s) => card(s.paper).replace('<div class="actions">', `<div class="actions"><select class="status-select" data-status="${esc(s.paper.id)}" aria-label="읽기 상태">${Object.entries(STATUS).map(([v, l]) => `<option value="${v}"${v === s.status ? " selected" : ""}>${l}</option>`).join("")}</select>`)).join("")}</div>`;
  }).join("");
  return groups;
}

/* ---------- trends (SVG line chart) ---------- */
function viewTrends() {
  const ts = activeTopics();
  const idx = (t) => allTopics().findIndex((x) => x.id === t.id);
  const series = ts.filter((t) => t.trend?.length).map((t) => ({ id: t.id, name: t.name, c: topicColor(idx(t)), pts: t.trend }));
  const recent = ts.map((t) => ({ name: t.name, c: topicColor(idx(t)), n: (t.latest || []).filter((p) => daysAgo(p.date) <= 30).length, hot: (t.hot || []).reduce((s, p) => s + (p.gain30 || 0), 0) }));
  const kw = {};
  for (const t of ts) for (const { k, n } of t.keywords || []) kw[k] = (kw[k] || 0) + n;
  const cloud = Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, 36);
  const kmax = cloud[0]?.[1] || 1, kmin = cloud.at(-1)?.[1] || 1;
  const rmax = Math.max(...recent.map((r) => r.n), 1);

  return `<div class="section-head"><h2>분야 트렌드</h2><span class="note">주제를 위에서 골라 비교해 보세요</span></div>
  <div class="panels">
    <div class="panel" style="grid-column:1/-1">
      <h3>연도별 논문 수</h3>
      <p class="desc">최근 10년 · 경영·심리 분야 학술지 논문 · 올해는 진행 중이라 점선으로 표시</p>
      <div class="legend" id="legend">${series.length > 1 ? series.map((s) => `<button type="button" data-series="${esc(s.id)}" aria-pressed="${!state.hiddenSeries.has(s.id)}" style="--c:${s.c}"><i></i>${esc(s.name)}</button>`).join("") : ""}</div>
      <div class="chart" id="line-chart"></div>
      <button class="table-toggle" type="button" id="table-toggle">표로 보기</button>
      <div class="table-wrap" id="trend-table" hidden></div>
    </div>
    <div class="panel">
      <h3>최근 30일 새 논문</h3>
      <p class="desc">주제별 · 활발하게 연구되는 정도</p>
      <div class="bars">${recent.sort((a, b) => b.n - a.n).map((r) => `<div class="bar-row" title="${esc(r.name)}: ${r.n}편"><span class="name">${esc(r.name)}</span><span class="track"><span class="fill" style="display:block;width:${(r.n / rmax) * 100}%;--c:${r.c}"></span></span><span class="n">${r.n}</span></div>`).join("")}</div>
    </div>
    <div class="panel">
      <h3>자주 등장하는 키워드</h3>
      <p class="desc">글자가 클수록 많이 등장 · 누르면 그 키워드로 검색해요</p>
      <div class="cloud">${cloud.map(([k, n]) => {
        const sz = 12 + ((n - kmin) / Math.max(kmax - kmin, 1)) * 14;
        return `<button type="button" data-kw="${esc(k)}" style="font-size:${sz.toFixed(1)}px" title="${esc(k)}: ${n}회">${esc(k)}</button>`;
      }).join("") || '<span class="muted">키워드 데이터가 아직 없어요</span>'}</div>
    </div>
  </div>`;
}

function drawLineChart() {
  const host = $("#line-chart"); if (!host) return;
  const ts = activeTopics();
  const idx = (t) => allTopics().findIndex((x) => x.id === t.id);
  const all = ts.filter((t) => t.trend?.length).map((t) => ({ id: t.id, name: t.name, c: topicColor(idx(t)), pts: t.trend }));
  const series = all.filter((s) => !state.hiddenSeries.has(s.id));
  if (!all.length) { host.innerHTML = '<p class="muted">트렌드 데이터가 아직 없어요.</p>'; return; }
  const years = [...new Set(all.flatMap((s) => s.pts.map((p) => p.year)))].sort((a, b) => a - b);
  const W = Math.max(host.clientWidth, 300), H = W < 520 ? 240 : 300;
  const m = { t: 12, r: W < 520 ? 12 : 120, b: 26, l: 42 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ymaxRaw = Math.max(...series.flatMap((s) => s.pts.map((p) => p.count)), 1);
  const step = niceStep(ymaxRaw / 4); const ymax = Math.ceil(ymaxRaw / step) * step;
  const x = (yr) => m.l + (years.length === 1 ? iw / 2 : ((yr - years[0]) / (years.at(-1) - years[0])) * iw);
  const y = (v) => m.t + ih - (v / ymax) * ih;
  const curYear = TODAY.getFullYear();
  let g = "";
  for (let v = 0; v <= ymax; v += step) g += `<line class="grid-line" x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-text" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`;
  const every = W < 520 ? 3 : 1;
  years.forEach((yr, i) => { if (i % every === 0 || i === years.length - 1) g += `<text class="axis-text" x="${x(yr)}" y="${H - 6}" text-anchor="middle">${String(yr).slice(2)}년</text>`; });
  const lines = series.map((s) => {
    const done = s.pts.filter((p) => p.year < curYear), cur = s.pts.filter((p) => p.year >= curYear - 1);
    const d = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.year).toFixed(1)},${y(p.count).toFixed(1)}`).join("");
    const last = s.pts.at(-1);
    return `<path class="line" d="${d(done)}" stroke="${s.c}"/>` +
      (cur.length > 1 && cur.at(-1).year === curYear ? `<path class="line" d="${d(cur)}" stroke="${s.c}" stroke-dasharray="4 4"/>` : "") +
      (W >= 520 ? `<text class="label-text" x="${x(last.year) + 8}" y="${y(last.count) + 4}" data-label="${esc(s.id)}">${esc(s.name)}</text>` : "");
  }).join("");
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="주제별 연도별 논문 수 선 그래프">${g}${lines}<g id="hover-layer"></g><rect id="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
  dodgeLabels(host);

  const svg = host.querySelector("svg"), layer = $("#hover-layer", svg), tip = $("#tooltip");
  const hide = () => { layer.innerHTML = ""; tip.hidden = true; };
  const show = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const yr = years.reduce((best, yy) => Math.abs(x(yy) - px) < Math.abs(x(best) - px) ? yy : best, years[0]);
    const rows = series.map((s) => ({ s, v: s.pts.find((p) => p.year === yr)?.count })).filter((r) => r.v != null).sort((a, b) => b.v - a.v);
    layer.innerHTML = `<line class="cross" x1="${x(yr)}" x2="${x(yr)}" y1="${m.t}" y2="${m.t + ih}"/>` +
      rows.map((r) => `<circle class="pt" cx="${x(yr)}" cy="${y(r.v)}" r="4.5" fill="${r.s.c}"/>`).join("");
    tip.innerHTML = `<div style="margin-bottom:4px;font-weight:500">${yr}년${yr === curYear ? " (진행 중)" : ""}</div>` +
      rows.map((r) => `<div class="row"><span><i style="--c:${r.s.c}"></i>${esc(r.s.name)}</span><b>${r.v.toLocaleString()}</b></div>`).join("");
    tip.hidden = false;
    const tx = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8);
    tip.style.left = tx + "px"; tip.style.top = Math.max(ev.clientY - tip.offsetHeight - 12, 8) + "px";
  };
  const hit = $("#hit", svg);
  hit.addEventListener("pointermove", show); hit.addEventListener("pointerdown", show); hit.addEventListener("pointerleave", hide);

  const tbl = $("#trend-table");
  tbl.innerHTML = `<table class="data"><thead><tr><th>주제</th>${years.map((y) => `<th>${y}</th>`).join("")}</tr></thead><tbody>${all.map((s) => `<tr><td>${esc(s.name)}</td>${years.map((yy) => `<td>${(s.pts.find((p) => p.year === yy)?.count ?? "–").toLocaleString()}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function dodgeLabels(host) {
  const labels = [...host.querySelectorAll("[data-label]")].sort((a, b) => +a.getAttribute("y") - +b.getAttribute("y"));
  let prev = -Infinity;
  for (const l of labels) { let yy = +l.getAttribute("y"); if (yy - prev < 14) yy = prev + 14; l.setAttribute("y", yy); prev = yy; }
}

/* ---------- render ---------- */
function render() {
  const v = $("#view");
  if (!state.data) { v.innerHTML = `<div class="grid">${'<div class="skeleton"></div>'.repeat(6)}</div>`; return; }
  paperIndex = new Map();
  v.innerHTML = ({ feed: viewFeed, hot: viewHot, journals: viewJournals, trends: viewTrends, saved: viewSaved }[state.view] || viewFeed)();
  if (state.view === "trends") {
    drawLineChart();
    $("#legend")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-series]"); if (!b) return;
      const id = b.dataset.series;
      state.hiddenSeries.has(id) ? state.hiddenSeries.delete(id) : state.hiddenSeries.add(id);
      b.setAttribute("aria-pressed", !state.hiddenSeries.has(id)); drawLineChart();
    });
    $("#table-toggle").addEventListener("click", (e) => {
      const t = $("#trend-table"); t.hidden = !t.hidden; e.target.textContent = t.hidden ? "표로 보기" : "표 닫기";
    });
  }
}
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => state.view === "trends" && drawLineChart(), 150); });

async function init() {
  document.querySelectorAll(".tabs [data-view]").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === state.view));
  updateSavedCount(); render();
  try {
    const r = await fetch("data/papers.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    state.data = await r.json();
  } catch {
    state.data = { topics: [], journal_feed: [], journals: [] };
    $("#view").innerHTML = emptyState("아직 데이터가 없어요", "첫 자동 업데이트가 끝나면 논문이 나타나요. 잠시 후 새로고침해 주세요.");
  }
  const d = state.data;
  if (d.site_title) { $("#site-title").textContent = d.site_title; document.title = d.site_title; }
  if (d.subtitle) $("#site-subtitle").textContent = d.subtitle;
  if (d.updated) {
    const u = new Date(d.updated);
    $("#updated").textContent = `업데이트 ${u.getMonth() + 1}월 ${u.getDate()}일 ${String(u.getHours()).padStart(2, "0")}:${String(u.getMinutes()).padStart(2, "0")}`;
  }
  // drop selections for topics that no longer exist
  const ids = new Set(allTopics().map((t) => t.id));
  state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
  renderChips();
  if (d.topics.length || state.custom.length) render();
  state.custom.forEach(loadCustom);
}
init();
