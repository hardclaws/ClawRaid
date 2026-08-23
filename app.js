/* =========================================================================
 * Clawraid — a client-side (no backend) OBS raid dock / browser source.
 *
 * Auth: Twitch OAuth Implicit Grant (token lives only in your browser).
 * API : Twitch Helix. See README for setup.
 *
 * Channels are sorted into three tabs, à la the popular raid pickers:
 *   • Same Game       – channels you follow, live in YOUR current category
 *   • Other Categories – channels you follow, live in a DIFFERENT category
 *   • Discover         – live channels in your category(ies) you DON'T follow
 *
 * No external dependencies, no build step. Works in OBS Custom Browser Dock,
 * OBS Browser Source, or any modern browser.
 * ========================================================================= */
(function () {
  "use strict";

  /* ----------------------------- Constants ----------------------------- */
  const API = "https://api.twitch.tv/helix";
  const AUTH = "https://id.twitch.tv/oauth2/authorize";

  // Scopes. user:read:follows = live followed channels.
  // user:edit:follows        = follow a suggested channel from the dock.
  // channel:manage:raids     = actually start a raid from the dock (optional).
  const BASE_SCOPES = ["user:read:follows", "user:edit:follows"];
  const RAID_SCOPE = "channel:manage:raids";

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
    refreshSuggestionsEvery: 2, // re-build Discover every N refresh cycles
    sizeLower: 0.25, // suggest channels with viewers >= myViewers * sizeLower
    sizeUpper: 4, // ... and <= myViewers * sizeUpper (only when I'm live)
    maxViewers: 5000, // hard ceiling so we don't suggest giant channels
    minViewers: 0,
    categories: [], // [{ id, name }] user-tracked categories
    compact: false,
    discoverFirst: 30, // how many streams to pull per category in Discover
  };

  /* ----------------------------- State --------------------------------- */
  const S = {
    token: null,
    exp: 0,
    clientId: "",
    user: null, // { id, login, display_name, profile_image_url }
    meViewers: 0,
    myGameId: null,
    myGameName: null,
    followedStreams: [],
    followedIds: null, // Set of broadcaster_ids the user follows
    derivedCategories: [], // [{ id, name, streams: [...] }]
    discoverStreams: [], // not-followed live channels in your categories
    discoverFirst: 30,
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

  /* ------------------------------- Icons ------------------------------- */
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

  /* ------------------------------- Toast ------------------------------- */
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

    const headers = {
      Authorization: "Bearer " + S.token,
      "Client-Id": S.clientId,
    };
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

  async function apiAll(path, params, cap) {
    const out = [];
    let cursor = null;
    let pages = 0;
    cap = cap || 300;
    do {
      const p = Object.assign({}, params, { first: 100 });
      if (cursor) p.after = cursor;
      const data = await api(path, { params: p });
      out.push.apply(out, data.data || []);
      cursor = data.pagination && data.pagination.cursor;
      pages++;
    } while (cursor && out.length < cap && pages < 30);
    return out;
  }

  async function getMe() {
    const data = await api("/users");
    return data.data && data.data[0];
  }
  async function getMyStream() {
    if (!S.user) return null;
    const data = await api("/streams", { params: { user_id: S.user.id, first: 1 } });
    return data.data && data.data[0];
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
    const data = await api("/search/categories", { params: { query: name, first: 10 } });
    const exact = data.data.find((g) => g.name.toLowerCase() === name.toLowerCase());
    return exact || data.data[0] || null;
  }
  async function getStreamsByGame(gameId, first) {
    const data = await api("/streams", { params: { game_id: gameId, first: first || 20 } });
    return data.data || [];
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
      openSettings(true);
      toast("Enter your Twitch Client ID first.", "warn");
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

      if (!S.followedIds || S.cycle % 5 === 1) {
        S.followedIds = await getFollowedIds();
      }

      buildDerivedCategories();

      if (force || S.cycle % settings.refreshSuggestionsEvery === 0 || !S.discoverStreams.length) {
        await buildDiscover();
      }

      renderHeader();
      renderTabs();
    } catch (e) {
      if (e.message === "unauthorized") {
        renderLogin();
        toast("Session expired — please reconnect.", "warn");
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
        if (S.followedIds.has(s.user_id)) continue; // already following → not a discovery
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
    // Smallest eligible channels first → your raid has the most impact & reciprocity is easiest.
    out.sort((a, b) => (a.viewer_count || 0) - (b.viewer_count || 0));
    S.discoverStreams = out.slice(0, 80);
  }

  /* ------------------------------ Rendering ----------------------------- */
  function streamCard(s) {
    const thumb = s.thumbnail_url
      ? thumbUrl(s.thumbnail_url, 320, 180)
      : placeholder(s.user_login || s.user_name, 320, 180, (s.user_name || "?").slice(0, 2));
    const isFollowed = S.followedIds && S.followedIds.has(s.user_id);
    const tags = (s.tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const raidBtn = settings.raidsEnabled
      ? `<button class="btn raid" data-action="raid" data-uid="${esc(s.user_id)}" data-login="${esc(s.user_login)}">${ICON.bolt} Raid</button>`
      : "";
    const followBtn = isFollowed
      ? `<button class="btn follow followed" disabled>${ICON.heart} Following</button>`
      : `<button class="btn follow" data-action="follow" data-uid="${esc(s.user_id)}" data-login="${esc(s.user_login)}">${ICON.userPlus} Follow</button>`;
    return `
      <div class="card">
        <div class="thumb">
          <img src="${thumb}" alt="" loading="lazy"/>
          <span class="live">LIVE</span>
          <span class="viewers">${fmt(s.viewer_count)}</span>
        </div>
        <div class="body">
          <div class="title">${esc(s.title)}</div>
          <div class="name">${esc(s.user_name)} ${s.is_verified ? `<span class="verified" title="Verified">✓</span>` : ""}</div>
          <div class="meta">
            <span class="cat">${esc(s.game_name || "—")}</span>
            <span>· ${fmtUptime(s.started_at)}</span>
            ${s.language ? `<span>· ${esc(s.language)}</span>` : ""}
          </div>
          ${tags ? `<div class="tags">${tags}</div>` : ""}
          <div class="actions">
            ${raidBtn}
            <button class="btn open" data-action="open" data-login="${esc(s.user_login)}">${ICON.ext} Open</button>
            ${followBtn}
          </div>
        </div>
      </div>`;
  }

  function renderHeader() {
    const bar = $("#topbar");
    const expIn = S.exp ? Math.max(0, Math.floor((S.exp * 1000 - Date.now()) / 60000)) : 0;
    const meHtml = S.user
      ? `<div class="me">
           <img src="${S.user.profile_image_url || placeholder(S.user.login, 40, 40)}" alt=""/>
           <span>${esc(S.user.display_name)}</span>
           ${S.meViewers > 0 ? `<span class="livepill">${fmt(S.meViewers)} viewers</span>` : ""}
           <span class="hint" title="Token expires in ~${expIn} min">⏳ ${expIn}m</span>
         </div>`
      : "";
    bar.innerHTML = `
      <div class="brand">
        <span class="logo">${ICON.twitch}</span>
        <span class="txt">Clawraid</span>
        ${S.demo ? `<span class="demo-badge">DEMO</span>` : ""}
      </div>
      <div class="spacer"></div>
      ${meHtml}
      <button class="iconbtn" data-action="refresh" title="Refresh now">${ICON.refresh}</button>
      <button class="iconbtn" data-action="settings" title="Settings">${ICON.gear}</button>
    `;
    if (settings.compact) $("#app").classList.add("compact");
    else $("#app").classList.remove("compact");
  }

  function renderTabs() {
    const c = $("#content");
    const sameCount = S.myGameId ? S.followedStreams.filter((s) => s.game_id === S.myGameId).length : 0;
    const otherCount = S.myGameId ? S.followedStreams.filter((s) => s.game_id !== S.myGameId).length : S.followedStreams.length;
    const discCount = (S.discoverStreams || []).length;

    if (!S.activeTab) S.activeTab = S.myGameId && sameCount > 0 ? "same" : "discover";

    c.innerHTML = `
      <div class="tabs">
        <button class="tab ${S.activeTab === "same" ? "active" : ""}" data-action="tab" data-tab="same">Same Game <span class="count">${sameCount}</span></button>
        <button class="tab ${S.activeTab === "other" ? "active" : ""}" data-action="tab" data-tab="other">Other Categories <span class="count">${otherCount}</span></button>
        <button class="tab ${S.activeTab === "discover" ? "active" : ""}" data-action="tab" data-tab="discover">Discover <span class="count">${discCount}</span></button>
      </div>
      <div class="searchrow">
        <span class="searchico">${ICON.search}</span>
        <input type="text" id="search" placeholder="Search channels…" value="${esc(S.searchTerm || "")}" />
      </div>
      <div id="tab-content"></div>`;
    selectTab(S.activeTab);
  }

  function selectTab(tab) {
    S.activeTab = tab;
    $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    const tc = document.getElementById("tab-content");
    if (!tc) return;

    const q = (S.searchTerm || "").toLowerCase();
    const match = (s) =>
      !q || (s.user_name || "").toLowerCase().includes(q) || (s.title || "").toLowerCase().includes(q);

    if (tab === "same") {
      const list = (S.myGameId ? S.followedStreams.filter((s) => s.game_id === S.myGameId) : []).filter(match);
      tc.innerHTML = list.length
        ? list.map(streamCard).join("")
        : emptyState(S.myGameId ? `No followed channels are live in ${esc(S.myGameName || "your category")} right now.` : "You're not live — go live to populate Same Game.");
    } else if (tab === "other") {
      const list = (S.myGameId ? S.followedStreams.filter((s) => s.game_id !== S.myGameId) : S.followedStreams).filter(match);
      tc.innerHTML = list.length
        ? list.map(streamCard).join("")
        : emptyState("None of the channels you follow are live in other categories.");
    } else if (tab === "discover") {
      renderDiscover(tc, q);
    }
  }

  function renderDiscover(tc, q) {
    const catRows = settings.categories
      .map((c) => `<span class="tag">${esc(c.name)} <a data-action="remove-cat" data-name="${esc(c.name)}" style="cursor:pointer;color:var(--red)">✕</a></span>`)
      .join(" ");
    const list = (S.discoverStreams || []).filter(
      (s) => !q || (s.user_name || "").toLowerCase().includes(q) || (s.title || "").toLowerCase().includes(q)
    );
    const hint = S.myGameId
      ? `Live channels in <b>${esc(S.myGameName)}</b> + your tracked categories that you don't follow yet.`
      : `Live channels in your tracked/derived categories you don't follow yet.` +
        (S.meViewers > 0 ? ` Sized near your ${fmt(S.meViewers)} viewers.` : "");

    tc.innerHTML = `
      <div class="cat-add">
        <input type="text" id="cat-input" placeholder="Add a category to discover (e.g. Just Chatting)" />
        <button class="btn raid" data-action="add-cat">+ Track</button>
      </div>
      <div class="hint" style="font-size:11px;color:var(--text-faint);margin:2px 0 8px">${hint}</div>
      ${settings.categories.length ? `<div class="chips" style="margin-bottom:8px">${catRows}</div>` : ""}
      ${list.length ? list.map(streamCard).join("") : emptyState("No discoveries right now. Track more categories or widen the size filter in Settings.")}
      ${S.discoverFirst < 100 && (S.discoverStreams || []).length ? `<button class="btn" data-action="discover-more" style="margin-top:8px">Load More</button>` : ""}
    `;
  }

  function renderLogin() {
    const c = $("#content");
    c.innerHTML = `
      <div class="setup">
        <h1>${ICON.twitch} Clawraid ${S.demo ? `<span class="demo-badge">DEMO</span>` : ""}</h1>
        <p>A client-side OBS dock that helps you find who to raid and grow your community — live channels you follow, sorted into Same Game / Other Categories / Discover.</p>
        ${
          S.demo
            ? `<div class="banner">Demo mode uses fake data so you can preview the layout. Connect a real Twitch account to use it for real.</div>`
            : ""
        }
        <div class="field">
          <label>Twitch Client ID</label>
          <input type="text" id="setup-client" placeholder="Paste the Client ID from your Twitch app" value="${esc(S.clientId)}" />
          <div class="hint" style="font-size:11px;color:var(--text-faint);margin-top:6px">
            Register a free app at <code>dev.twitch.tv/console/apps</code>. Set the OAuth Redirect URL to exactly:<br/>
            <code id="setup-redirect">${esc(redirectUri())}</code>
          </div>
        </div>
        <button class="connect" data-action="connect">Connect with Twitch</button>
        <button class="demo" data-action="demo">View demo with sample data</button>
      </div>`;
    $("#topbar").innerHTML = `
      <div class="brand"><span class="logo">${ICON.twitch}</span><span class="txt">Clawraid</span></div>`;
  }

  /* --------------------------- Demo (no network) ----------------------- */
  function renderDemo() {
    const games = ["Just Chatting", "Science & Technology", "Art", "Software and Game Development", "Retro"];
    const names = ["PixelPioneer", "CodeWithMia", "SynthWaveSam", "RetroRanger", "ArtfulAda", "StreamSage", "NightOwlNate", "QuestQueen", "BitBard", "LoopLucas", "MapleMorgan", "EchoEllis"];
    const makeStream = (i, game) => ({
      user_id: "d" + i,
      user_login: names[i].toLowerCase(),
      user_name: names[i],
      game_id: "g" + i,
      game_name: game,
      viewer_count: Math.floor(20 + Math.random() * 900),
      title: "Building cool things & chatting with you all! " + (i % 3 === 0 ? "🎉" : ""),
      thumbnail_url: "",
      started_at: new Date(Date.now() - (i + 1) * 9 * 60000).toISOString(),
      language: "en",
      tags: ["English", i % 2 ? "Creative" : "Chill"],
    });
    S.user = { id: "me", login: "YourChannel", display_name: "YourChannel", profile_image_url: "" };
    S.meViewers = 120;
    S.myGameId = "g0";
    S.myGameName = "Just Chatting";
    S.followedIds = new Set(["d0", "d1", "d2"]);
    S.followedStreams = [makeStream(0, "Just Chatting"), makeStream(1, "Science & Technology"), makeStream(2, "Art")];
    S.derivedCategories = [
      { id: "g0", name: "Just Chatting", streams: [S.followedStreams[0]] },
      { id: "g1", name: "Science & Technology", streams: [S.followedStreams[1]] },
      { id: "g2", name: "Art", streams: [S.followedStreams[2]] },
    ];
    S._demoDiscover = [3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => makeStream(i, games[i % games.length]));
    S._demoDiscover = S._demoDiscover.filter((s) => !S.followedIds.has(s.user_id));
    S.discoverStreams = S._demoDiscover;
    S.searchTerm = "";
    S.activeTab = "same";

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
        <div class="setting-row">
          <div>
            <label>Client ID</label>
            <div class="hint">From dev.twitch.tv/console/apps</div>
          </div>
          <input type="text" id="set-client" value="${esc(S.clientId)}" style="width:200px"/>
        </div>
        <div class="setting-row">
          <div>
            <label>OAuth Redirect URL</label>
            <div class="hint">Register this exact URL in your Twitch app</div>
          </div>
          <input type="text" id="set-redirect" value="${esc(r)}" style="width:240px"/>
        </div>
        <div class="setting-row">
          <div>
            <label>Enable raid starting</label>
            <div class="hint">Needs the channel:manage:raids scope. If off, only quick links are shown.</div>
          </div>
          <label class="switch"><input type="checkbox" id="set-raids" ${settings.raidsEnabled ? "checked" : ""}/><span class="slider"></span></label>
        </div>

        <h3>Refresh</h3>
        <div class="setting-row">
          <label>Refresh live data every (seconds)</label>
          <input type="number" id="set-refresh" min="20" max="600" value="${settings.refreshSeconds}"/>
        </div>
        <div class="setting-row">
          <label>Rebuild Discover every N refreshes</label>
          <input type="number" id="set-sugg" min="1" max="20" value="${settings.refreshSuggestionsEvery}"/>
        </div>

        <h3>Discover filters</h3>
        <div class="setting-row">
          <label>Min viewers</label>
          <input type="number" id="set-minv" min="0" value="${settings.minViewers}"/>
        </div>
        <div class="setting-row">
          <label>Max viewers (ceiling)</label>
          <input type="number" id="set-maxv" min="0" value="${settings.maxViewers}"/>
        </div>
        <div class="hint" style="font-size:11px;color:var(--text-faint);margin-bottom:6px">
          When you're live, Discover is limited to channels with viewers between
          <b>sizeLower × your viewers</b> and <b>sizeUpper × your viewers</b>.
        </div>
        <div class="setting-row">
          <label>Size lower (×)</label>
          <input type="number" id="set-lower" min="0" step="0.05" value="${settings.sizeLower}"/>
        </div>
        <div class="setting-row">
          <label>Size upper (×)</label>
          <input type="number" id="set-upper" min="0" step="0.5" value="${settings.sizeUpper}"/>
        </div>

        <h3>Appearance</h3>
        <div class="setting-row">
          <div><label>Compact mode</label><div class="hint">Better for very narrow docks</div></div>
          <label class="switch"><input type="checkbox" id="set-compact" ${settings.compact ? "checked" : ""}/><span class="slider"></span></label>
        </div>

        <h3>Tracked categories</h3>
        <div>${catRows || '<span class="hint" style="font-size:11px;color:var(--text-faint)">None yet — add them in the Discover tab.</span>'}</div>
      </div>
      <div class="foot">
        <button class="btn" data-action="logout">Disconnect</button>
        <button class="btn raid" data-action="save-settings">Save</button>
      </div>
    `);
    if (forceClientId) {
      const inp = $("#set-client");
      if (inp) inp.focus();
    }
  }

  async function saveSettingsFromModal() {
    const cid = $("#set-client").value.trim();
    const red = $("#set-redirect").value.trim();
    settings.raidsEnabled = $("#set-raids").checked;
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
      <div class="body">
        <p style="color:var(--text-dim);font-size:13px;line-height:1.5">
          This sends your <b>${fmt(S.meViewers)}</b> viewers to <b>${esc(login)}</b>.
          Twitch starts a 90-second countdown; you (or the timer) confirm the raid on Twitch's side.
        </p>
        <p class="hint" style="font-size:11px;color:var(--text-faint)">Rate limit: 10 raids per 10 minutes.</p>
      </div>
      <div class="foot">
        <button class="btn" data-action="close-modal">Cancel</button>
        <button class="btn raid" id="confirm-raid-btn" data-uid="${esc(uid)}" data-login="${esc(login)}">${ICON.bolt} Raid ${esc(login)}</button>
      </div>
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
        const v = $("#setup-client").value.trim();
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
        break;
      }
      case "remove-cat": {
        const name = btn.dataset.name;
        settings.categories = settings.categories.filter((c) => c.name !== name);
        saveSettings();
        if (S.activeTab === "discover") renderTabs();
        else if ($("#modal-root").innerHTML) openSettings(false);
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

  async function addCategory(name) {
    if (!S.clientId && !S.demo) {
      toast("Connect Twitch first.", "warn");
      return;
    }
    if (settings.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      toast("Already tracking " + name, "warn");
      return;
    }
    if (S.demo) {
      settings.categories.push({ id: "demo-" + name, name });
      saveSettings();
      renderTabs();
      toast("Tracking " + name + " (demo)", "ok");
      return;
    }
    try {
      const g = await resolveGame(name);
      if (!g) {
        toast("Couldn't find a category named '" + name + "'", "err");
        return;
      }
      settings.categories.push({ id: g.id, name: g.name });
      saveSettings();
      renderTabs();
      toast("Tracking " + g.name, "ok");
    } catch (e) {
      toast(e.message, "err");
    }
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
      if (e.target && e.target.id === "search") {
        S.searchTerm = e.target.value;
        selectTab(S.activeTab || "discover");
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
