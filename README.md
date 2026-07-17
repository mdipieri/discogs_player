# 🎵 Vinyl Streamer

Sfoglia la tua collezione di vinili [Discogs](https://www.discogs.com/user/dipdkg/collection) e ascoltala in streaming su **Spotify**, **Amazon Music** o **YouTube Music** — anche dal telefono o in auto.

## Come funziona

- L'app legge la tua collezione pubblica dall'API di Discogs (utente predefinito: `dipdkg`) e la mostra come una griglia di copertine.
- Puoi cercare, filtrare per genere, ordinare, o farti proporre un **album a caso** (🎲).
- Toccando un album si apre la scheda con i pulsanti **Ascolta su Spotify / Amazon Music / YouTube Music**: sul telefono si apre direttamente l'app di streaming con l'album già cercato. Da lì la riproduzione funziona normalmente anche con **Android Auto / Apple CarPlay**.
- La collezione viene salvata in cache nel browser (24h), quindi l'app si apre all'istante; il pulsante ⟳ forza l'aggiornamento da Discogs.

È un sito completamente statico: niente server, niente database, nessuna chiave obbligatoria.

## Messa online (GitHub Pages)

1. Fai il merge di questo branch su `main`.
2. Su GitHub vai in **Settings → Pages** e imposta **Source: GitHub Actions**.
3. Al push successivo su `main` il workflow pubblica il sito su:
   **https://mdipieri.github.io/discogs_player/**

## Uso su telefono e in auto

1. Apri l'URL dal telefono.
2. **Aggiungi alla schermata Home** (Chrome: menu ⋮ → "Aggiungi a schermata Home"; Safari: Condividi → "Aggiungi a Home"): l'app si installa come PWA a schermo intero.
3. In auto: scegli l'album dal telefono, tocca "Ascolta su Spotify" (o Amazon Music), e la musica passa da CarPlay/Android Auto come qualsiasi riproduzione dell'app di streaming.

## Impostazioni (⚙)

- **Utente Discogs** — di default `dipdkg`; puoi cambiarlo per vedere altre collezioni pubbliche.
- **Token Discogs** (opzionale) — senza token Discogs limita a ~25 richieste/minuto, quindi il primo caricamento di una collezione grande è lento. Con un [token personale](https://www.discogs.com/settings/developers) il caricamento è molto più veloce. Il token resta solo nel `localStorage` del tuo browser.

## Sviluppo locale

Basta un server statico:

```bash
python3 -m http.server 8000
# poi apri http://localhost:8000
```

## Struttura

```
index.html            # UI (griglia, dettaglio album, impostazioni)
css/style.css         # tema scuro, responsive
js/app.js             # fetch collezione Discogs, cache, ricerca/filtri, deep link streaming
sw.js                 # service worker (PWA / offline shell)
manifest.webmanifest  # manifest PWA
icons/                # icone SVG
.github/workflows/    # deploy automatico su GitHub Pages
```
