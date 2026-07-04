# next-world-cup-games-sydney

Spoiler-free 2026 World Cup schedule in Sydney time (AEST), served via GitHub Pages at wc.aarondevries.com.

- `index.html` — the whole app; loads match data from `matches.json` (falls back to a built-in snapshot when offline).
- `matches.json` — canonical match data: fixtures, spoiler-safe labels, kickoff times, venues, UK broadcasters (BBC/ITV).
- `scripts/refresh-data.js` — refreshes `matches.json` from ESPN's public feed: kickoff times, venue + city, and BBC/ITV confirmations only. It never writes team names, scores or winners, so results can't leak onto the page.
- `.github/workflows/refresh-data.yml` — runs the refresh every 6 hours (and on demand via *Run workflow*).

Knockout team names are masked until the match's Sydney date arrives; the header checkbox reveals everything, and the 👁 button on a match reveals just that day.
