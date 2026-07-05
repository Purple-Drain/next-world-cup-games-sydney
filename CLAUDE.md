# Project notes for Claude Code

Single-file static site (GitHub Pages, custom domain via `CNAME`, no build step) showing the 2026 World Cup schedule in Sydney time for someone watching UK coverage on delay. **The whole point of the site is avoiding spoilers** — treat any change that could surface a result early as a bug.

## Architecture
- `index.html` — entire app (Tailwind + Twemoji from CDN, vanilla JS). Fetches `matches.json`; falls back to the inline `FALLBACK_MATCHES` snapshot. When match data changes, update **both** (regenerate the JSON from the inline array, or vice versa — keep them in sync).
- `matches.json` — canonical data. Refreshed by `.github/workflows/refresh-data.yml` (6-hourly, main branch only) running `scripts/refresh-data.js` against ESPN's public scoreboard feed.
- Deploy = push to `main`; Pages serves it directly.

## Spoiler rules (owner's spec — do not weaken)
1. Knockout fixture team names are the spoiler; kickoff times, venues and BBC/ITV channels are always safe to show.
2. Each **side** of a dependent fixture reveals independently, 24h after the feeder game that decided it ended (`side.revealAfter` = feeder estimated end + 24h). Never reveal "a day ahead".
3. While masked, show the fixture "one level above" in compact `t1/t2 vs t3/t4` form (e.g. `🇧🇷 Brazil/Japan 🇯🇵 vs 🇨🇮 Ivory Coast/Norway 🇳🇴`). That level of spoiler is acceptable per the owner.
4. Everything reveals on its own match day (AEST); the header checkbox reveals all; the 👁 button reveals one day at a time. Reveal state is in-memory only — never persist it.
5. `scripts/refresh-data.js` may write winner names into side `real` fields (display stays gated) but must never write scores, and its logs/commits must not name winners.

## Data conventions
- Times are AEST strings without offset (`iso: "2026-07-05T03:00:00"` = AEST wall time; parse with `+10:00`). UK sources publish BST: AEST = BST + 9.
- Broadcasters are UK (BBC/ITV — owner wants it that way; don't switch to Australian channels). `broadcastConfirmed: true` means sourced from the BBC's own listings — the feed must never override it, only fill unconfirmed ones.
- Fixture format: `"🇫🇷 France v Senegal 🇸🇳"` (left team flag-first, right team flag-last); masked sides join with `vs`, fully-revealed with `v`.

## Verifying changes
Serve locally (`python3 -m http.server`) and drive with Playwright Chromium. Freeze the clock (`page.clock.install`) to test reveal boundaries deterministically. Assert: no future-day team names in default DOM text, per-side partial reveals, per-day/global toggles, reload resets, and the `matches.json` → fallback path. CDN hosts may be blocked in sandboxes — compile Tailwind locally and intercept the CDN request to test styled.
