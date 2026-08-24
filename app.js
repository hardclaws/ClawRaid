/* =========================================================================
 * Clawraid — a client-side (no backend) OBS raid dock / browser source.
 *
 * Auth: Twitch OAuth Implicit Grant (token lives only in your browser).
 * API : Twitch Helix. See README for setup.
 *
 * Three tabs:
 *   • Same Game    – EVERYONE live in your current category (followed first)
 *   • Following    – everyone you follow who is live (sortable; click a
 *                    category to jump to Discover filtered to it)
 *   • Discover     – live channels in your categories you DON'T follow
 *                    (+ tracked categories w/ language filter)
 *
 * No external dependencies, no build step.
 * ========================================================================= */
(function () {
  "use strict";

  const API = "https://api.twitch.tv/helix";
  const AUTH = "https://id.twitch.tv/oauth2/authorize";

  const BASE_SCOPES = ["user:read:follows", "user:edit:follows"];
  const RAID_SCOPE = "channel:manage:raids";

  // Owner: paste your Twitch Client ID here to enable ZERO-SETUP login.
  // The Client ID is public by design (sent in every request). Leave blank to
  // let each user supply their own.
  const EMBEDDED_CLIENT_ID = "t0bhs24dpvhywo3mhzw88rcrjhrtfm";

  const STORE = {
    clientId: "rd_client_id",
    redirect: "rd_redirect",
    token: "rd_token",
    exp: "rd_exp",
    settings: "rd_settings",
  };

  const DEFAULT_SETTINGS = {
    refreshSeconds: 60,
    raidsEnabled: true,
    refreshSuggestionsEvery: 2,
    sizeLower: 0.25,
    sizeUpper: 4,
    maxViewers: 5000,
    minViewers: 0,
    categories: [],
    compact: true,
    discoverFirst: 30,
    langAllow: [], // empty = show all languages; else only these
    cardThumb: "live", // "live" (stream preview) or "avatar" (profile picture)
    autoReconnect: true,
  };

  const S = {
    token: null,
    exp: 0,
    clientId: "",
    user: null,
    meViewers: 0,
    myGameId: null,
    myGameName: null,
    followedStreams: [],
    followedIds: null,
    derivedCategories: [],
    discoverStreams: [],
    sameGameStreams: null, // everyone live in myGameId (when live)
    filterGame: null, // { id, name } – Discover filtered to this category
    filterStreams: null,
    discoverFirst: 30,
    viewOpen: new Set(),
    viewCache: {},
    langHide: new Set(), // hidden language codes in Discover
    _viewLoading: null,
    sort: "viewers-desc",
    sortDir: "desc",
    activeTab: null,
    searchTerm: "",
    demo: false,
    cycle: 0,
    timer: null,
    loading: false,
  };

  const params = new URLSearchParams(location.search);
  S.demo = params.get("demo") === "1";

  /* ----------------------------- Helpers ------------------------------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }
  function save(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  let settings = Object.assign({}, DEFAULT_SETTINGS, load(STORE.settings, {}));
  function saveSettings() {
    save(STORE.settings, settings);
  }

  function defaultClientId() {
    if (EMBEDDED_CLIENT_ID) return EMBEDDED_CLIENT_ID;
    if (window.RD_CONFIG && window.RD_CONFIG.clientId) return window.RD_CONFIG.clientId;
    const fromUrl = params.get("client_id");
    if (fromUrl) return fromUrl;
    return load(STORE.clientId, "");
  }
  function redirectUri() {
    const saved = load(STORE.redirect, "");
    if (saved) return saved;
    return location.origin + location.pathname;
  }

  function jwtExp(token) {
    try {
      const p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const d = JSON.parse(atob(p));
      return d.exp || 0;
    } catch (e) {
      return 0;
    }
  }
  function isTokenValid() {
    return !!S.token && S.exp * 1000 > Date.now() + 5000;
  }

  function fmt(n) {
    return (n || 0).toLocaleString("en-US");
  }
  function fmtUptime(startedAt) {
    const ms = Date.now() - new Date(startedAt).getTime();
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }
  function thumbUrl(url, w, h) {
    if (!url) return "";
    return url.replace("{width}", w).replace("{height}", h);
  }
  function placeholder(seed, w, h, label) {
    const colors = ["#9146ff", "#772ce8", "#00b173", "#e0245e", "#ffca28", "#1f9cff", "#ff7ac6"];
    let hsh = 0;
    for (let i = 0; i < seed.length; i++) hsh = (hsh * 31 + seed.charCodeAt(i)) % colors.length;
    const c1 = colors[hsh];
    const c2 = colors[(hsh + 3) % colors.length];
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
      `<stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>` +
      `<rect width='100%' height='100%' fill='url(#g)'/>` +
      (label ? `<text x='50%' y='52%' font-family='sans-serif' font-size='${Math.floor(h / 4)}' fill='#fff' text-anchor='middle' dominant-baseline='middle' font-weight='700'>${label}</text>` : "") +
      `</svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function emptyState(msg) {
    return `<div class="empty">${esc(msg)}</div>`;
  }

  const ICON = {
    bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.7 4.4A9 9 0 0 0 20.5 15"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.5-9.5-9A5 5 0 0 1 12 6a5 5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/></svg>',
    userPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    twitch: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 2 3 6v13h4v3h3l3-3h4l5-5V2zm16 11-3 3h-5l-3 3v-3H6V4h14zM15 7h2v5h-2zm-6 0h2v5H9z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  };

  function toast(msg, kind) {
    const root = $("#toast-root");
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => {
      t.style.transition = "opacity .3s";
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 300);
    }, 3200);
  }

  /* ----------------------------- Twitch API ---------------------------- */
  async function api(path, opts) {
    opts = opts || {};
    const url = new URL(API + path);
    if (opts.params) for (const k in opts.params) if (opts.params[k] != null) url.searchParams.set(k, opts.params[k]);
    const headers = { Authorization: "Bearer " + S.token, "Client-Id": S.clientId };
    const res = await fetch(url.toString(), { method: opts.method || "GET", headers, body: opts.body });
    if (res.status === 401) {
      S.token = null;
      S.exp = 0;
      save(STORE.token, null);
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j.message || "";
      } catch (e) {}
      throw new Error("Twitch API " + res.status + (detail ? ": " + detail : ""));
    }
    return res.json();
  }
  async function apiAll(path, p, cap) {
    const out = [];
    let cursor = null;
    let pages = 0;
    cap = cap || 300;
    do {
      const q = Object.assign({}, p, { first: 100 });
      if (cursor) q.after = cursor;
      const data = await api(path, { params: q });
      out.push.apply(out, data.data || []);
      cursor = data.pagination && data.pagination.cursor;
      pages++;
    } while (cursor && out.length < cap && pages < 30);
    return out;
  }
  async function getMe() {
    const d = await api("/users");
    return d.data && d.data[0];
  }
  async function getMyStream() {
    if (!S.user) return null;
    const d = await api("/streams", { params: { user_id: S.user.id, first: 1 } });
    return d.data && d.data[0];
  }
  async function getFollowedStreams() {
    if (!S.user) return [];
    return apiAll("/streams/followed", { user_id: S.user.id }, 300);
  }
  async function getFollowedIds() {
    if (!S.user) return new Set();
    const list = await apiAll("/channels/followed", { user_id: S.user.id }, 2500);
    return new Set(list.map((f) => f.broadcaster_id));
  }
  async function resolveGame(name) {
    const d = await api("/search/categories", { params: { query: name, first: 10 } });
    const exact = d.data.find((g) => g.name.toLowerCase() === name.toLowerCase());
    return exact || d.data[0] || null;
  }
  async function getStreamsByGame(gameId, first) {
    const d = await api("/streams", { params: { game_id: gameId, first: first || 30 } });
    return d.data || [];
  }
  async function getGame(id) {
    const d = await api("/games", { params: { id } });
    return (d.data && d.data[0]) || null;
  }
  async function fetchUsers(ids) {
    if (!ids.length) return [];
    const url = new URL(API + "/users");
    ids.forEach((id) => url.searchParams.append("id", id));
    const res = await fetch(url.toString(), { headers: { Authorization: "Bearer " + S.token, "Client-Id": S.clientId } });
    if (!res.ok) throw new Error("users " + res.status);
    return (await res.json()).data || [];
  }
  // Attach profile_image_url onto streams so cards can show avatars.
  async function attachProfiles(streams) {
    if (!streams || !streams.length || S.demo) return;
    const ids = Array.from(new Set(streams.map((s) => s.user_id).filter(Boolean)));
    if (!ids.length) return;
    const all = [];
    for (let i = 0; i < ids.length; i += 100) {
      try {
        all.push.apply(all, await fetchUsers(ids.slice(i, i + 100)));
      } catch (e) {}
    }
    const map = {};
    all.forEach((u) => (map[u.id] = u.profile_image_url));
    streams.forEach((s) => {
      if (map[s.user_id]) s.profile_image_url = map[s.user_id];
    });
  }
  async function attachAllProfiles() {
    const all = []
      .concat(S.followedStreams || [])
      .concat(S.sameGameStreams || [])
      .concat(S.discoverStreams || [])
      .concat(S.filterStreams || [])
      .concat(...Object.values(S.viewCache || {}));
    await attachProfiles(all);
  }
  async function startRaid(toId) {
    return api("/raids", { method: "POST", params: { from_broadcaster_id: S.user.id, to_broadcaster_id: toId } });
  }
  async function followUser(toId) {
    const res = await fetch(API + "/users/follows", {
      method: "POST",
      headers: { Authorization: "Bearer " + S.token, "Client-Id": S.clientId, "Content-Type": "application/json" },
      body: JSON.stringify({ from_id: S.user.id, to_id: toId }),
    });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) {
      let m = "";
      try {
        m = (await res.json()).message;
      } catch (e) {}
      throw new Error("Follow failed (" + res.status + ")" + (m ? ": " + m : ""));
    }
    return true;
  }

  /* ------------------------------ Auth ---------------------------------- */
  function buildAuthUrl() {
    const scopes = BASE_SCOPES.slice();
    if (settings.raidsEnabled) scopes.push(RAID_SCOPE);
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    save("rd_oauth_state", state);
    const u = new URL(AUTH);
    u.searchParams.set("response_type", "token");
    u.searchParams.set("client_id", S.clientId);
    u.searchParams.set("redirect_uri", redirectUri());
    u.searchParams.set("scope", scopes.join(" "));
    u.searchParams.set("state", state);
    return u.toString();
  }
  function handleRedirect() {
    if (!location.hash.includes("access_token")) return false;
    const frag = new URLSearchParams(location.hash.slice(1));
    const token = frag.get("access_token");
    const state = frag.get("state");
    const savedState = load("rd_oauth_state", "");
    history.replaceState(null, "", location.pathname + location.search);
    if (!token) return false;
    if (savedState && state && savedState !== state) {
      toast("OAuth state mismatch — please reconnect.", "err");
      return false;
    }
    S.token = token;
    S.exp = jwtExp(token) || Math.floor(Date.now() / 1000) + 14400;
    save(STORE.token, token);
    save(STORE.exp, S.exp);
    return true;
  }
  function login() {
    if (!S.clientId) {
      toast("Owner: set EMBEDDED_CLIENT_ID in app.js (or config.js) to enable login.", "warn");
      return;
    }
    location.href = buildAuthUrl();
  }
  function logout() {
    S.token = null;
    S.exp = 0;
    S.user = null;
    save(STORE.token, null);
    renderLogin();
  }

  /* --------------------------- Data pipeline --------------------------- */
  async function refreshAll(force) {
    if (S.demo) {
      renderDemo();
      return;
    }
    if (!isTokenValid()) {
      renderLogin();
      return;
    }
    if (S.loading) return;
    S.loading = true;
    setRefreshSpin(true);
    try {
      S.cycle++;
      const me = await getMe();
      S.user = me;
      const [myStream, followed] = await Promise.all([getMyStream(), getFollowedStreams()]);
      S.meViewers = (myStream && myStream.viewer_count) || 0;
      S.myGameId = (myStream && myStream.game_id) || null;
      S.myGameName = (myStream && myStream.game_name) || null;
      S.followedStreams = followed;

      if (!S.followedIds || S.cycle % 5 === 1) S.followedIds = await getFollowedIds();

      // Everyone live in your current category (for Same Game).
      S.sameGameStreams = S.myGameId ? await getStreamsByGame(S.myGameId, 100).catch(() => []) : null;

      // Keep a filtered Discover view fresh if one is active.
      if (S.filterGame) S.filterStreams = await getStreamsByGame(S.filterGame.id, 100).catch(() => []);

      buildDerivedCategories();
      if (force || S.cycle % settings.refreshSuggestionsEvery === 0 || !S.discoverStreams.length) await buildDiscover();
      try { await attachAllProfiles(); } catch (e) {}

      renderHeader();
      renderTabs();
    } catch (e) {
      if (e.message === "unauthorized") {
        if (settings.autoReconnect && !S.reauth) {
          S.reauth = true;
          toast("Session expired — reconnecting…", "warn");
          login();
        } else {
          renderExpired();
          toast("Session expired — please reconnect.", "warn");
        }
      } else {
        toast(e.message || "Something went wrong", "err");
      }
    } finally {
      S.loading = false;
      setRefreshSpin(false);
    }
  }

  function buildDerivedCategories() {
    const map = new Map();
    for (const s of S.followedStreams) {
      if (!s.game_id) continue;
      if (!map.has(s.game_id)) map.set(s.game_id, { id: s.game_id, name: s.game_name, streams: [] });
      map.get(s.game_id).streams.push(s);
    }
    S.derivedCategories = Array.from(map.values()).sort((a, b) => b.streams.length - a.streams.length);
  }

  async function buildDiscover() {
    if (S.demo) {
      S.discoverStreams = S._demoDiscover || [];
      return;
    }
    if (!S.followedIds) S.followedIds = await getFollowedIds();
    const myV = S.meViewers;
    const gameSet = new Set();
    if (S.myGameId) gameSet.add(S.myGameId);
    for (const c of settings.categories) gameSet.add(c.id);
    for (const c of S.derivedCategories) gameSet.add(c.id);
    const games = Array.from(gameSet).slice(0, 12);
    const results = await Promise.all(games.map((gid) => getStreamsByGame(gid, S.discoverFirst).catch(() => [])));
    const seen = new Set();
    const out = [];
    for (const streams of results) {
      for (const s of streams) {
        if (seen.has(s.user_id)) continue;
        if (S.user && s.user_id === S.user.id) continue;
        if (S.followedIds.has(s.user_id)) continue;
        const v = s.viewer_count || 0;
        if (v > settings.maxViewers) continue;
        if (v < settings.minViewers) continue;
        if (myV > 0) {
          const ratio = v / myV;
          if (ratio < settings.sizeLower || ratio > settings.sizeUpper) continue;
        }
        seen.add(s.user_id);
        out.push(s);
      }
    }
    out.sort((a, b) => (a.viewer_count || 0) - (b.viewer_count || 0));
    S.discoverStreams = out.slice(0, 80);
  }

  /* --------------------------- Render helpers -------------------------- */
  function sortStreams(list) {
    const arr = (list || []).slice();
    switch (S.sort) {
      case "viewers-asc":
        arr.sort((a, b) => (a.viewer_count || 0) - (b.viewer_count || 0));
        break;
      case "recent":
        arr.sort((a, b) => (S.sortDir === "asc" ? new Date(a.started_at) - new Date(b.started_at) : new Date(b.started_at) - new Date(a.started_at)));
        break;
      case "category":
        arr.sort((a, b) => (S.sortDir === "asc" ? (a.game_name || "").localeCompare(b.game_name || "") : (b.game_name || "").localeCompare(a.game_name || "")));
        break;
      default:
        arr.sort((a, b) => (b.viewer_count || 0) - (a.viewer_count || 0));
    }
    return arr;
  }
  function langSet(list) {
    const set = new Set();
    for (const s of list || []) if (s.language) set.add(s.language);
    return Array.from(set).sort();
  }
  function applyLang(list) {
    const allow = new Set(settings.langAllow || []);
    if (allow.size === 0) return list || [];
    return (list || []).filter((s) => !s.language || allow.has(s.language));
  }
  function sortControl() {
    const opts = [
      ["viewers-desc", "Viewers (high → low)"],
      ["viewers-asc", "Viewers (low → high)"],
      ["recent", "Recently started"],
      ["category", "Category"],
    ];
    let dirBtn = "";
    if (S.sort === "recent" || S.sort === "category") {
      const label =
        S.sort === "recent"
          ? S.sortDir === "asc" ? "Oldest first ↑" : "Newest first ↓"
          : S.sortDir === "asc" ? "A–Z ↑" : "Z–A ↓";
      dirBtn = ` <button class="sortdir" data-action="sort-dir" title="Toggle sort direction">${label}</button>`;
    }
    return `<div class="sortrow"><label>Sort</label><select class="sortsel">${opts
      .map(([v, l]) => `<option value="${v}" ${S.sort === v ? "selected" : ""}>${l}</option>`)
      .join("")}</select>${dirBtn}</div>`;
  }
  function langFilterChips(langs) {
    const allow = new Set(settings.langAllow || []);
    const allOn = allow.size === 0;
    const count = allOn ? "All" : allow.size + " selected";
    return `<details class="langdrop"><summary>Languages <span class="langcount">${count}</span></summary>
      <div class="langpop">
        <button class="langallbtn" data-action="lang-all">All languages</button>
        ${langs
          .map((l) => `<label class="langopt"><input type="checkbox" class="langchk" data-lang="${esc(l)}" ${allOn || allow.has(l) ? "checked" : ""}/> ${esc(l)}</label>`)
          .join("")}
      </div></details>`;
  }
  function sectionHead(title, sub) {
    return `<div class="sechead"><h2>${title}</h2>${sub ? `<div class="sechead-sub">${sub}</div>` : ""}</div>`;
  }

  function streamCard(s, opts) {
    opts = opts || {};
    let thumb;
    if (settings.cardThumb === "avatar" && s.profile_image_url) {
      thumb = s.profile_image_url;
    } else if (s.thumbnail_url) {
      thumb = thumbUrl(s.thumbnail_url, 320, 180);
    } else {
      thumb = placeholder(s.user_login || s.user_name, 320, 180, (s.user_name || "?").slice(0, 2));
    }
    const isFollowed = S.followedIds && S.followedIds.has(s.user_id);
    const tags = (s.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const raidBtn = settings.raidsEnabled
      ? `<button class="btn raid" data-action="raid" data-uid="${esc(s.user_id)}" data-login="${esc(s.user_login)}">${ICON.bolt} Raid</button>`
      : "";
    const followBtn = isFollowed
      ? `<button class="btn follow followed" disabled>${ICON.heart} Following</button>`
      : `<button class="btn follow" data-action="follow" data-uid="${esc(s.user_id)}" data-login="${esc(s.user_login)}">${ICON.userPlus} Follow</button>`;
    const cat = opts.catLink
      ? `<span class="cat catlink" data-action="filter-cat" data-id="${esc(s.game_id)}" data-name="${esc(s.game_name || "")}">${esc(s.game_name || "—")}</span>`
      : `<span class="cat">${esc(s.game_name || "—")}</span>`;
    return `
      <div class="card">
        <div class="thumb"><img src="${thumb}" alt="" loading="lazy"/><span class="live">LIVE</span><span class="viewers">${fmt(s.viewer_count)}</span></div>
        <div class="body">
          <div class="title">${esc(s.title)}</div>
          <div class="name">${esc(s.user_name)} ${s.is_verified ? `<span class="verified" title="Verified">✓</span>` : ""}</div>
          <div class="meta">${cat}<span>· ${fmtUptime(s.started_at)}</span>${s.language ? `<span>· ${esc(s.language)}</span>` : ""}</div>
          ${tags ? `<div class="tags">${tags}</div>` : ""}
          <div class="actions">${raidBtn}<button class="btn open" data-action="open" data-login="${esc(s.user_login)}">${ICON.ext} Open</button>${followBtn}</div>
        </div>
      </div>`;
  }

  function renderHeader() {
    const bar = $("#topbar");
    const expIn = S.exp ? Math.max(0, Math.floor((S.exp * 1000 - Date.now()) / 60000)) : 0;
    const meHtml = S.user
      ? `<div class="me"><img src="${S.user.profile_image_url || placeholder(S.user.login, 40, 40)}" alt=""/><span>${esc(S.user.display_name)}</span>${S.meViewers > 0 ? `<span class="livepill">${fmt(S.meViewers)} viewers</span>` : ""}<span class="hint" title="Token expires in ~${expIn} min">⏳ ${expIn}m</span></div>`
      : "";
    bar.innerHTML = `
      <div class="brand"><span class="logo">${ICON.twitch}</span><span class="txt">Clawraid</span>${S.demo ? `<span class="demo-badge">DEMO</span>` : ""}</div>
      <div class="spacer"></div>${meHtml}
      <button class="iconbtn" data-action="refresh" title="Refresh now">${ICON.refresh}</button>
      <button class="iconbtn" data-action="settings" title="Settings">${ICON.gear}</button>`;
    if (settings.compact) $("#app").classList.add("compact");
    else $("#app").classList.remove("compact");
  }

  function renderTabs() {
    const c = $("#content");
    const sameCount = S.sameGameStreams ? S.sameGameStreams.length : 0;
    const folCount = S.followedStreams.length;
    const discCount = S.filterGame ? (S.filterStreams ? S.filterStreams.length : 0) : (S.discoverStreams || []).length;

    if (!S.activeTab) S.activeTab = S.myGameId && sameCount > 0 ? "same" : "discover";

    c.innerHTML = `
      <div class="tabs">
        <button class="tab ${S.activeTab === "same" ? "active" : ""}" data-action="tab" data-tab="same">Same Game <span class="count">${sameCount}</span></button>
        <button class="tab ${S.activeTab === "following" ? "active" : ""}" data-action="tab" data-tab="following">Following <span class="count">${folCount}</span></button>
        <button class="tab ${S.activeTab === "discover" ? "active" : ""}" data-action="tab" data-tab="discover">${S.filterGame ? "Discover: " + esc(S.filterGame.name) : "Discover"} <span class="count">${discCount}</span></button>
      </div>
      <div class="searchrow"><span class="searchico">${ICON.search}</span><input type="text" id="search" placeholder="Search channels…" value="${esc(S.searchTerm || "")}" /></div>
      <div id="tab-content"></div>`;
    selectTab(S.activeTab);
  }

  function selectTab(tab) {
    S.activeTab = tab;
    $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    const tc = document.getElementById("tab-content");
    if (!tc) return;
    const q = (S.searchTerm || "").toLowerCase();
    const match = (s) => !q || (s.user_name || "").toLowerCase().includes(q) || (s.title || "").toLowerCase().includes(q);

    if (tab === "same") renderSame(tc, match);
    else if (tab === "following") renderFollowing(tc, match);
    else if (tab === "discover") renderDiscover(tc, match);
  }

  function renderSame(tc, match) {
    if (!S.myGameId || !S.sameGameStreams) {
      tc.innerHTML = emptyState("You're not live — go live to populate Same Game with everyone in your category.");
      return;
    }
    const all = S.sameGameStreams;
    const followed = sortStreams(all.filter((s) => S.followedIds && S.followedIds.has(s.user_id))).filter(match);
    const others = sortStreams(all.filter((s) => !(S.followedIds && S.followedIds.has(s.user_id)))).filter(match);
    let html = sectionHead("Same Game", `Everyone live in <b>${esc(S.myGameName)}</b> — people you follow are listed first.`) + sortControl();
    if (followed.length) html += `<h3 class="subhead">People you follow (${followed.length})</h3>` + followed.map(streamCard).join("");
    if (others.length) html += `<h3 class="subhead">Others in ${esc(S.myGameName)} (${others.length})</h3>` + others.map(streamCard).join("");
    if (!followed.length && !others.length) html += emptyState("No one is live in " + esc(S.myGameName) + " right now.");
    tc.innerHTML = html;
  }

  function renderFollowing(tc, match) {
    const list = sortStreams(S.followedStreams).filter(match);
    tc.innerHTML =
      sectionHead("Following", "Everyone you follow who is live. Click a <b>category name</b> to jump to Discover filtered to it.") +
      sortControl() +
      (list.length ? list.map((s) => streamCard(s, { catLink: true })).join("") : emptyState("None of the channels you follow are live right now."));
  }

  // Lazy-load box art for tracked categories that were saved before art was
  // stored (e.g. older localStorage entries). Silently fills in thumbnails.
  function ensureCategoryArt() {
    settings.categories.forEach((c) => {
      if (!c.box_art_url && !c._artPending) {
        c._artPending = true;
        getGame(c.id)
          .then((g) => {
            if (g && g.box_art_url) {
              c.box_art_url = g.box_art_url;
              saveSettings();
              if (S.activeTab === "discover") renderTabs();
            }
          })
          .catch(() => {});
      }
    });
  }

  function renderDiscover(tc, match) {
    ensureCategoryArt();
    // Filtered view: everyone live in a specific category.
    if (S.filterGame) {
      const streams = applyLang(sortStreams(S.filterStreams || []).filter(match));
      const langs = langSet(S.filterStreams || []);
      const fthumb = S.filterGame.box_art_url ? `<img class="catthumb" src="${thumbUrl(S.filterGame.box_art_url, 40, 56)}" alt=""/>` : "";
      tc.innerHTML =
        `<div class="sechead"><div style="display:flex;align-items:center;gap:8px"><h2>Discover</h2>${fthumb}<span>${esc(S.filterGame.name)}</span></div></div>` +
        `<button class="btn" data-action="clear-filter" style="margin:0 0 8px">✕ Clear filter</button>` +
        sortControl() +
        langFilterChips(langs) +
        (streams.length ? streams.map(streamCard).join("") : emptyState("No one is live in " + esc(S.filterGame.name) + " right now."));
      return;
    }

    const list = applyLang(sortStreams(S.discoverStreams || []).filter(match));
    const langs = langSet(S.discoverStreams || []);
    const hint = S.myGameId
      ? `Live channels in <b>${esc(S.myGameName)}</b> + your tracked categories that you don't follow yet.`
      : `Live channels in your tracked/derived categories you don't follow yet.` + (S.meViewers > 0 ? ` Sized near your ${fmt(S.meViewers)} viewers.` : "");

    const catManage = settings.categories
      .map((cat) => {
        const open = S.viewOpen.has(cat.id);
        const streams = open ? sortStreams(S.viewCache[cat.id] || []) : null;
        const thumb = cat.box_art_url ? `<img class="catthumb" src="${thumbUrl(cat.box_art_url, 40, 56)}" alt=""/>` : "";
        return `
        <div class="catmanage">
          <div class="chip">
            ${thumb}
            <div><div class="cname">${esc(cat.name)}</div><div class="cmeta">${streams ? streams.length + " live" : "tracked"}</div></div>
            <button class="btn cbtn" data-action="view-cat" data-id="${esc(cat.id)}" data-name="${esc(cat.name)}">${open ? "Hide" : "View"}</button>
            <button class="btn cbtn" data-action="remove-cat" data-name="${esc(cat.name)}" title="Remove">${ICON.close}</button>
          </div>
          ${
            open
              ? `<div class="discovery">${
                  S._viewLoading === cat.id
                    ? `<div class="loading">Loading live channels…</div>`
                    : streams.length
                    ? streams.map(streamCard).join("")
                    : emptyState("No live streams in " + esc(cat.name) + " right now.")
                }</div>`
              : ""
          }
        </div>`;
      })
      .join("");

    tc.innerHTML =
      sectionHead("Discover", hint) +
      langFilterChips(langs) +
      `<div class="cat-add"><input type="text" id="cat-input" placeholder="Type to search a category (e.g. Just Chatting)…" autocomplete="off" /><button class="btn raid" data-action="add-cat">+ Track</button></div>
      <div id="cat-suggest" class="suggest"></div>
      ${settings.categories.length ? `<div class="cats">${catManage}</div>` : `<div class="hint" style="font-size:11px;color:var(--text-faint);margin:4px 0 8px">No categories tracked yet — search above and pick a match, or type a name and hit + Track.</div>`}
      <h3 class="subhead">Not-yet-followed (Discover)</h3>
      ${sortControl()}
      ${list.length ? list.map(streamCard).join("") : emptyState("No discoveries right now. Track more categories or widen the size filter in Settings.")}
      ${S.discoverFirst < 100 && (S.discoverStreams || []).length ? `<button class="btn" data-action="discover-more" style="margin-top:8px">Load More</button>` : ""}`;
  }

  function renderExpired() {
    const c = $("#content");
    c.innerHTML = `
      <div class="setup">
        <h1>${ICON.twitch} Clawraid</h1>
        <p>Your Twitch session expired. Reconnect to keep raiding.</p>
        <button class="connect" data-action="connect">Reconnect with Twitch</button>
      </div>`;
    $("#topbar").innerHTML = `<div class="brand"><span class="logo">${ICON.twitch}</span><span class="txt">Clawraid</span></div>`;
  }

  function renderLogin() {
    const c = $("#content");
    const hasId = !!S.clientId && !S.demo;
    c.innerHTML = `
      <div class="setup">
        <h1>${ICON.twitch} Clawraid ${S.demo ? `<span class="demo-badge">DEMO</span>` : ""}</h1>
        <p>A client-side OBS dock that helps you find who to raid and grow your community — live channels you follow, sorted into Same Game / Following / Discover.</p>
        ${
          S.demo
            ? `<div class="banner">Demo mode uses fake data so you can preview the layout. Connect a real Twitch account to use it for real.</div>`
            : ""
        }
        ${
          hasId
            ? `<p class="hint" style="font-size:12px;color:var(--text-dim)">Log in with your Twitch account to load your live follows, categories, and raid targets.</p>`
            : `<div class="hint" style="font-size:12px;color:var(--text-faint)">This app isn't configured yet. The owner must set <code>EMBEDDED_CLIENT_ID</code> in <code>app.js</code> (or <code>config.js</code>) to enable login.</div>`
        }
        <button class="connect" data-action="connect">${hasId ? "Log in with Twitch" : "Not configured"}</button>
        <button class="demo" data-action="demo">View demo with sample data</button>
      </div>`;
    $("#topbar").innerHTML = `<div class="brand"><span class="logo">${ICON.twitch}</span><span class="txt">Clawraid</span></div>`;
  }

  /* --------------------------- Demo (no network) ----------------------- */
  function renderDemo() {
    const games = ["Just Chatting", "Science & Technology", "Art", "Software and Game Development", "Retro"];
    const names = ["PixelPioneer", "CodeWithMia", "SynthWaveSam", "RetroRanger", "ArtfulAda", "StreamSage", "NightOwlNate", "QuestQueen", "BitBard", "LoopLucas", "MapleMorgan", "EchoEllis"];
    const mk = (i, game) => ({
      user_id: "d" + i,
      user_login: names[i] ? names[i].toLowerCase() : "streamer" + i,
      user_name: names[i] || "Streamer" + i,
      game_id: "g" + i,
      game_name: game,
      viewer_count: Math.floor(20 + Math.random() * 900),
      title: "Building cool things & chatting with you all! " + (i % 3 === 0 ? "🎉" : ""),
      thumbnail_url: "",
      started_at: new Date(Date.now() - (i + 1) * 9 * 60000).toISOString(),
      language: ["en", "en", "es", "de", "en", "fr"][i % 6],
      tags: ["English", i % 2 ? "Creative" : "Chill"],
    });
    S.user = { id: "me", login: "YourChannel", display_name: "YourChannel", profile_image_url: "" };
    S.meViewers = 120;
    S.myGameId = "g0";
    S.myGameName = "Just Chatting";
    S.followedIds = new Set(["d0", "d1", "d2"]);
    S.followedStreams = [mk(0, "Just Chatting"), mk(1, "Science & Technology"), mk(2, "Art")];
    S.derivedCategories = [
      { id: "g0", name: "Just Chatting", streams: [S.followedStreams[0]] },
      { id: "g1", name: "Science & Technology", streams: [S.followedStreams[1]] },
      { id: "g2", name: "Art", streams: [S.followedStreams[2]] },
    ];
    // Same Game = everyone in Just Chatting (you follow d0; d20/d21 are others).
    S.sameGameStreams = [
      S.followedStreams[0],
      Object.assign(mk(20, "Just Chatting"), { user_id: "o1", user_login: "otherone", user_name: "OtherOne" }),
      Object.assign(mk(21, "Just Chatting"), { user_id: "o2", user_login: "anotherstream", user_name: "AnotherStream" }),
    ];
    S._demoDiscover = [3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => mk(i, games[i % games.length]));
    S._demoDiscover = S._demoDiscover.filter((s) => !S.followedIds.has(s.user_id));
    S.discoverStreams = S._demoDiscover;
    S.searchTerm = "";
    S.activeTab = "same";
    S._viewLoading = null;
    renderHeader();
    renderTabs();
  }

  /* ------------------------------ Modals ------------------------------- */
  function openModal(html) {
    $("#modal-root").innerHTML = `<div class="modal-backdrop" data-action="modal-backdrop"><div class="modal">${html}</div></div>`;
  }
  function closeModal() {
    $("#modal-root").innerHTML = "";
  }

  function openSettings(forceClientId) {
    const r = redirectUri();
    const catRows = settings.categories
      .map((c) => `<span class="tag">${esc(c.name)} <a data-action="remove-cat" data-name="${esc(c.name)}" style="cursor:pointer;color:var(--red)">✕</a></span>`)
      .join(" ");
    openModal(`
      <header>Settings <button class="x" data-action="close-modal">×</button></header>
      <div class="body">
        <h3>Twitch connection</h3>
        <div class="hint" style="font-size:11px;color:var(--text-faint);margin-bottom:8px">Client ID &amp; Redirect URL are configured in the app code (set <code>EMBEDDED_CLIENT_ID</code> in app.js or config.js), so they're hidden here and can't be overwritten.</div>
        <div class="setting-row"><div><label>Enable raid starting</label><div class="hint">Needs the channel:manage:raids scope. If off, only quick links are shown.</div></div><label class="switch"><input type="checkbox" id="set-raids" ${settings.raidsEnabled ? "checked" : ""}/><span class="slider"></span></label></div>
        <h3>Card thumbnail</h3>
        <div class="setting-row">
          <div><label>Show on each card</label><div class="hint">Live stream preview, or the channel's profile picture.</div></div>
          <select id="set-thumb">${["live", "avatar"].map((v) => `<option value="${v}" ${settings.cardThumb === v ? "selected" : ""}>${v === "live" ? "Live preview" : "Profile picture"}</option>`).join("")}</select>
        </div>
        <h3>Behavior</h3>
        <div class="setting-row">
          <div><label>Auto-reconnect on expiry</label><div class="hint">Silently re-authenticate when the Twitch token expires, so the dock stays live.</div></div>
          <label class="switch"><input type="checkbox" id="set-reauth" ${settings.autoReconnect ? "checked" : ""}/><span class="slider"></span></label>
        </div>
        <h3>Refresh</h3>
        <div class="setting-row"><label>Refresh live data every (seconds)</label><input type="number" id="set-refresh" min="20" max="600" value="${settings.refreshSeconds}"/></div>
        <div class="setting-row"><label>Rebuild Discover every N refreshes</label><input type="number" id="set-sugg" min="1" max="20" value="${settings.refreshSuggestionsEvery}"/></div>
        <h3>Discover filters</h3>
        <div class="setting-row"><label>Min viewers</label><input type="number" id="set-minv" min="0" value="${settings.minViewers}"/></div>
        <div class="setting-row"><label>Max viewers (ceiling)</label><input type="number" id="set-maxv" min="0" value="${settings.maxViewers}"/></div>
        <div class="hint" style="font-size:11px;color:var(--text-faint);margin-bottom:6px">When you're live, Discover is limited to channels with viewers between <b>sizeLower × your viewers</b> and <b>sizeUpper × your viewers</b>.</div>
        <div class="setting-row"><label>Size lower (×)</label><input type="number" id="set-lower" min="0" step="0.05" value="${settings.sizeLower}"/></div>
        <div class="setting-row"><label>Size upper (×)</label><input type="number" id="set-upper" min="0" step="0.5" value="${settings.sizeUpper}"/></div>
        <h3>Appearance</h3>
        <div class="setting-row"><div><label>Compact mode</label><div class="hint">Better for very narrow docks</div></div><label class="switch"><input type="checkbox" id="set-compact" ${settings.compact ? "checked" : ""}/><span class="slider"></span></label></div>
        <h3>Tracked categories</h3>
        <div>${catRows || '<span class="hint" style="font-size:11px;color:var(--text-faint)">None yet — add them in the Discover tab.</span>'}</div>
      </div>
      <div class="foot"><button class="btn" data-action="logout">Disconnect</button><button class="btn raid" data-action="save-settings">Save</button></div>
    `);
    if (forceClientId) {
      const inp = $("#set-client");
      if (inp) inp.focus();
    }
  }

  async function saveSettingsFromModal() {
    const cidInp = $("#set-client");
    const cid = cidInp ? cidInp.value.trim() : "";
    const redInp = $("#set-redirect");
    const red = redInp ? redInp.value.trim() : "";
    settings.raidsEnabled = $("#set-raids") ? $("#set-raids").checked : settings.raidsEnabled;
    settings.cardThumb = ($("#set-thumb") || {}).value || "live";
    settings.autoReconnect = $("#set-reauth") ? $("#set-reauth").checked : true;
    settings.refreshSeconds = clampInt($("#set-refresh").value, 20, 600, 60);
    settings.refreshSuggestionsEvery = clampInt($("#set-sugg").value, 1, 20, 2);
    settings.minViewers = Math.max(0, parseInt($("#set-minv").value, 10) || 0);
    settings.maxViewers = Math.max(0, parseInt($("#set-maxv").value, 10) || 5000);
    settings.sizeLower = Math.max(0, parseFloat($("#set-lower").value) || 0.25);
    settings.sizeUpper = Math.max(0.01, parseFloat($("#set-upper").value) || 4);
    settings.compact = $("#set-compact").checked;
    saveSettings();

    let needReconnect = false;
    if (cid && cid !== S.clientId) {
      S.clientId = cid;
      save(STORE.clientId, cid);
      needReconnect = true;
    }
    if (red && red !== redirectUri()) {
      save(STORE.redirect, red);
      needReconnect = true;
    }
    closeModal();
    renderHeader();
    if (needReconnect) {
      toast("Saved. Reconnect to apply the new Client ID / redirect.", "ok");
      if (isTokenValid()) logout();
    } else if (isTokenValid()) {
      startTimer();
      refreshAll(true);
    } else {
      renderLogin();
    }
  }

  function clampInt(v, min, max, def) {
    let n = parseInt(v, 10);
    if (isNaN(n)) n = def;
    return Math.min(max, Math.max(min, n));
  }

  function confirmRaid(login, uid) {
    openModal(`
      <header>Start a raid? <button class="x" data-action="close-modal">×</button></header>
      <div class="body"><p style="color:var(--text-dim);font-size:13px;line-height:1.5">This sends your <b>${fmt(S.meViewers)}</b> viewers to <b>${esc(login)}</b>. Twitch starts a 90-second countdown; you (or the timer) confirm the raid on Twitch's side.</p><p class="hint" style="font-size:11px;color:var(--text-faint)">Rate limit: 10 raids per 10 minutes.</p></div>
      <div class="foot"><button class="btn" data-action="close-modal">Cancel</button><button class="btn raid" id="confirm-raid-btn" data-uid="${esc(uid)}" data-login="${esc(login)}">${ICON.bolt} Raid ${esc(login)}</button></div>
    `);
    $("#confirm-raid-btn").addEventListener("click", async () => {
      closeModal();
      try {
        await startRaid(uid);
        toast("Raid started to " + login + " — confirm on Twitch!", "ok");
      } catch (e) {
        toast(e.message || "Raid failed", "err");
      }
    });
  }

  /* ------------------------------ Actions ------------------------------ */
  async function onAction(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;

    switch (action) {
      case "connect": {
        const inp = $("#setup-client");
        const v = inp ? inp.value.trim() : "";
        if (v) {
          S.clientId = v;
          save(STORE.clientId, v);
        }
        login();
        break;
      }
      case "demo":
        location.href = location.pathname + "?demo=1";
        break;
      case "refresh":
        refreshAll(true);
        break;
      case "settings":
        openSettings(false);
        break;
      case "close-modal":
      case "modal-backdrop":
        if (action === "modal-backdrop" && e.target !== btn) return;
        closeModal();
        break;
      case "save-settings":
        saveSettingsFromModal();
        break;
      case "logout":
        logout();
        break;
      case "tab":
        selectTab(btn.dataset.tab);
        break;
      case "sort-dir":
        S.sortDir = S.sortDir === "asc" ? "desc" : "asc";
        selectTab(S.activeTab || "discover");
        break;
      case "open":
        window.open("https://www.twitch.tv/" + btn.dataset.login, "_blank");
        break;
      case "raid":
        if (!settings.raidsEnabled) {
          window.open("https://www.twitch.tv/" + btn.dataset.login, "_blank");
          break;
        }
        confirmRaid(btn.dataset.login, btn.dataset.uid);
        break;
      case "follow": {
        btn.disabled = true;
        if (S.demo) {
          toast("Now following " + btn.dataset.login + " (demo)", "ok");
          if (S.followedIds) S.followedIds.add(btn.dataset.uid);
          btn.outerHTML = `<button class="btn follow followed" disabled>${ICON.heart} Following</button>`;
          break;
        }
        try {
          await followUser(btn.dataset.uid);
          toast("Now following " + btn.dataset.login, "ok");
          if (S.followedIds) S.followedIds.add(btn.dataset.uid);
          btn.outerHTML = `<button class="btn follow followed" disabled>${ICON.heart} Following</button>`;
        } catch (err) {
          btn.disabled = false;
          toast(err.message || "Follow failed", "err");
        }
        break;
      }
      case "add-cat": {
        const inp = $("#cat-input");
        const name = (inp && inp.value.trim()) || "";
        if (!name) break;
        await addCategory(name);
        if (inp) inp.value = "";
        const box = document.getElementById("cat-suggest");
        if (box) box.innerHTML = "";
        break;
      }
      case "pick-cat": {
        const gid = btn.dataset.id;
        const name = btn.dataset.name;
        const boxart = btn.dataset.box || "";
        const inp = document.getElementById("cat-input");
        if (inp) inp.value = "";
        const box = document.getElementById("cat-suggest");
        if (box) box.innerHTML = "";
        await trackGame(S.demo ? { id: "demo-" + name, name } : { id: gid, name, box_art_url: boxart });
        break;
      }
      case "view-cat": {
        const gid = btn.dataset.id;
        const name = btn.dataset.name;
        if (S.viewOpen.has(gid)) {
          S.viewOpen.delete(gid);
        } else {
          S.viewOpen.add(gid);
          if (!S.viewCache[gid]) {
            S._viewLoading = gid;
            renderTabs();
            try {
              S.viewCache[gid] = await getStreamsByGame(gid, 60);
              await attachProfiles(S.viewCache[gid]);
            } catch (err) {
              S.viewCache[gid] = [];
              toast(err.message || "Couldn't load category", "err");
            }
          }
        }
        S._viewLoading = null;
        renderTabs();
        break;
      }
      case "filter-cat": {
        const gid = btn.dataset.id;
        const name = btn.dataset.name;
        S.filterGame = { id: gid, name };
        S.filterStreams = null;
        if (!S.demo) {
          try {
            S.filterStreams = await getStreamsByGame(gid, 100);
            await attachProfiles(S.filterStreams);
          } catch (err) {
            S.filterStreams = [];
            toast(err.message, "err");
          }
        } else {
          S.filterStreams = S.sameGameStreams && gid === S.myGameId ? S.sameGameStreams : [];
        }
        S.activeTab = "discover";
        renderTabs();
        break;
      }
      case "clear-filter":
        S.filterGame = null;
        S.filterStreams = null;
        selectTab("discover");
        break;
      case "lang-all":
        settings.langAllow = [];
        saveSettings();
        selectTab("discover");
        break;
      case "lang-toggle": {
        const l = btn.dataset.lang;
        const allow = new Set(settings.langAllow || []);
        if (allow.has(l)) allow.delete(l);
        else allow.add(l);
        settings.langAllow = Array.from(allow);
        saveSettings();
        selectTab("discover");
        break;
      }
      case "remove-cat": {
        const name = btn.dataset.name;
        settings.categories = settings.categories.filter((c) => c.name !== name);
        delete S.viewCache[name];
        saveSettings();
        if (S.activeTab === "discover") {
          await buildDiscover();
          renderTabs();
        } else if ($("#modal-root").innerHTML) {
          openSettings(false);
        }
        break;
      }
      case "discover-more": {
        S.discoverFirst = Math.min(100, S.discoverFirst + 30);
        settings.discoverFirst = S.discoverFirst;
        saveSettings();
        await buildDiscover();
        renderTabs();
        break;
      }
    }
  }

  async function trackGame(game) {
    if (!game) return;
    if (settings.categories.some((c) => c.id === game.id || c.name.toLowerCase() === game.name.toLowerCase())) {
      toast("Already tracking " + game.name, "warn");
      return;
    }
    settings.categories.push({ id: game.id, name: game.name, box_art_url: game.box_art_url || "" });
    saveSettings();
    toast("Tracking " + game.name + " — showing everyone live in it", "ok");
    await buildDiscover();
    S.viewOpen.add(game.id);
    if (!S.demo) {
      try {
        S.viewCache[game.id] = await getStreamsByGame(game.id, 60);
      } catch (e) {
        S.viewCache[game.id] = [];
      }
    } else {
      S.viewCache[game.id] = [];
    }
    renderTabs();
  }

  async function addCategory(name) {
    if (!S.clientId && !S.demo) {
      toast("Connect Twitch first.", "warn");
      return;
    }
    if (S.demo) {
      await trackGame({ id: "demo-" + name, name });
      return;
    }
    try {
      const g = await resolveGame(name);
      if (!g) {
        toast("Couldn't find a category named '" + name + "'", "err");
        return;
      }
      await trackGame(g);
    } catch (e) {
      toast(e.message, "err");
    }
  }

  let catTypeTimer = null;
  function onCatType(q) {
    if (S.demo) return;
    const box = document.getElementById("cat-suggest");
    if (!box) return;
    q = (q || "").trim();
    if (q.length < 2) {
      box.innerHTML = "";
      return;
    }
    clearTimeout(catTypeTimer);
    catTypeTimer = setTimeout(async () => {
      try {
        const data = await api("/search/categories", { params: { query: q, first: 8 } });
        const games = data.data || [];
        if (!games.length) {
          box.innerHTML = `<div class="suggest-item dim">No matches</div>`;
          return;
        }
        box.innerHTML = games
          .map(
            (g) =>
              `<div class="suggest-item" data-action="pick-cat" data-id="${esc(g.id)}" data-name="${esc(g.name)}" data-box="${esc(g.box_art_url || "")}">${
                g.box_art_url ? `<img src="${thumbUrl(g.box_art_url, 40, 56)}" alt=""/>` : ""
              }<span>${esc(g.name)}</span></div>`
          )
          .join("");
      } catch (e) {
        box.innerHTML = "";
      }
    }, 250);
  }

  /* ------------------------------ Timer --------------------------------- */
  function startTimer() {
    if (S.timer) clearInterval(S.timer);
    const ms = Math.max(20000, settings.refreshSeconds * 1000);
    S.timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshAll(false);
    }, ms);
  }
  function setRefreshSpin(on) {
    const b = $('[data-action="refresh"]');
    if (b) b.style.opacity = on ? ".5" : "1";
  }

  /* ------------------------------ Init --------------------------------- */
  function init() {
    S.clientId = defaultClientId();
    const hadRedirect = handleRedirect();
    S.token = load(STORE.token, null);
    S.exp = load(STORE.exp, 0);

    document.addEventListener("click", onAction);
    document.addEventListener("input", (e) => {
      if (!e.target) return;
      if (e.target.id === "search") {
        S.searchTerm = e.target.value;
        selectTab(S.activeTab || "discover");
      } else if (e.target.id === "cat-input") {
        onCatType(e.target.value);
      }
    });
    document.addEventListener("change", (e) => {
      if (!e.target || !e.target.classList) return;
      if (e.target.classList.contains("sortsel")) {
        S.sort = e.target.value;
        selectTab(S.activeTab || "discover");
      } else if (e.target.classList.contains("langchk")) {
        const l = e.target.dataset.lang;
        const allow = new Set(settings.langAllow || []);
        if (e.target.checked) allow.add(l);
        else allow.delete(l);
        settings.langAllow = Array.from(allow);
        saveSettings();
        selectTab("discover");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target && e.target.id === "cat-input") {
        e.preventDefault();
        onAction({ target: { closest: () => ({ dataset: { action: "add-cat" } }) } });
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target && e.target.id === "setup-client") {
        e.preventDefault();
        login();
      }
    });

    if (S.demo) {
      renderDemo();
      return;
    }
    if (isTokenValid()) {
      startTimer();
      refreshAll(true);
    } else {
      if (hadRedirect && !isTokenValid()) toast("Couldn't sign in — check your Client ID & redirect URL.", "err");
      renderLogin();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
