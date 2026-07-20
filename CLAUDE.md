# Vinyl Streamer — note per Claude

## Principi di design

- **Tutto il design è ottimizzato per mobile** (uso da telefono, anche in auto):
  target primario ~390-430px di larghezza, gesture touch, PWA installata.
  Il desktop è secondario (fallback tastiera/rotellina dove servono gesture).
- La **vista predefinita è "sfoglia come vinili"** (crate digging): copertina
  più grande possibile, pila di copertine che si intravede sotto, info in basso.
  Gesture: swipe **giù** = disco successivo (come sfogliare una cassa),
  swipe **su** = precedente, swipe **destra** = sfila il vinile e apre la
  scheda streaming. La griglia resta disponibile col toggle ▦/🎴.
- L'app deve simulare la fisicità dei dischi e della collezione.

## Architettura

- Sito statico senza build (index.html + css/ + js/), PWA, deploy su GitHub
  Pages via Actions. L'ambiente github-pages accetta deploy solo dal branch
  predefinito (`claude/vinyl-collection-streaming-oosmze`); `main` va tenuto
  allineato con fast-forward ma non triggera il deploy.
- Collezione: API pubblica Discogs (utente `dipdkg`), cache in localStorage.
- `mappings.json`: release Discogs → ID album Spotify / ASIN Amazon, generato
  da `scripts/build-mappings.mjs` (workflow `mappings.yml`, lunedì + manuale).
  Odesli non fornisce più link Spotify: quella colonna si popola solo con i
  secrets `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` (API ufficiale). Attenzione:
  la Search API di Spotify con client credentials richiede che il proprietario
  dell'app abbia un abbonamento **Premium** attivo, altrimenti risponde 403
  ("Active premium subscription required for the owner of the app") e la colonna
  Spotify resta vuota.
- Verifica: skill di progetto `.claude/skills/verify/SKILL.md` (Playwright con
  API mockate; la sandbox non raggiunge Discogs/iTunes/Deezer/Odesli).
