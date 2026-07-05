# next-world-cup-games-sydney

Spoiler-free 2026 World Cup schedule in Sydney time (AEST), served via GitHub Pages at wc.aarondevries.com.

- `index.html` — the whole app; loads match data from `matches.json` (falls back to a built-in snapshot when offline).
- `matches.json` — canonical match data: fixtures, spoiler-safe labels, kickoff times, venues, UK broadcasters (BBC/ITV).
- `scripts/refresh-data.js` — refreshes `matches.json` from ESPN's public feed: kickoff times, venue + city, BBC/ITV fills (never overriding a confirmed channel), and knockout winner names cascaded into per-side fields. It never writes scores, and the page gates every side name behind the spoiler rules, so refreshed data can't leak a result.
- `.github/workflows/refresh-data.yml` — runs the refresh every 6 hours (and on demand via *Run workflow*).

Spoiler rules: each side of a knockout fixture auto-reveals 24 hours after the feeder game that decided it ended (so nothing shows "a day ahead"), everything reveals on its match day, the header checkbox reveals all, and the 👁 button on a match reveals just that day.
