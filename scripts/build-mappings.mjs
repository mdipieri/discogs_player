#!/usr/bin/env node
/* Popola mappings.json con gli ID Spotify/Amazon Music per ogni release
   della collezione Discogs, senza credenziali:
   Discogs (collezione) -> iTunes/Deezer (match testuale) -> Odesli (ID piattaforme).

   - Le voci con "manual": true non vengono mai toccate.
   - I valori già trovati non vengono sovrascritti; i null vengono ritentati.
   Env: DISCOGS_USER (default dipdkg), DISCOGS_TOKEN (opzionale, velocizza). */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USER = process.env.DISCOGS_USER || "dipdkg";
const TOKEN = process.env.DISCOGS_TOKEN || "";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mappings.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "VinylStreamerMapper/1.0 +https://github.com/mdipieri/discogs_player", Accept: "application/json" },
      });
    } catch {
      await sleep(5000 * (i + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(10000 * (i + 1));
      continue;
    }
    if (!res.ok) return null;
    return res.json();
  }
  return null;
}

/* ---------- Normalizzazione e matching ---------- */

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // via suffissi di edizione tra parentesi: (Remastered), [Deluxe Edition], ...
    .replace(/\s*[([][^)\]]*(remaster|deluxe|edition|anniversary|expanded|bonus|reissue|mono|stereo|version)[^)\]]*[)\]]/gi, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return new Set(norm(s).split(" ").filter(Boolean));
}

function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function pickBest(candidates, artist, title, isVarious) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const tScore = jaccard(c.title, title);
    const aScore = isVarious ? 1 : jaccard(c.artist, artist);
    const artistOk = isVarious || aScore >= 0.5 || norm(c.artist).includes(norm(artist)) || norm(artist).includes(norm(c.artist));
    const minTitle = isVarious ? 0.8 : 0.6;
    if (tScore >= minTitle && artistOk && tScore + aScore > bestScore) {
      best = c;
      bestScore = tScore + aScore;
    }
  }
  return best;
}

/* ---------- Sorgenti ---------- */

async function fetchCollection() {
  const releases = [];
  let page = 1, pages = 1;
  while (page <= pages) {
    const url =
      `https://api.discogs.com/users/${encodeURIComponent(USER)}/collection/folders/0/releases` +
      `?per_page=100&page=${page}` + (TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : "");
    const data = await getJSON(url, 5);
    if (!data) throw new Error(`Discogs non risponde (pagina ${page})`);
    pages = data.pagination?.pages || 1;
    for (const r of data.releases || []) {
      const b = r.basic_information || {};
      const artists = (b.artists || []).map((a) => a.name.replace(/\s+\(\d+\)$/, ""));
      releases.push({ id: b.id || r.id, artist: artists.join(", ") || "Sconosciuto", title: b.title || "" });
    }
    page++;
    if (page <= pages) await sleep(TOKEN ? 1100 : 2600);
  }
  return releases;
}

async function searchItunes(artist, title, isVarious) {
  const term = isVarious ? title : `${artist} ${title}`;
  const data = await getJSON(`https://itunes.apple.com/search?media=music&entity=album&limit=8&term=${encodeURIComponent(term)}`);
  await sleep(3500); // iTunes: ~20 richieste/min senza chiave
  const candidates = (data?.results || []).map((r) => ({ artist: r.artistName, title: r.collectionName, url: r.collectionViewUrl }));
  return pickBest(candidates, artist, title, isVarious);
}

async function searchDeezer(artist, title, isVarious) {
  const q = isVarious ? `album:"${title}"` : `artist:"${artist}" album:"${title}"`;
  const data = await getJSON(`https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=8`);
  await sleep(1000);
  const candidates = (data?.data || []).map((r) => ({ artist: r.artist?.name, title: r.title, url: `https://www.deezer.com/album/${r.id}` }));
  return pickBest(candidates, artist, title, isVarious);
}

async function resolveWithOdesli(albumUrl) {
  const data = await getJSON(`https://api.song.link/v1-alpha.1/links?userCountry=IT&url=${encodeURIComponent(albumUrl)}`);
  await sleep(6500); // Odesli: 10 richieste/min senza chiave
  if (!data?.linksByPlatform) return { spotify: null, amazon: null };
  const spotifyUrl = data.linksByPlatform.spotify?.url || "";
  const amazonUrl = data.linksByPlatform.amazonMusic?.url || "";
  return {
    spotify: spotifyUrl.match(/album\/([A-Za-z0-9]+)/)?.[1] || null,
    amazon: amazonUrl.match(/\/albums\/([A-Z0-9]{10})/)?.[1] || null,
  };
}

/* ---------- Main ---------- */

const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const collection = await fetchCollection();
console.log(`Collezione di ${USER}: ${collection.length} release`);

let done = 0, mapped = 0, skipped = 0;
for (const rel of collection) {
  done++;
  const key = String(rel.id);
  const cur = existing[key];
  if (cur && (cur.manual === true || (cur.spotify && cur.amazon))) {
    skipped++;
    continue;
  }

  const isVarious = /^various/i.test(rel.artist);
  const match = (await searchItunes(rel.artist, rel.title, isVarious)) || (await searchDeezer(rel.artist, rel.title, isVarious));

  let ids = { spotify: null, amazon: null };
  if (match) ids = await resolveWithOdesli(match.url);

  existing[key] = {
    artist: rel.artist,
    title: rel.title,
    spotify: cur?.spotify || ids.spotify,
    amazon: cur?.amazon || ids.amazon,
  };
  if (existing[key].spotify || existing[key].amazon) mapped++;
  console.log(`[${done}/${collection.length}] ${rel.artist} – ${rel.title} → spotify:${existing[key].spotify || "null"} amazon:${existing[key].amazon || "null"}`);
}

fs.writeFileSync(OUT, JSON.stringify(existing, null, 2) + "\n");
const totSpotify = Object.values(existing).filter((m) => m.spotify).length;
const totAmazon = Object.values(existing).filter((m) => m.amazon).length;
console.log(`\nFatto: ${mapped} mappate in questo giro (${skipped} già complete). Totale: ${totSpotify} Spotify, ${totAmazon} Amazon su ${collection.length}.`);
