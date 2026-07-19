---
name: verify
description: Verifica end-to-end di Vinyl Streamer (sito statico + API Discogs mockata)
---

# Verifica di Vinyl Streamer

Sito completamente statico, nessuna build.

## Avvio

```bash
python3 -m http.server 8000 --bind 127.0.0.1   # dalla root del repo
```

## Drive

L'API `api.discogs.com` non è raggiungibile dalla sandbox (proxy 403): va
mockata con Playwright `page.route("https://api.discogs.com/**", ...)`
restituendo la forma `{ pagination: { page, pages }, releases: [{ id,
date_added, basic_information: { id, title, year, artists: [{name}],
genres, styles, formats, thumb, cover_image } }] }`.

Playwright è installato globalmente: lanciare con
`NODE_PATH=/opt/node22/lib/node_modules node <script>.js` e
`chromium.launch()` (browsers in `/opt/pw-browsers`).

Attenzione: tra una pagina e l'altra l'app attende ~2.6s senza token
(rate limit Discogs), quindi usare timeout generosi nei `waitFor*`.

## Flussi da coprire

- Caricamento a 2+ pagine mockate → griglia, contatore, progress bar che sparisce.
- Dettaglio album: artista con suffisso "(2)" pulito, link Spotify/Amazon/YTM/Discogs corretti.
- Artista "Various" → query di ricerca col solo titolo.
- Ricerca, filtro genere, ordinamenti, 🎲 random.
- Reload → serve dalla cache localStorage senza chiamate API.
- Mock 403 → messaggio "collezione non pubblica" visibile in #error.

## Gotcha

- `[hidden]` è neutralizzato da qualunque regola `display:` autore: il CSS
  ha `[hidden] { display: none !important; }` apposta — non rimuoverla.

## Mapping streaming

- `mappings.json` (root) mappa release Discogs → ID Spotify/ASIN Amazon; l'app
  fa fallback sulla ricerca per gli ID null/assenti. Nei test mockare con
  `page.route("**/mappings.json", ...)` PRIMA di `page.goto`.
- Il file è generato da `scripts/build-mappings.mjs` via workflow
  `mappings.yml` (gira solo in GitHub Actions: gli host iTunes/Deezer/Odesli
  sono bloccati dal proxy della sandbox).

## Filtro formato e vista crate

- Il formato (LP / 12" / 7" / Altro) è derivato da `formats[].descriptions`
  dei mock: passare `fmtDesc` a mkRelease nei test.
- La vista crate (#btn-crate) usa scroll-snap verticale; tap sulla copertina
  apre il dialog album. Cache collezione: chiave v2 (campo fmt).
