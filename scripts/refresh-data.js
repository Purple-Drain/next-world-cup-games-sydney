#!/usr/bin/env node
// Refreshes matches.json from ESPN's public World Cup scoreboard feed.
//
// Updates ONLY: kickoff times (iso/dateStr/datetime), venue + city, and
// BBC/ITV broadcaster confirmations. It never touches fixture, safeFixture
// or stage, and it never reads or writes scores/winners — team names and
// results stay manually curated so the feed cannot leak spoilers onto the
// spoiler-free page.
//
// Env overrides (for offline testing):
//   MATCHES_PATH  path to matches.json (default: ./matches.json)
//   FEED_FILE     read one feed JSON from disk instead of the network

const fs = require('fs');
const path = require('path');

const MATCHES_PATH = process.env.MATCHES_PATH || path.join(__dirname, '..', 'matches.json');
const FEED_URL = date =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}&region=gb&lang=en`;

// Feed team names → the names used in our fixture strings.
const ALIASES = {
  'united states': 'usa',
  'korea republic': 'south korea',
  "cote d'ivoire": 'ivory coast',
  'cabo verde': 'cape verde',
  'turkiye': 'turkey',
  'czechia': 'czech republic',
  'bosnia and herzegovina': 'bosnia-herzegovina',
  'ir iran': 'iran',
  'congo dr': 'dr congo',
  'holland': 'netherlands',
};

function norm(name) {
  const n = String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z\s'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIASES[n] || n;
}

// All team names mentioned in a fixture string, e.g.
// "🇵🇾 Paraguay/France 🇫🇷 vs 🇨🇦 Canada/Morocco 🇲🇦" → paraguay, france, canada, morocco
function fixtureTeams(fixture) {
  return String(fixture)
    .replace(/[^\p{L}\s/'-]/gu, ' ') // drop emoji/punctuation, keep letters and separators
    .split(/\s+vs?\s+|\//i)
    .map(norm)
    .filter(s => s.length > 1);
}

function aestStrings(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  const monthName = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', month: 'long' }).format(date);
  const dateStr = `${Number(parts.day)} ${monthName}`;
  return {
    iso: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
    dateStr,
    datetime: `${dateStr} - ${parts.hour}:${parts.minute} AEST`,
  };
}

function ukChannel(competition) {
  const names = [];
  for (const gb of competition.geoBroadcasts || []) {
    if (gb.media && gb.media.shortName) names.push(gb.media.shortName);
  }
  for (const b of competition.broadcasts || []) {
    for (const n of b.names || []) names.push(n);
  }
  const upper = names.map(n => String(n).toUpperCase());
  const bbc = upper.some(n => n.includes('BBC'));
  const itv = upper.some(n => n.includes('ITV') || n.includes('STV'));
  if (bbc && itv) return 'BOTH';
  if (bbc) return 'BBC';
  if (itv) return 'ITV';
  return null;
}

function eventsFromFeed(feed) {
  const events = [];
  for (const ev of feed.events || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp || !ev.date) continue;
    const teams = (comp.competitors || [])
      .map(c => c.team && (c.team.displayName || c.team.name))
      .filter(Boolean)
      .map(norm);
    if (teams.length !== 2) continue;
    events.push({
      kickoff: new Date(ev.date),
      teams,
      venue: comp.venue && comp.venue.fullName ? comp.venue.fullName : null,
      city: comp.venue && comp.venue.address && comp.venue.address.city ? comp.venue.address.city : null,
      channel: ukChannel(comp),
    });
  }
  return events;
}

async function fetchFeeds(dates) {
  if (process.env.FEED_FILE) {
    return eventsFromFeed(JSON.parse(fs.readFileSync(process.env.FEED_FILE, 'utf8')));
  }
  const events = [];
  for (const date of dates) {
    try {
      const res = await fetch(FEED_URL(date), { headers: { 'User-Agent': 'wc-schedule-refresh' } });
      if (!res.ok) {
        console.warn(`feed ${date}: HTTP ${res.status} — skipping`);
        continue;
      }
      events.push(...eventsFromFeed(await res.json()));
    } catch (err) {
      console.warn(`feed ${date}: ${err.message} — skipping`);
    }
  }
  return events;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(MATCHES_PATH, 'utf8'));
  const before = JSON.stringify(data.matches);

  // Only matches from yesterday onwards need refreshing.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const pending = data.matches.filter(m => new Date(`${m.iso}+10:00`).getTime() >= cutoff);
  if (!pending.length) {
    console.log('no upcoming matches to refresh');
    return;
  }

  // Feed dates (UTC, YYYYMMDD) covering the pending window.
  const dates = new Set();
  for (const m of pending) {
    const t = new Date(`${m.iso}+10:00`);
    for (const dayOffset of [-1, 0]) { // AEST day N maps to UTC day N-1/N
      const d = new Date(t.getTime() + dayOffset * 24 * 3600 * 1000);
      dates.add(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }
  }

  const events = await fetchFeeds([...dates].sort());
  console.log(`feed events: ${events.length}, matches to check: ${pending.length}`);

  let changed = 0;
  for (const match of pending) {
    const teams = fixtureTeams(match.fixture);
    const kickoff = new Date(`${match.iso}+10:00`);
    const event = events.find(ev =>
      ev.teams.every(t => teams.includes(t)) &&
      Math.abs(ev.kickoff - kickoff) <= 6 * 3600 * 1000
    );
    if (!event) continue;

    const updates = [];
    const t = aestStrings(event.kickoff);
    if (t.iso !== match.iso) {
      match.iso = t.iso;
      match.dateStr = t.dateStr;
      match.datetime = t.datetime;
      updates.push(`kickoff → ${t.datetime}`);
    }
    if (event.venue && event.venue !== match.venue) {
      match.venue = event.venue;
      if (event.city) match.city = event.city;
      updates.push('venue');
    }
    // Fill in unconfirmed channels only — a confirmed broadcaster (sourced
    // from the BBC's own listings) is never overridden by the feed.
    if (event.channel && !match.broadcastConfirmed) {
      match.broadcast = event.channel;
      match.broadcastConfirmed = true;
      updates.push(`broadcast → ${event.channel}`);
    }
    if (updates.length) {
      changed++;
      console.log(`updated [${match.stage}] ${match.datetime}: ${updates.join(', ')}`);
    }
  }

  if (JSON.stringify(data.matches) === before) {
    console.log('no changes');
    return;
  }
  data.updated = new Date().toISOString();
  fs.writeFileSync(MATCHES_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`wrote ${MATCHES_PATH} (${changed} matches updated)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
