// ── Polyfill API browser/chrome ───────────────────────────────
const browserAPI = typeof browser !== "undefined" ? browser : chrome;
document.getElementById('ext-version').textContent =
  'version ' + chrome.runtime.getManifest().version;

// ── Traductions ───────────────────────────────────────────────
const I18N = {
  fr: {
    apiKeyLabel:      "Clé API start.gg",
    apiKeyPlaceholder:"Colle ta clé ici…",
    apiKeyHint:       `Génère un token sur <a href="https://developer.start.gg/docs/authentication" target="_blank">developer.start.gg</a> → Developer Settings`,
    save:             "💾 Sauvegarder",
    clear:            "🗑 Effacer",
    eventsLabel:      "Events à surveiller",
    checkAll:         "Tout cocher",
    uncheckAll:       "Tout décocher",
    noEvents:         "Clique sur le bouton Tracker dans la page pour charger les events.",
    apply:            "✅ Appliquer le filtre",
    footer:           "",
    statusSaved:      "✅ Clé sauvegardée !",
    statusEmpty:      "⚠️ La clé est vide !",
    statusCleared:    "🗑 Clé supprimée",
    statusApplied:    "✅ Filtre appliqué !",
    trackerBtn:       "Lancer le Tracker",
    trackerLoading:   "Chargement…",
    trackerFromCache: "Réinjection cache…",
    trackerDone:      "Chargé ✓",
    trackerError:     "Erreur",
    trackerCooldown:  "Patiente…",
    trackerNoKey:     "⚠️ Clé API manquante",
    exportBtn:        "⬇ Exporter CSV",
    exportLoading:    "Export en cours…",
    exportDone:       "✅ Téléchargé !",
    exportNoData:     "⚠ Lance le tracker d'abord",
  },
  en: {
    apiKeyLabel:      "start.gg API key",
    apiKeyPlaceholder:"Paste your key here…",
    apiKeyHint:       `Generate a token at <a href="https://developer.start.gg/docs/authentication" target="_blank">developer.start.gg</a> → Developer Settings`,
    save:             "💾 Save",
    clear:            "🗑 Clear",
    eventsLabel:      "Events to track",
    checkAll:         "Check all",
    uncheckAll:       "Uncheck all",
    noEvents:         "Click the Tracker button on the page to load events.",
    apply:            "✅ Apply filter",
    footer:           "",
    statusSaved:      "✅ Key saved!",
    statusEmpty:      "⚠️ Key is empty!",
    statusCleared:    "🗑 Key cleared",
    statusApplied:    "✅ Filter applied!",
    trackerBtn:       "Launch Tracker",
    trackerLoading:   "Loading…",
    trackerFromCache: "Loading from cache…",
    trackerDone:      "Loaded ✓",
    trackerError:     "Error",
    trackerCooldown:  "Please wait…",
    trackerNoKey:     "⚠️ API key missing",
    exportBtn:        "⬇ Export CSV",
    exportLoading:    "Exporting…",
    exportDone:       "✅ Downloaded!",
    exportNoData:     "⚠ Run the tracker first",
  },
};

// ── État langue ───────────────────────────────────────────────
let currentLang = "fr";

function t(key) { return I18N[currentLang][key] ?? I18N.fr[key] ?? key; }

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml;
    el.textContent = "";
    if (key === "apiKeyHint") {
      const pre  = currentLang === "fr" ? "Génère un token sur " : "Generate a token at ";
      const post = " → Developer Settings";
      const a = document.createElement("a");
      a.href = "https://developer.start.gg/docs/authentication";
      a.target = "_blank";
      a.textContent = "developer.start.gg";
      el.appendChild(document.createTextNode(pre));
      el.appendChild(a);
      el.appendChild(document.createTextNode(post));
    } else {
      el.textContent = t(key);
    }
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  updateToggleAllLabel();
}

// ── Storage ───────────────────────────────────────────────────
function storageGet(keys) {
  return browserAPI.storage.local.get(keys);
}

// ── UI refs ───────────────────────────────────────────────────
const apiKeyInput   = document.getElementById("apiKey");
const btnSave       = document.getElementById("btnSave");
const btnClear      = document.getElementById("btnClear");
const status        = document.getElementById("status");
const eventsSection = document.getElementById("eventsSection");
const eventsList    = document.getElementById("eventsList");
const noEvents      = document.getElementById("noEvents");
const toggleAllBtn  = document.getElementById("toggleAll");
const applyBtn      = document.getElementById("applyBtn");
const btnFr         = document.getElementById("btnFr");
const btnEn         = document.getElementById("btnEn");

// ── Status helper ─────────────────────────────────────────────
function setStatus(key, type) {
  status.textContent = t(key);
  status.className = type === "ok" ? "ok" : "err";
  setTimeout(() => { status.textContent = ""; status.className = ""; }, 2500);
}

// ── Langue ────────────────────────────────────────────────────
function setLang(lang) {
  currentLang = lang;
  btnFr.classList.toggle("active", lang === "fr");
  btnEn.classList.toggle("active", lang === "en");
  applyTranslations();
  browserAPI.storage.local.set({ lang });
}

btnFr.addEventListener("click", () => setLang("fr"));
btnEn.addEventListener("click", () => setLang("en"));

// ── Clé API ───────────────────────────────────────────────────
btnSave.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setStatus("statusEmpty", "err"); return; }
  await browserAPI.storage.local.set({ apiKey: key });
  setStatus("statusSaved", "ok");
});

btnClear.addEventListener("click", async () => {
  await browserAPI.storage.local.remove("apiKey");
  apiKeyInput.value = "";
  setStatus("statusCleared", "ok");
});

apiKeyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") btnSave.click(); });

// ── Filtre events ─────────────────────────────────────────────
async function loadEventsList() {
  let tournamentSlug = null;
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const response = await browserAPI.tabs.sendMessage(tab.id, { type: "GET_TOURNAMENT_SLUG" }).catch(() => null);
      tournamentSlug = response?.slug || null;
    }
  } catch (_) {}

  if (!tournamentSlug) {
    const s = await storageGet(["lastTournamentSlug"]);
    tournamentSlug = s.lastTournamentSlug || null;
  }

  if (!tournamentSlug) {
    eventsSection.style.display = "block";
    noEvents.style.display = "block";
    eventsList.style.display = "none";
    applyBtn.style.display = "none";
    return;
  }

  const result = await storageGet([`events_${tournamentSlug}`, "enabledEventIds"]);
  const events = result[`events_${tournamentSlug}`];
  const { enabledEventIds } = result;

  if (!events?.length) {
    eventsSection.style.display = "block";
    noEvents.style.display = "block";
    eventsList.style.display = "none";
    applyBtn.style.display = "none";
    return;
  }

  eventsSection.style.display = "block";
  noEvents.style.display = "none";
  eventsList.style.display = "flex";
  applyBtn.style.display = "block";

  const activeSet = enabledEventIds
    ? new Set(enabledEventIds)
    : new Set(events.map((e) => e.id));

  eventsList.innerHTML = "";

  events.forEach((event) => {
    const isActive = activeSet.has(event.id);
    const row = document.createElement("label");
    row.className = "event-row" + (isActive ? " active" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isActive;
    cb.dataset.eventId = event.id;
    cb.addEventListener("change", () => {
      row.classList.toggle("active", cb.checked);
      updateToggleAllLabel();
    });

    let imgEl;
    if (event.gameImageUrl) {
      imgEl = document.createElement("img");
      imgEl.src = event.gameImageUrl;
      imgEl.alt = event.gameName || "";
      imgEl.className = "event-game-img";
    } else {
      imgEl = document.createElement("div");
      imgEl.className = "event-game-placeholder";
      imgEl.textContent = "🎮";
    }

    const info = document.createElement("div");
    info.className = "event-info";
    const name = document.createElement("div");
    name.className = "event-name";
    name.textContent = event.name;
    info.appendChild(name);
    if (event.gameName) {
      const game = document.createElement("div");
      game.className = "event-game";
      game.textContent = event.gameName;
      info.appendChild(game);
    }

    row.appendChild(cb);
    row.appendChild(imgEl);
    row.appendChild(info);
    eventsList.appendChild(row);
  });

  updateToggleAllLabel();
}

function updateToggleAllLabel() {
  const boxes = eventsList.querySelectorAll("input[type='checkbox']");
  const allChecked = boxes.length > 0 && [...boxes].every((b) => b.checked);
  toggleAllBtn.textContent = allChecked ? t("uncheckAll") : t("checkAll");
}

toggleAllBtn.addEventListener("click", () => {
  const boxes = eventsList.querySelectorAll("input[type='checkbox']");
  const allChecked = [...boxes].every((b) => b.checked);
  boxes.forEach((b) => {
    b.checked = !allChecked;
    b.closest(".event-row").classList.toggle("active", !allChecked);
  });
  updateToggleAllLabel();
});

applyBtn.addEventListener("click", async () => {
  const boxes = eventsList.querySelectorAll("input[type='checkbox']");
  const enabledEventIds = [...boxes].filter((b) => b.checked).map((b) => b.dataset.eventId);
  await browserAPI.storage.local.set({ enabledEventIds });
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) browserAPI.tabs.sendMessage(tab.id, { type: "REFRESH_ICONS" });
  setStatus("statusApplied", "ok");
});

// ── Tracker button ───────────────────────────────────────────
const trackerSection  = document.getElementById("trackerSection");
const trackerBtn      = document.getElementById("trackerBtn");
const trackerBtnLabel = document.getElementById("trackerBtnLabel");
const trackerStatus   = document.getElementById("trackerStatus");
const exportBtn       = document.getElementById("exportBtn");

let trackerLastRunAt = 0;
const TRACKER_COOLDOWN_MS = 5000;

function setTrackerState(state) {
  trackerBtn.classList.remove("sgg-loading-state", "sgg-done-state", "sgg-error-state", "sgg-cooldown-state");
  trackerStatus.textContent = "";

  if (state === "loading") {
    trackerBtn.classList.add("sgg-loading-state");
    trackerBtnLabel.textContent = t("trackerLoading");
    exportBtn.disabled = true;
    exportBtn.title = t("exportBtn");
    browserAPI.storage.local.remove("trackerDone");
  } else if (state === "done") {
    trackerBtn.classList.add("sgg-done-state");
    trackerBtnLabel.textContent = t("trackerDone");
    exportBtn.disabled = false;
    exportBtn.title = t("exportBtn");
    browserAPI.storage.local.set({ trackerDone: true });
    setTimeout(() => {
      trackerBtn.classList.remove("sgg-done-state");
      trackerBtnLabel.textContent = t("trackerBtn");
    }, 3000);
  } else if (state === "error") {
    trackerBtn.classList.add("sgg-error-state");
    trackerBtnLabel.textContent = t("trackerError");
    setTimeout(() => {
      trackerBtn.classList.remove("sgg-error-state");
      trackerBtnLabel.textContent = t("trackerBtn");
    }, 4000);
  } else if (state === "cooldown") {
    trackerBtn.classList.add("sgg-cooldown-state");
    setTimeout(() => {
      trackerBtn.classList.remove("sgg-cooldown-state");
      trackerBtnLabel.textContent = t("trackerBtn");
    }, 1500);
  } else {
    trackerBtnLabel.textContent = t("trackerBtn");
  }
}

// Écoute les messages de progression venant du content script
browserAPI.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRACKER_STATE") {
    if (msg.state === "loading") {
      setTrackerState("loading");
      if (msg.text) trackerBtnLabel.textContent = msg.text;
    } else {
      setTrackerState(msg.state);
    }
  }
});

trackerBtn.addEventListener("click", async () => {
  if (trackerBtn.classList.contains("sgg-loading-state")) return;

  const elapsed = Date.now() - trackerLastRunAt;
  if (trackerLastRunAt > 0 && elapsed < TRACKER_COOLDOWN_MS) {
    const remaining = Math.ceil((TRACKER_COOLDOWN_MS - elapsed) / 1000);
    trackerBtnLabel.textContent = `${t("trackerCooldown")} (${remaining}s)`;
    setTrackerState("cooldown");
    return;
  }

  const { apiKey } = await storageGet(["apiKey"]);
  if (!apiKey) {
    trackerStatus.textContent = t("trackerNoKey");
    trackerStatus.style.color = "var(--accent)";
    return;
  }

  setTrackerState("loading");
  trackerBtnLabel.textContent = t("trackerFromCache");
  trackerLastRunAt = Date.now();

  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // ── Étape 1 : tenter la réinjection depuis le cache ──────────
  const cached = await browserAPI.tabs.sendMessage(tab.id, { type: "REINJECT" }).catch(() => null);

  if (cached?.ok) {
    // Cache disponible et icônes injectées — on s'arrête là
    return;
  }

  // ── Étape 2 : pas de cache → appel API complet ───────────────
  trackerBtnLabel.textContent = t("trackerLoading");
  browserAPI.tabs.sendMessage(tab.id, { type: "REFRESH_ICONS" });
});

exportBtn.addEventListener("click", async () => {
  if (exportBtn.disabled) return;
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  exportBtn.disabled = true;
  exportBtn.title = t("exportLoading");

  const response = await browserAPI.tabs.sendMessage(tab.id, { type: "EXPORT_CSV" }).catch(() => null);

  if (response?.ok) {
    exportBtn.classList.add("sgg-export-done");
    exportBtn.title = t("exportDone");
    setTimeout(() => {
      exportBtn.classList.remove("sgg-export-done");
      exportBtn.title = t("exportBtn");
      exportBtn.disabled = false;
    }, 2000);
  } else {
    exportBtn.classList.add("sgg-export-error");
    exportBtn.title = t("exportNoData");
    exportBtn.disabled = false;
    setTimeout(() => {
      exportBtn.classList.remove("sgg-export-error");
      exportBtn.title = t("exportBtn");
    }, 2500);
  }
});

async function loadTrackerSection() {
  let tournamentSlug = null;
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const response = await browserAPI.tabs.sendMessage(tab.id, { type: "GET_TOURNAMENT_SLUG" }).catch(() => null);
      tournamentSlug = response?.slug || null;
    }
  } catch (_) {}
  if (!tournamentSlug) {
    const s = await storageGet(["lastTournamentSlug"]);
    tournamentSlug = s.lastTournamentSlug || null;
  }
  if (tournamentSlug) {
    trackerSection.style.display = "block";
  }
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const { apiKey, lang, trackerDone } = await storageGet(["apiKey", "lang", "trackerDone"]);
  if (apiKey) apiKeyInput.value = apiKey;

  const savedLang = lang === "en" ? "en" : "fr";
  btnFr.classList.toggle("active", savedLang === "fr");
  btnEn.classList.toggle("active", savedLang === "en");
  currentLang = savedLang;
  applyTranslations();

  if (trackerDone) {
    exportBtn.disabled = false;
    exportBtn.title = t("exportBtn");
  }

  await loadEventsList();
  await loadTrackerSection();
}

init();
