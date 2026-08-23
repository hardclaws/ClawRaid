# 🟣 Clawraid

A **client-side OBS dock** that helps streamers find who to raid and grow their
community — no server, no backend, no secrets. It shows:

Channels are sorted into **three tabs**, exactly like the popular raid pickers:

1. **Same Game** — channels you follow who are live in **your current category**
   (the game you’re streaming right now).
2. **Other Categories** — channels you follow who are live in a **different**
   category.
3. **Discover** — live channels in your category(ies) that you **don’t** follow
   yet, weighted toward channels with a **similar viewer size** to yours (easiest
   to build reciprocity and grow together). Track extra categories here and hit
   **Follow** / **Raid** straight from the card.

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
  viewer count (configurable band + viewer ceiling); track extra categories and
  Load More.
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

## 🚀 Setup (2 minutes)

### 1. Create a Twitch application
1. Go to <https://dev.twitch.tv/console/apps> and **Register Your Application**.
2. Name it anything (e.g. “Clawraid”).
3. **OAuth Redirect URLs** → add the exact URL where you’ll host the dock
   (e.g. `https://yourname.github.io/clawraid/`). **Must match exactly.**
4. **Client Type** → *Public*.
5. Copy the **Client ID**.

### 2. Run the dock
- **GitHub Pages (recommended for sharing):** fork/clone this repo, enable
  Pages (Settings ▸ Pages ▸ branch `main`, folder `/root`), and open the site.
- **Locally:** serve the folder with any static server, e.g.
  `python3 -m http.server 8080` then open `http://localhost:8080`.

On first load, paste your **Client ID** and click **Connect with Twitch**. Approve
the requested scopes:

| Scope | Why |
| --- | --- |
| `user:read:follows` | Read your followed (live) channels |
| `user:edit:follows` | Follow suggested channels from the dock |
| `channel:manage:raids` | *(optional)* start raids from the dock |

That’s it — the dock loads your live follows, categories, and suggestions.

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
folder to a repo, enable Pages, and share the link. Each user still connects
**their own** Twitch account (per-user Client ID is the ToS-friendly model).

Optional: self-hosted shared Client ID — copy `config.example.js` to `config.js`,
fill in your Client ID, and commit `config.js` (it’s git-ignored by default).
Only do this on your own domain; a public shared ID will hit rate limits.

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
