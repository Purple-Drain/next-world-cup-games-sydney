#!/usr/bin/env node
// Refreshes matches.json from ESPN's public World Cup scoreboard feed.
//
// Updates: kickoff times (iso/dateStr/datetime), venue + city, BBC/ITV
// broadcaster fills (never overriding a confirmed one), and — for dependent
// fixtures — winner names into the per-side `real`/`safe` fields once a
// feeder match has completed. It never writes scores, and the page only
// displays side names according to the spoiler reveal rules (each side
// unmasks 24h after its feeder ended), so refreshed data cannot leak a
// result onto the page. Logs deliberately avoid naming winners.
//
// Env overrides (for offline testing):
//   MATCHES_PATH  path to matches.json (default: ./matches.json)
//   FEED_FILE     read one feed JSON from disk instead of the network

const fs = require('fs');
const path = require('path');

const MATCHES_PATH = process.env.MATCHES_PATH || path.join(__dirname, '..', 'matches.json');
const FEED_URL = date =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}&region=gb&lang=en`;

const MATCH_MS = 2 * 3600 * 1000; // estimated match duration
const DAY_MS = 24 * 3600 * 1000;

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

// All team names mentioned in a fixture/pairing string, e.g.
// "🇵🇾 Paraguay/France 🇫🇷 vs 🇨🇦 Canada/Morocco 🇲🇦" → paraguay, france, canada, morocco
function fixtureTeams(text) {
  return String(text)
    .replace(/[^\p{L}\s/'-]/gu, ' ') // drop emoji/punctuation, keep letters and separators
    .split(/\s+vs?\s+|\//i)
    .map(norm)
    .filter(s => s.length > 1);
}

function parseAEST(iso) {
  return new Date(`${iso}+10:00`);
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
    const competitors = (comp.competitors || []).filter(c => c.team);
    const teams = competitors
      .map(c => c.team.displayName || c.team.name)
      .filter(Boolean)
      .map(norm);
    if (teams.length !== 2) continue;
    const completed = !!(ev.status && ev.status.type && ev.status.type.completed);
    const winner = completed ? competitors.find(c => c.winner === true) : null;
    const loser = winner ? competitors.find(c => c !== winner) : null;
    events.push({
      kickoff: new Date(ev.date),
      teams,
      venue: comp.venue && comp.venue.fullName ? comp.venue.fullName : null,
      city: comp.venue && comp.venue.address && comp.venue.address.city ? comp.venue.address.city : null,
      channel: ukChannel(comp),
      winnerName: winner ? norm(winner.team.displayName || winner.team.name) : null,
      loserName: loser ? norm(loser.team.displayName || loser.team.name) : null,
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

// "🇵🇾 Paraguay v France 🇫🇷" → { paraguay: {name, flag, ...}, france: {...} }
// so winner names from the feed can be rendered with the right flag emoji.
function buildFlagMap(matches) {
  const map = {};
  for (const m of matches) {
    const parts = String(m.fixture).split(/\s+v\s+/);
    if (parts.length !== 2) continue;
    const lname = parts[0].replace(/[^\p{L}\s'-]/gu, '').trim();
    const lflag = parts[0].replace(lname, '').trim();
    const rname = parts[1].replace(/[^\p{L}\s'-]/gu, '').trim();
    const rflag = parts[1].replace(rname, '').trim();
    if (lname && lflag) map[norm(lname)] = { name: lname, flag: lflag };
    if (rname && rflag) map[norm(rname)] = { name: rname, flag: rflag };
  }
  return map;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(MATCHES_PATH, 'utf8'));
  const before = JSON.stringify(data.matches);
  const now = Date.now();

  // Refresh window: upcoming matches (times/venues/broadcast) plus the feeder
  // games of any side still waiting on a winner name.
  const pending = data.matches.filter(m => parseAEST(m.iso).getTime() >= now - DAY_MS);
  const dates = new Set();
  const addDates = t => {
    for (const dayOffset of [-1, 0]) {
      const d = new Date(t + dayOffset * DAY_MS);
      dates.add(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }
  };
  for (const m of pending) addDates(parseAEST(m.iso).getTime());
  for (const m of data.matches) {
    for (const side of [m.sideA, m.sideB]) {
      if (side && !side.real && side.revealAfter) {
        addDates(parseAEST(side.revealAfter).getTime() - MATCH_MS - DAY_MS); // ≈ feeder kickoff
      }
    }
  }
  if (!dates.size) {
    console.log('nothing to refresh');
    return;
  }

  const events = await fetchFeeds([...dates].sort());
  console.log(`feed events: ${events.length}, matches in window: ${pending.length}`);

  // --- kickoff / venue / broadcast updates -------------------------------
  let changed = 0;
  for (const match of pending) {
    const teams = fixtureTeams(match.fixture);
    const kickoff = parseAEST(match.iso);
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

  // --- winner cascade into per-side fields -------------------------------
  // A side's feeder match kicked off ≈ revealAfter - (match duration + 24h).
  const flagMap = buildFlagMap(data.matches);
  const knockout = data.matches.filter(m => !m.stage.startsWith('Group'));
  const findFeeder = side => {
    const t = parseAEST(side.revealAfter).getTime() - MATCH_MS - DAY_MS;
    return knockout.find(m => Math.abs(parseAEST(m.iso).getTime() - t) <= 2 * 3600 * 1000);
  };

  for (const match of data.matches) {
    if (!match.sideA || !match.sideB) continue;
    for (const key of ['sideA', 'sideB']) {
      const side = match[key];
      if (!side.revealAfter) continue;
      const feeder = findFeeder(side);

      // Once the feeder's own teams are known, upgrade a "Winner (…)" style
      // label to the real pairing (this is what the page shows while masked).
      if (feeder && feeder.sideA && feeder.sideB && feeder.sideA.real && feeder.sideB.real
          && !fixtureTeams(side.safe).some(t => flagMap[t])) {
        side.safe = `${feeder.sideA.real}/${feeder.sideB.real}`;
        changed++;
        console.log(`updated [${match.stage}] ${match.datetime}: ${key} pairing label`);
      }

      // Fill the side's team once the feeder match has a completed result.
      if (!side.real) {
        const pairTeams = feeder ? fixtureTeams(feeder.fixture) : fixtureTeams(side.safe);
        const feederKick = feeder ? parseAEST(feeder.iso).getTime()
          : parseAEST(side.revealAfter).getTime() - MATCH_MS - DAY_MS;
        const ev = events.find(e => e.winnerName &&
          e.teams.every(t => pairTeams.includes(t)) &&
          Math.abs(e.kickoff - feederKick) <= 6 * 3600 * 1000);
        if (!ev) continue;
        const wantLoser = /^loser/i.test(String(side.safe));
        const info = flagMap[wantLoser ? ev.loserName : ev.winnerName];
        if (!info) continue;
        side.real = key === 'sideA' ? `${info.flag} ${info.name}` : `${info.name} ${info.flag}`;
        changed++;
        console.log(`updated [${match.stage}] ${match.datetime}: ${key} team decided`);
      }
    }
    // With both sides decided, the fixture string follows (used for feed
    // matching and the fully-revealed view).
    if (match.sideA.real && match.sideB.real) {
      const fixture = `${match.sideA.real} v ${match.sideB.real}`;
      if (match.fixture !== fixture) match.fixture = fixture;
    }
  }

  if (JSON.stringify(data.matches) === before) {
    console.log('no changes');
    return;
  }
  data.updated = new Date().toISOString();
  fs.writeFileSync(MATCHES_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`wrote ${MATCHES_PATH} (${changed} updates)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
