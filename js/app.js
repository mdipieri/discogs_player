/* Vinyl Streamer — sfoglia la collezione Discogs e ascoltala in streaming. */
(() => {
  "use strict";

  const DEFAULT_USERNAME = "dipdkg";
  const CACHE_KEY = "vinyl-streamer:collection:v3"; // v3: aggiunte le note di collezione
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
    formatFilter: $("#format-filter"),
    sort: $("#sort"),
    albumDialog: $("#album-dialog"),
    settingsDialog: $("#settings-dialog"),
  };

  let collection = [];
  let mappings = {};

  // Vista predefinita: crate (sfoglia come vinili); la griglia resta col toggle.
  const VIEW_KEY = "vinyl-streamer:view";
  let viewMode = localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "crate";
  let crateItems = [];
  let crateIndex = 0;

  async function loadMappings() {
    try {
      const res = await fetch("mappings.json", { cache: "no-cache" });
      if (res.ok) mappings = await res.json();
    } catch {
      /* senza mappa restano i link di ricerca */
    }
  }

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

  // Classifica il formato fisico dalle descrizioni Discogs (es. ["12\"", "Single"]).
  function classifyFormat(formats) {
    const desc = (formats || []).flatMap((f) => [f.name, ...(f.descriptions || [])]).join(" ");
    if (desc.includes('7"')) return '7"';
    if (desc.includes('12"') || desc.includes("Maxi")) return '12"';
    if (/\bLP\b|Album/.test(desc)) return "LP";
    return "Altro";
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
      fmt: classifyFormat(b.formats),
      added: r.date_added || "",
      // Note di collezione (es. dove comprato, prezzo). Visibili solo se
      // pubbliche nelle impostazioni privacy di Discogs.
      notes: (r.notes || []).map((n) => n.value).filter(Boolean).join(" · "),
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
    const fmt = els.formatFilter.value;
    const sort = els.sort.value;

    let view = collection.filter((r) => {
      if (genre && !r.genres.includes(genre)) return false;
      if (fmt && r.fmt !== fmt) return false;
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
    const showingCrate = viewMode === "crate";

    $("#crate-view").hidden = !showingCrate;
    els.grid.hidden = showingCrate;
    els.count.hidden = showingCrate;

    if (showingCrate) {
      crateItems = view;
      if (crateIndex > view.length - 1) crateIndex = 0;
      renderDeck();
      return;
    }

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

    const notesEl = $("#detail-notes");
    notesEl.hidden = !r.notes;
    notesEl.textContent = r.notes || "";

    // "Various" nella query confonde la ricerca: per le compilation usa solo il titolo.
    const query = r.artist === "Various" ? r.title : `${r.artist} ${r.title}`;
    const q = encodeURIComponent(query);
    // Con un ID mappato si apre direttamente l'album ("Ascolta su...");
    // senza, parte la ricerca ("Cerca su...").
    const map = mappings[String(r.id)] || {};
    $("#link-spotify").href = map.spotify
      ? `https://open.spotify.com/album/${map.spotify}`
      : `https://open.spotify.com/search/${q}`;
    $("#spotify-label").textContent = map.spotify ? "Ascolta su Spotify" : "Cerca su Spotify";
    $("#link-amazon").href = map.amazon
      ? `https://music.amazon.com/albums/${map.amazon}`
      : `https://music.amazon.com/search/${q}`;
    $("#amazon-label").textContent = map.amazon ? "Ascolta su Amazon Music" : "Cerca su Amazon Music";
    $("#link-ytmusic").href = `https://music.youtube.com/search?q=${q}`;
    $("#link-discogs").href = `https://www.discogs.com/release/${r.id}`;

    els.albumDialog.showModal();
  }

  /* ---------- Vista crate (default): sfoglia come vinili ---------- */

  const deck = $("#deck");

  // Slot k = posizione nella pila: 0 in cima, 1 e 2 spuntano da sotto.
  function slotTransform(k) {
    return `translate(-50%, -50%) translateY(${k * 20}px) scale(${1 - k * 0.05})`;
  }

  function applySlot(card, k) {
    card.style.transform = slotTransform(Math.max(0, k));
    card.style.opacity = k > 2.2 ? "0" : "1";
  }

  function updateCrateInfo() {
    const r = crateItems[crateIndex];
    if (!r) {
      $("#crate-title").textContent = "Nessun disco";
      $("#crate-artist").textContent = "";
      $("#crate-meta").textContent = "Prova a cambiare filtri o ricerca";
      return;
    }
    $("#crate-title").textContent = r.title;
    $("#crate-artist").textContent = r.artist;
    $("#crate-meta").textContent = [r.year || null, r.fmt, `${crateIndex + 1} / ${crateItems.length}`]
      .filter(Boolean)
      .join(" · ");
  }

  function renderDeck() {
    deck.innerHTML = "";
    for (let k = Math.min(2, crateItems.length - 1 - crateIndex); k >= 0; k--) {
      const r = crateItems[crateIndex + k];
      const card = document.createElement("div");
      card.className = "deck-card";
      card.dataset.k = k;
      card.style.zIndex = String(10 - k);

      const vinyl = document.createElement("div");
      vinyl.className = "deck-vinyl";
      const img = document.createElement("img");
      img.className = "deck-cover";
      img.src = r.cover || r.thumb;
      img.alt = "";
      img.draggable = false;

      card.append(vinyl, img);
      applySlot(card, k);
      deck.append(card);
    }
    updateCrateInfo();
  }

  function topCard() {
    return deck.querySelector('.deck-card[data-k="0"]');
  }

  function springBack() {
    const top = topCard();
    if (!top) return;
    top.style.transition = "transform 0.2s ease-out";
    applySlot(top, 0);
    const vinyl = top.querySelector(".deck-vinyl");
    vinyl.style.transition = "transform 0.2s ease-out";
    vinyl.style.transform = "";
    deck.querySelectorAll(".deck-card").forEach((c) => {
      const k = +c.dataset.k;
      if (k > 0) {
        c.style.transition = "transform 0.2s ease-out";
        applySlot(c, k);
      }
    });
  }

  function crateNext() {
    if (crateIndex >= crateItems.length - 1) {
      springBack();
      return;
    }
    const top = topCard();
    top.style.transition = "transform 0.22s ease-in";
    top.style.transform = "translate(-50%, 90vh) rotate(5deg)";
    deck.querySelectorAll(".deck-card").forEach((c) => {
      const k = +c.dataset.k;
      if (k > 0) {
        c.style.transition = "transform 0.22s ease-out";
        applySlot(c, k - 1);
      }
    });
    setTimeout(() => {
      crateIndex++;
      renderDeck();
    }, 220);
  }

  function cratePrev() {
    if (crateIndex <= 0) {
      springBack();
      return;
    }
    crateIndex--;
    renderDeck();
    // Il disco precedente rientra dal basso, come rimetterlo nella cassa.
    const top = topCard();
    top.style.transition = "none";
    top.style.transform = "translate(-50%, 70vh) rotate(4deg)";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        top.style.transition = "transform 0.22s ease-out";
        applySlot(top, 0);
      })
    );
  }

  // Gesture: giù = disco successivo, su = precedente,
  // destra = sfila il vinile e apre la scheda streaming.
  let drag = null;

  deck.addEventListener("pointerdown", (e) => {
    if (!crateItems.length) return;
    drag = { x: e.clientX, y: e.clientY, axis: null, dx: 0, dy: 0 };
    deck.setPointerCapture(e.pointerId);
  });

  deck.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 10) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    const top = topCard();
    if (!top) return;

    if (drag.axis === "y") {
      drag.dy = dy;
      const capped = dy < 0 ? Math.max(dy, -120) * 0.45 : dy;
      top.style.transition = "none";
      top.style.transform = `translate(-50%, calc(-50% + ${capped}px)) rotate(${capped / 45}deg)`;
      const p = Math.min(1, Math.max(0, dy / 240));
      deck.querySelectorAll(".deck-card").forEach((c) => {
        const k = +c.dataset.k;
        if (k > 0) {
          c.style.transition = "none";
          applySlot(c, k - p);
        }
      });
    } else {
      drag.dx = dx;
      const vinyl = top.querySelector(".deck-vinyl");
      const capped = dx < 0 ? Math.max(dx, -60) * 0.4 : Math.min(dx, 300);
      vinyl.style.transition = "none";
      vinyl.style.transform = `translateX(${capped}px)`;
    }
  });

  function endDrag() {
    if (!drag) return;
    const { axis, dx, dy } = drag;
    drag = null;
    if (axis === "y") {
      if (dy > 90) crateNext();
      else if (dy < -70) cratePrev();
      else springBack();
    } else if (axis === "x") {
      if (dx > 100 && crateItems[crateIndex]) openAlbum(crateItems[crateIndex]);
      springBack();
    }
  }

  deck.addEventListener("pointerup", endDrag);
  deck.addEventListener("pointercancel", endDrag);

  // Desktop: rotellina e frecce.
  let wheelLock = 0;
  deck.addEventListener("wheel", (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLock < 350) return;
    wheelLock = now;
    if (e.deltaY > 0) crateNext();
    else cratePrev();
  }, { passive: false });

  document.addEventListener("keydown", (e) => {
    if (viewMode !== "crate" || els.albumDialog.open || els.settingsDialog.open) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowDown") crateNext();
    else if (e.key === "ArrowUp") cratePrev();
    else if (e.key === "ArrowRight" && crateItems[crateIndex]) openAlbum(crateItems[crateIndex]);
  });

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

  function refreshFromFilters() {
    crateIndex = 0; // nuova selezione: si riparte dalla cima della cassa
    render();
  }

  els.search.addEventListener("input", refreshFromFilters);
  els.genreFilter.addEventListener("change", refreshFromFilters);
  els.formatFilter.addEventListener("change", refreshFromFilters);
  els.sort.addEventListener("change", refreshFromFilters);

  function updateViewButton() {
    const btn = $("#btn-view");
    btn.textContent = viewMode === "crate" ? "▦" : "🎴";
    btn.title = viewMode === "crate" ? "Vista griglia" : "Sfoglia come vinili";
  }

  $("#btn-view").addEventListener("click", () => {
    viewMode = viewMode === "crate" ? "grid" : "crate";
    localStorage.setItem(VIEW_KEY, viewMode);
    updateViewButton();
    render();
  });
  updateViewButton();

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

  loadMappings();
  loadCollection();
})();
