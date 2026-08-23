# 🟣 Clawraid

A **client-side OBS dock** that helps streamers find who to raid and grow their
community — no server, no backend, no secrets. It shows:

Channels are sorted into **three tabs**, exactly like the popular raid pickers:

1. **Same Game** — *everyone* live in **your current category** (the game you’re
   streaming now), with the channels you follow listed **first**.
2. **Following** — *everyone you follow who is live*, sortable by viewers or
   category. Click any **category name** to jump to Discover filtered to it.
3. **Discover** — live channels in your categories you **don’t** follow yet,
   with a **language filter**; tracked categories show their box-art thumbnail.

Every card shows title, category, viewer count, uptime, language, tags, and
one-click **Raid** / **Open** / **Follow** buttons. A search box filters across
the active tab.

Everything runs in your browser (OBS Custom Browser Dock or Browser Source). Your
Twitch token lives only in your browser’s `localStorage`.

---

## ✨ Features

- 🔐 **Twitch OAuth (Implicit flow)** — no client secret, safe for static hosting.
- ⚡ **Real raids** via the Helix `/raids` endpoint (optional scope) — start a
  raid without leaving OBS.
- ➕ **Follow from the dock** to network and build community.
- 🧭 **Three-tab layout** — Same Game / Other Categories / Discover, with a
  search box to quickly find any channel.
- 🎯 **Smart Discover** — not-yet-followed channels in your niche, sized to your
  viewer count; track extra categories and Load More.
- 🔎 **Category autocomplete** — type to search Twitch categories and pick the
  exact match (no typos / "couldn't find" errors); **View** a tracked category's
  live streams on demand.
- 🔄 **Auto-refresh** on a timer; token expiry is detected and you’re prompted
  to reconnect.
- 📱 **Compact mode** for narrow docks.
- 🧪 **Demo mode** (`?demo=1`) with sample data — preview the UI with zero setup.

---

## ⚠️ What Twitch’s API *can’t* do (and how we work around it)

The current Twitch Helix API has **no** “followed categories” endpoint and **no**
“recommendations” endpoint. So:

- **“Followed categories” / “recommendations”** don’t exist, so the dock derives
  your categories from the channels you follow that are live (plus any you
  explicitly track), and builds **Discover** by pulling live streams in those
  categories, removing anyone you already follow, and ranking by viewer size
  relative to your own channel.

This is the practical, ToS-compliant way to get the “grow your community & raid
smart” experience without a backend.

---

## 🚀 Setup

Twitch’s “Log in with Twitch” always needs a **Client ID** — there’s no way
around it. So you (the owner) create *one* Twitch app, and your users just log in.
Two flavors:

### A. Zero-setup for your viewers (recommended for sharing)
1. Create one Twitch app at <https://dev.twitch.tv/console/apps> — Name: `Clawraid`,
   **Client Type → Public**, and **OAuth Redirect URLs** → the exact URL you’ll
   host at (e.g. `https://yourname.github.io/clawraid/`). **Must match exactly.**
2. Open `app.js` and paste your **Client ID** into `EMBEDDED_CLIENT_ID` (top of the
   file). That’s the only setup — your visitors never see the dev console.
3. Host it (GitHub Pages: enable Pages on `main` / `/root`), then share the link.
4. Visitors click **Log in with Twitch**, approve the scopes, and it works.

> ⚠️ A shared Client ID shares Twitch’s API rate limit across all users. Fine for
> a community tool; for very heavy use, use option B.

### B. Each user supplies their own Client ID (no shared limit)
If `EMBEDDED_CLIENT_ID` is left empty, the dock shows a Client ID field on first
load. Each user registers their own Twitch app and pastes the ID. Use this if you
prefer not to share one ID, or are self-hosting at a different URL.

### Approved scopes
| Scope | Why |
| --- | --- |
| `user:read:follows` | Read your followed (live) channels |
| `user:edit:follows` | Follow suggested channels from the dock |
| `channel:manage:raids` | *(optional)* start raids from the dock |

---

## 📺 Use it in OBS

**As a Custom Browser Dock (recommended — stays visible while you stream):**
1. OBS ▸ **View ▸ Docks ▸ Custom Browser Docks…**
2. Name: `Clawraid`, URL: your hosted URL (same one registered as the redirect).
3. Click **Add Dock**. It appears as a panel you can dock anywhere.

**As a Browser Source (e.g. for a raid overlay/scene):**
1. Add a **Browser Source**, set the URL to your hosted link.
2. Size it (e.g. 400×800). Best for a dedicated raid scene.

> 💡 The redirect URL registered in your Twitch app **must exactly equal** the
> URL you load in OBS, including the trailing slash. The Settings panel shows the
> exact value to copy.

---

## 🌐 Hosting on GitHub (share with others)

This is a static site — perfect for GitHub Pages. Push the contents of this
folder to a repo, enable Pages (branch `main`, folder `/root`), and share the
link. With `EMBEDDED_CLIENT_ID` set, **your users just click Log in with Twitch**
— no per-user setup. Each user still connects **their own** Twitch account; only
the Client ID is shared.

A `publish.sh` helper is included to scaffold a repo & push (see below).

---

## ⚙️ Settings

Open the **gear** icon to configure:
- **Client ID / Redirect URL** (also editable here).
- **Enable raid starting** (toggle the `channel:manage:raids` scope).
- **Refresh interval** and how often suggestions rebuild.
- **Suggestion filters:** min/max viewers, and a size band
  (`sizeLower × your viewers` … `sizeUpper × your viewers`) used when you’re live.
- **Tracked categories** management.
- **Compact mode** for very narrow docks.

---

## 🔒 Privacy & security

- 100% client-side. No data leaves your browser except to Twitch’s official API.
- Your OAuth token is stored in `localStorage` on the machine running OBS.
- **Never** share your Client **Secret** — this app doesn’t use one (Implicit flow).
- Implicit tokens last ~4 hours and can’t be refreshed silently; the dock detects
  expiry and prompts you to reconnect (your stream stays up regardless).

---

## 🛠️ Development

No build step. Edit `index.html`, `styles.css`, `app.js`. Test with:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/?demo=1   (sample data, no Twitch account)
```

---

## 📄 License

MIT — see [LICENSE](LICENSE).
