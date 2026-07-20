#!/usr/bin/env node
/* Popola mappings.json con gli ID Spotify/Amazon Music per ogni release
   della collezione Discogs, senza credenziali:
   Discogs (collezione) -> iTunes/Deezer (match testuale) -> Odesli (ID piattaforme).

   - Le voci con "manual": true non vengono mai toccate.
   - I valori già trovati non vengono sovrascritti; i null vengono ritentati.
   - Odesli non espone più i link Spotify: gli ID Spotify vengono risolti
     solo se sono configurate le credenziali ufficiali (secrets
     SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET, client credentials flow).
   Env: DISCOGS_USER (default dipdkg), DISCOGS_TOKEN (opzionale, velocizza),
        SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (opzionali). */

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

/* ---------- Spotify (API ufficiale, solo con credenziali) ---------- */

const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
let spotifyToken = null;
// Diventa true dopo il primo errore fatale (es. l'app Spotify non ha i
// permessi per la Search API): evita di ripetere 600+ richieste inutili.
let spotifyDisabled = !SPOTIFY_ID || !SPOTIFY_SECRET;

async function getSpotifyToken() {
  if (spotifyDisabled) return null;
  if (spotifyToken && spotifyToken.expires > Date.now()) return spotifyToken.value;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${SPOTIFY_ID}:${SPOTIFY_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    console.warn(`Spotify: token non ottenuto (HTTP ${res.status}). Colonna Spotify disabilitata per questo giro.`);
    spotifyDisabled = true;
    return null;
  }
  const data = await res.json();
  spotifyToken = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return spotifyToken.value;
}

async function searchSpotify(artist, title, isVarious) {
  const token = await getSpotifyToken();
  if (!token) return null;
  const q = isVarious ? title : `album:${title} artist:${artist}`;
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=album&limit=8&q=${encodeURIComponent(q)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  await sleep(400);
  if (!res.ok) {
    const msg = (await res.text().catch(() => "")).slice(0, 160);
    console.warn(`Spotify: search HTTP ${res.status} — ${msg}. Colonna Spotify disabilitata per questo giro.`);
    spotifyDisabled = true; // es. "Active premium subscription required for the owner of the app"
    return null;
  }
  const data = await res.json();
  const candidates = (data.albums?.items || []).map((a) => ({
    artist: (a.artists || []).map((x) => x.name).join(", "),
    title: a.name,
    id: a.id,
  }));
  return pickBest(candidates, artist, title, isVarious)?.id || null;
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

  // Spotify via API ufficiale (se ci sono le credenziali); Amazon via Odesli.
  const spotifyId = cur?.spotify || (await searchSpotify(rel.artist, rel.title, isVarious));

  let ids = { spotify: null, amazon: null };
  if (!cur?.amazon) {
    const match = (await searchItunes(rel.artist, rel.title, isVarious)) || (await searchDeezer(rel.artist, rel.title, isVarious));
    if (match) ids = await resolveWithOdesli(match.url);
  }

  existing[key] = {
    artist: rel.artist,
    title: rel.title,
    spotify: spotifyId || ids.spotify,
    amazon: cur?.amazon || ids.amazon,
  };
  if (existing[key].spotify || existing[key].amazon) mapped++;
  console.log(`[${done}/${collection.length}] ${rel.artist} – ${rel.title} → spotify:${existing[key].spotify || "null"} amazon:${existing[key].amazon || "null"}`);
}

fs.writeFileSync(OUT, JSON.stringify(existing, null, 2) + "\n");
const totSpotify = Object.values(existing).filter((m) => m.spotify).length;
const totAmazon = Object.values(existing).filter((m) => m.amazon).length;
console.log(`\nFatto: ${mapped} mappate in questo giro (${skipped} già complete). Totale: ${totSpotify} Spotify, ${totAmazon} Amazon su ${collection.length}.`);
