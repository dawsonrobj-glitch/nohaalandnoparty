#!/usr/bin/env node
/**
 * Rebuilds the entire league state from the FPL API.
 *
 * Nothing is incremental. Every run recomputes the whole season from scratch,
 * so it is safe to run as often as you like and impossible to double-charge.
 * Finished gameweeks are cached to .cache/ purely to be polite to FPL's servers
 * (delete .cache/ to force a full rebuild).
 *
 * Output: public/data.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://fantasy.premierleague.com/api';
const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const OUT_FILE = path.join(ROOT, 'public', 'data.json');

// FPL sits behind Cloudflare and rejects requests without a plausible UA.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(endpoint, { retries = 3, allow404 = false } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}${endpoint}`, { headers: HEADERS });
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await sleep(120); // be gentle
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw new Error(`Failed ${endpoint}: ${err.message}`);
      await sleep(1000 * attempt);
    }
  }
}

async function cached(key, finished, fn) {
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (finished) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      /* cache miss */
    }
  }
  const value = await fn();
  if (finished && value !== null) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  }
  return value;
}

// ---------------------------------------------------------------- main

async function main() {
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'league.json'), 'utf8'));
  const { rules } = config;

  if (!config.leagueId) throw new Error('Set leagueId in config/league.json first.');

  console.log('Fetching bootstrap...');
  const bootstrap = await get('/bootstrap-static/');

  const events = bootstrap.events.map((e) => ({
    id: e.id,
    deadline: e.deadline_time,
    month: new Date(e.deadline_time).getUTCMonth() + 1,
    finished: e.finished && e.data_checked,
    started: new Date(e.deadline_time) < new Date(),
  }));
  const playedEvents = events.filter((e) => e.started);

  const haaland = bootstrap.elements.find(
    (el) => el.web_name === 'Haaland' && el.first_name.startsWith('Erling'),
  );
  if (!haaland) console.warn('Warning: could not find Haaland in the player list.');

  const playerName = new Map(bootstrap.elements.map((el) => [el.id, el.web_name]));

  // ---- managers, straight from the league standings
  console.log(`Fetching league ${config.leagueId}...`);
  const league = await get(`/leagues-classic/${config.leagueId}/standings/`);
  const leagueName = league.league.name;

  // Before GW1 the standings array is empty and everyone sits in `new_entries`.
  // Late joiners can linger there mid-season too, so merge both and de-duplicate.
  const seen = new Set();
  const managers = [];

  for (const r of league.standings.results) {
    seen.add(r.entry);
    managers.push({
      entryId: r.entry,
      name: r.player_name,
      teamName: r.entry_name,
      totalPoints: r.total,
      leagueRank: r.rank,
    });
  }

  for (const r of league.new_entries?.results ?? []) {
    if (seen.has(r.entry)) continue;
    seen.add(r.entry);
    managers.push({
      entryId: r.entry,
      name: [r.player_first_name, r.player_last_name].filter(Boolean).join(' ').trim(),
      teamName: r.entry_name,
      totalPoints: 0,
      leagueRank: null,
    });
  }
  console.log(`Found ${managers.length} managers.`);

  // ---- live player scores per gameweek
  const livePoints = new Map(); // gw -> Map(elementId -> points)
  for (const ev of playedEvents) {
    const slim = await cached(`live-${ev.id}`, ev.finished, async () => {
      const live = await get(`/event/${ev.id}/live/`, { allow404: true });
      if (!live) return null;
      return Object.fromEntries(live.elements.map((el) => [el.id, el.stats.total_points]));
    });
    if (slim) livePoints.set(ev.id, new Map(Object.entries(slim).map(([k, v]) => [Number(k), v])));
  }

  // ---- per manager
  const ledger = [];
  const detail = [];

  for (const m of managers) {
    console.log(`Processing ${m.name}...`);

    const history = await get(`/entry/${m.entryId}/history/`);
    const rawTransfers = await get(`/entry/${m.entryId}/transfers/`);

    // Gameweeks in which a fee-exempt chip was played.
    const exemptGws = new Set(
      history.chips
        .filter((c) => rules.chipsExemptFromTransferFee.includes(c.name))
        .map((c) => c.event),
    );
    const tcGws = new Set(
      history.chips.filter((c) => c.name === '3xc').map((c) => c.event),
    );

    // ---- transfers
    let chargeableTransfers = 0;
    for (const t of rawTransfers) {
      if (exemptGws.has(t.event)) continue;
      chargeableTransfers++;
      ledger.push({
        entryId: m.entryId,
        manager: m.name,
        gw: t.event,
        date: t.time,
        type: 'TRANSFER',
        amount: rules.transferFee,
        description: `${playerName.get(t.element_out) ?? t.element_out} \u2192 ${playerName.get(t.element_in) ?? t.element_in}`,
      });
    }

    // ---- picks: captain fines + Haaland
    const gwRows = [];
    let ownedHaalandLastGw = false;

    for (const ev of playedEvents) {
      const picks = await cached(`picks-${m.entryId}-${ev.id}`, ev.finished, () =>
        get(`/entry/${m.entryId}/event/${ev.id}/picks/`, { allow404: true }),
      );
      if (!picks) continue;

      // The armband is whoever actually has a multiplier >= 2. If the captain
      // did not play, FPL zeroes him and promotes the vice, so this handles the
      // vice-captain rule automatically.
      const armband = picks.picks.find((p) => p.multiplier >= 2);
      const isTC = tcGws.has(ev.id) || armband?.multiplier === 3;
      const pts = armband ? livePoints.get(ev.id)?.get(armband.element) : null;

      let fine = 0;
      if (ev.finished && armband && pts !== null && pts !== undefined) {
        const threshold = isTC ? rules.tripleCaptainFineThreshold : rules.captainFineThreshold;
        const amount = isTC ? rules.tripleCaptainFineAmount : rules.captainFineAmount;
        if (pts <= threshold) {
          fine = amount;
          ledger.push({
            entryId: m.entryId,
            manager: m.name,
            gw: ev.id,
            date: ev.deadline,
            type: isTC ? 'TRIPLE_CAPTAIN_FINE' : 'CAPTAIN_FINE',
            amount,
            description: `${isTC ? 'Triple captained' : 'Captained'} ${playerName.get(armband.element)} for ${pts} pts`,
          });
        }
      }

      // ---- Haaland
      const ownsHaaland = haaland ? picks.picks.some((p) => p.element === haaland.id) : false;
      const chargeHaaland =
        ownsHaaland &&
        (rules.haalandFineMode === 'per_gameweek' || !ownedHaalandLastGw);
      if (chargeHaaland) {
        ledger.push({
          entryId: m.entryId,
          manager: m.name,
          gw: ev.id,
          date: ev.deadline,
          type: 'HAALAND_VIOLATION',
          amount: rules.haalandFineAmount,
          description: 'Owned Erling Haaland',
        });
      }
      ownedHaalandLastGw = ownsHaaland;

      const hist = history.current.find((h) => h.event === ev.id);
      gwRows.push({
        gw: ev.id,
        points: hist ? (rules.periodScoring === 'gross' ? hist.points + hist.event_transfers_cost : hist.points) : 0,
        rawPoints: hist?.points ?? 0,
        hitCost: hist?.event_transfers_cost ?? 0,
        captain: armband ? playerName.get(armband.element) : null,
        captainPoints: pts ?? null,
        tripleCaptain: isTC,
        captainFine: fine,
        ownsHaaland,
      });
    }

    detail.push({ ...m, chargeableTransfers, totalTransfers: rawTransfers.length, gameweeks: gwRows });
  }

  // ---- manual adjustments (prizes paid out, etc.)
  for (const adj of config.manualAdjustments.filter((a) => !a._example)) {
    const m = managers.find((x) => x.entryId === adj.entryId);
    ledger.push({
      entryId: adj.entryId,
      manager: m?.name ?? 'Unknown',
      gw: null,
      date: adj.date,
      type: adj.type,
      amount: adj.amount,
      description: adj.description,
    });
  }

  // ---- period standings
  const periods = config.periods.map((p) => {
    const gws = events.filter((e) => p.months.includes(e.month)).map((e) => e.id);
    const table = detail
      .map((m) => ({
        entryId: m.entryId,
        name: m.name,
        points: m.gameweeks.filter((g) => gws.includes(g.gw)).reduce((s, g) => s + g.points, 0),
      }))
      .sort((a, b) => b.points - a.points);
    const complete = gws.length > 0 && gws.every((id) => events.find((e) => e.id === id).finished);
    return { ...p, gameweeks: gws, complete, table, winner: complete ? table[0] : null };
  });

  // ---- money
  const contributions = detail.map((m) => {
    const rows = ledger.filter((l) => l.entryId === m.entryId && l.amount > 0);
    return {
      entryId: m.entryId,
      name: m.name,
      transfers: m.chargeableTransfers,
      transferFees: rows.filter((r) => r.type === 'TRANSFER').reduce((s, r) => s + r.amount, 0),
      captainFines: rows.filter((r) => r.type.includes('CAPTAIN')).reduce((s, r) => s + r.amount, 0),
      haalandFines: rows.filter((r) => r.type === 'HAALAND_VIOLATION').reduce((s, r) => s + r.amount, 0),
      total: rows.reduce((s, r) => s + r.amount, 0),
    };
  });

  const potIn = ledger.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const potOut = ledger.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0);

  const output = {
    generatedAt: new Date().toISOString(),
    leagueName,
    currentGameweek: playedEvents.at(-1)?.id ?? null,
    rules,
    standings: detail
      .map(({ gameweeks, ...m }) => m)
      .sort((a, b) => b.totalPoints - a.totalPoints),
    transferPot: {
      balance: potIn + potOut,
      paidIn: potIn,
      paidOut: Math.abs(potOut),
      nextPeriod: periods.find((p) => !p.complete)?.label ?? null,
    },
    mainPot: config.entryFee * Math.max(managers.length - 1, 0),
    contributions: contributions.sort((a, b) => b.total - a.total),
    periods,
    managers: detail,
    ledger: ledger.sort((a, b) => new Date(a.date) - new Date(b.date)),
  };

  // The generatedAt timestamp changes on every run, which would make the file
  // look different even when nothing happened. Compare everything else, and
  // leave the file untouched if the league is genuinely unchanged — that keeps
  // git quiet and stops Netlify rebuilding for no reason.
  const { generatedAt, ...content } = output;
  try {
    const { generatedAt: _prev, ...prevContent } = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
    if (JSON.stringify(prevContent) === JSON.stringify(content)) {
      console.log('Nothing has changed. Leaving data.json alone.');
      return;
    }
  } catch {
    /* no existing file, so write one */
  }

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`Transfer pot: £${output.transferPot.balance} | ${ledger.length} ledger entries`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
