/* Vinyl Streamer — sfoglia la collezione Discogs e ascoltala in streaming. */
(() => {
  "use strict";

  const DEFAULT_USERNAME = "dipdkg";
  const CACHE_KEY = "vinyl-streamer:collection";
  const SETTINGS_KEY = "vinyl-streamer:settings";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h, poi si ricarica da Discogs
  const PER_PAGE = 100;

  const $ = (sel) => document.querySelector(sel);
  const els = {
    grid: $("#grid"),
    status: $("#status"),
    statusText: $("#status-text"),
    progressBar: $("#progress-bar"),
    error: $("#error"),
    count: $("#count"),
    search: $("#search"),
    genreFilter: $("#genre-filter"),
    sort: $("#sort"),
    albumDialog: $("#album-dialog"),
    settingsDialog: $("#settings-dialog"),
  };

  let collection = [];

  /* ---------- Impostazioni ---------- */

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const s = raw ? JSON.parse(raw) : {};
      return { username: s.username || DEFAULT_USERNAME, token: s.token || "" };
    } catch {
      return { username: DEFAULT_USERNAME, token: "" };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  /* ---------- Discogs API ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Discogs disambigua gli artisti omonimi con un suffisso "(2)" da togliere.
  function cleanArtist(name) {
    return name.replace(/\s+\(\d+\)$/, "");
  }

  function simplifyRelease(r) {
    const b = r.basic_information || {};
    const artists = (b.artists || []).map((a) => cleanArtist(a.name));
    return {
      id: b.id || r.id,
      title: b.title || "",
      artist: artists.join(", ") || "Sconosciuto",
      year: b.year || 0,
      thumb: b.thumb || "",
      cover: b.cover_image || b.thumb || "",
      genres: b.genres || [],
      styles: b.styles || [],
      format: (b.formats && b.formats[0] && b.formats[0].name) || "",
      added: r.date_added || "",
    };
  }

  async function fetchCollection(username, token, onProgress) {
    const releases = [];
    let page = 1;
    let pages = 1;
    let attempts = 0;

    while (page <= pages) {
      const url =
        `https://api.discogs.com/users/${encodeURIComponent(username)}` +
        `/collection/folders/0/releases?per_page=${PER_PAGE}&page=${page}` +
        (token ? `&token=${encodeURIComponent(token)}` : "");

      const res = await fetch(url, { headers: { Accept: "application/json" } });

      if (res.status === 429) {
        // Rate limit Discogs: aspetta e riprova la stessa pagina.
        attempts++;
        if (attempts > 5) throw new Error("Discogs sta limitando le richieste. Riprova tra un minuto, o aggiungi un token nelle impostazioni.");
        onProgress(page, pages, true);
        await sleep(6000 * attempts);
        continue;
      }
      if (res.status === 404) throw new Error(`Utente Discogs "${username}" non trovato.`);
      if (res.status === 403 || res.status === 401) {
        throw new Error(
          `La collezione di "${username}" non è pubblica. Rendila visibile nelle impostazioni privacy di Discogs, oppure inserisci il tuo token personale nelle impostazioni (⚙).`
        );
      }
      if (!res.ok) throw new Error(`Errore Discogs (HTTP ${res.status}). Riprova più tardi.`);

      attempts = 0;
      const data = await res.json();
      pages = (data.pagination && data.pagination.pages) || 1;
      releases.push(...(data.releases || []).map(simplifyRelease));
      onProgress(page, pages, false);
      page++;

      // Senza token il limite è ~25 richieste/min: distanzia le chiamate.
      if (page <= pages) await sleep(token ? 400 : 2600);
    }

    return releases;
  }

  /* ---------- Cache ---------- */

  function loadCache(username) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (cached.username !== username) return null;
      return cached;
    } catch {
      return null;
    }
  }

  function saveCache(username, releases) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ username, when: Date.now(), releases }));
    } catch {
      /* quota piena: pazienza, si rifarà il fetch */
    }
  }

  /* ---------- Rendering ---------- */

  function showStatus(text) {
    els.status.hidden = false;
    els.statusText.textContent = text;
  }

  function hideStatus() {
    els.status.hidden = true;
  }

  function showError(msg) {
    els.error.hidden = false;
    els.error.textContent = msg;
  }

  function currentView() {
    const q = els.search.value.trim().toLowerCase();
    const genre = els.genreFilter.value;
    const sort = els.sort.value;

    let view = collection.filter((r) => {
      if (genre && !r.genres.includes(genre)) return false;
      if (q && !(`${r.artist} ${r.title}`.toLowerCase().includes(q))) return false;
      return true;
    });

    const byText = (key) => (a, b) => a[key].localeCompare(b[key], "it", { sensitivity: "base" });
    switch (sort) {
      case "artist": view.sort(byText("artist")); break;
      case "title": view.sort(byText("title")); break;
      case "year": view.sort((a, b) => a.year - b.year); break;
      case "year-desc": view.sort((a, b) => b.year - a.year); break;
      default: view.sort((a, b) => (b.added || "").localeCompare(a.added || ""));
    }
    return view;
  }

  function render() {
    const view = currentView();

    els.count.hidden = false;
    els.count.textContent =
      view.length === collection.length
        ? `${collection.length} dischi in collezione`
        : `${view.length} di ${collection.length} dischi`;

    els.grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const r of view) {
      const card = document.createElement("button");
      card.className = "card";
      card.type = "button";

      const img = document.createElement("img");
      img.className = "card-cover";
      img.loading = "lazy";
      img.alt = "";
      img.src = r.thumb || r.cover;

      const body = document.createElement("div");
      body.className = "card-body";
      const title = document.createElement("p");
      title.className = "card-title";
      title.textContent = r.title;
      const artist = document.createElement("p");
      artist.className = "card-artist";
      artist.textContent = r.artist;
      body.append(title, artist);

      card.append(img, body);
      card.addEventListener("click", () => openAlbum(r));
      frag.append(card);
    }
    els.grid.append(frag);
  }

  function populateGenres() {
    const genres = [...new Set(collection.flatMap((r) => r.genres))].sort();
    const current = els.genreFilter.value;
    els.genreFilter.innerHTML = '<option value="">Tutti i generi</option>';
    for (const g of genres) {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      els.genreFilter.append(opt);
    }
    els.genreFilter.value = genres.includes(current) ? current : "";
  }

  /* ---------- Dettaglio album ---------- */

  function openAlbum(r) {
    $("#detail-cover").src = r.cover || r.thumb;
    $("#detail-title").textContent = r.title;
    $("#detail-artist").textContent = r.artist;

    const metaParts = [];
    if (r.year) metaParts.push(r.year);
    if (r.format) metaParts.push(r.format);
    if (r.genres.length) metaParts.push(r.genres.join(", "));
    if (r.styles.length) metaParts.push(r.styles.join(", "));
    $("#detail-meta").textContent = metaParts.join(" · ");

    // "Various" nella query confonde la ricerca: per le compilation usa solo il titolo.
    const query = r.artist === "Various" ? r.title : `${r.artist} ${r.title}`;
    const q = encodeURIComponent(query);
    $("#link-spotify").href = `https://open.spotify.com/search/${q}`;
    $("#link-amazon").href = `https://music.amazon.com/search/${q}`;
    $("#link-ytmusic").href = `https://music.youtube.com/search?q=${q}`;
    $("#link-discogs").href = `https://www.discogs.com/release/${r.id}`;

    els.albumDialog.showModal();
  }

  /* ---------- Caricamento ---------- */

  async function loadCollection({ force = false } = {}) {
    const { username, token } = loadSettings();
    els.error.hidden = true;

    const cached = loadCache(username);
    if (cached && !force) {
      collection = cached.releases;
      populateGenres();
      render();
      hideStatus();
      // Cache vecchia: aggiorna in background senza bloccare la UI.
      if (Date.now() - cached.when > CACHE_TTL_MS) refreshInBackground(username, token);
      return;
    }

    els.grid.innerHTML = "";
    els.count.hidden = true;
    showStatus(`Carico la collezione di ${username} da Discogs…`);
    els.progressBar.style.width = "0%";

    try {
      const releases = await fetchCollection(username, token, (page, pages, throttled) => {
        els.progressBar.style.width = `${Math.round((page / pages) * 100)}%`;
        els.statusText.textContent = throttled
          ? "Discogs limita le richieste, attendo un attimo…"
          : `Carico la collezione… pagina ${page} di ${pages}`;
      });
      collection = releases;
      saveCache(username, releases);
      populateGenres();
      render();
    } catch (err) {
      showError(err.message || String(err));
      // Se c'è una cache anche vecchia, meglio di niente.
      if (cached) {
        collection = cached.releases;
        populateGenres();
        render();
      }
    } finally {
      hideStatus();
    }
  }

  async function refreshInBackground(username, token) {
    try {
      const releases = await fetchCollection(username, token, () => {});
      collection = releases;
      saveCache(username, releases);
      populateGenres();
      render();
    } catch {
      /* la cache resta valida */
    }
  }

  /* ---------- Eventi ---------- */

  els.search.addEventListener("input", render);
  els.genreFilter.addEventListener("change", render);
  els.sort.addEventListener("change", render);

  $("#btn-refresh").addEventListener("click", () => loadCollection({ force: true }));

  $("#btn-random").addEventListener("click", () => {
    const view = currentView();
    if (view.length) openAlbum(view[Math.floor(Math.random() * view.length)]);
  });

  $("#btn-settings").addEventListener("click", () => {
    const { username, token } = loadSettings();
    $("#setting-username").value = username;
    $("#setting-token").value = token;
    els.settingsDialog.showModal();
  });

  $("#settings-form").addEventListener("submit", () => {
    saveSettings({
      username: $("#setting-username").value.trim() || DEFAULT_USERNAME,
      token: $("#setting-token").value.trim(),
    });
    els.settingsDialog.close();
    loadCollection({ force: true });
  });

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
    // Chiudi toccando fuori dal riquadro.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
  });

  /* ---------- Service worker (PWA) ---------- */

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  loadCollection();
})();
