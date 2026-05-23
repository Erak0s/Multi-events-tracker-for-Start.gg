// popup.js v3 — Clé API + filtre events + i18n FR/EN

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
    noEvents:         "Navigue vers un bracket pour voir les events.",
    apply:            "✅ Appliquer le filtre",
    footer:           "",
    statusSaved:      "✅ Clé sauvegardée !",
    statusEmpty:      "⚠️ La clé est vide !",
    statusCleared:    "🗑 Clé supprimée",
    statusApplied:    "✅ Filtre appliqué !",
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
    noEvents:         "Navigate to a bracket to see events.",
    apply:            "✅ Apply filter",
    footer:           "",
    statusSaved:      "✅ Key saved!",
    statusEmpty:      "⚠️ Key is empty!",
    statusCleared:    "🗑 Key cleared",
    statusApplied:    "✅ Filter applied!",
  },
};

// ── État langue ───────────────────────────────────────────────
let currentLang = "fr";

function t(key) { return I18N[currentLang][key] ?? I18N.fr[key] ?? key; }

function applyTranslations() {
  // Texte simple
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  // Liens dans les hints — construction DOM sécurisée (pas d'innerHTML)
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml;
    // Les hints contiennent un lien vers developer.start.gg — on le construit manuellement
    el.textContent = "";
    if (key === "apiKeyHint") {
      const pre  = currentLang === "fr" ? "Génère un token sur " : "Generate a token at ";
      const post = currentLang === "fr" ? " → Developer Settings" : " → Developer Settings";
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
  // Placeholder
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  // Bouton toggle-all (texte dynamique)
  updateToggleAllLabel();
}

// ── Storage ───────────────────────────────────────────────────
function storageGet(keys) {
  return new Promise((r) => chrome.storage.local.get(keys, r));
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
  chrome.storage.local.set({ lang });
}

btnFr.addEventListener("click", () => setLang("fr"));
btnEn.addEventListener("click", () => setLang("en"));

// ── Clé API ───────────────────────────────────────────────────
btnSave.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setStatus("statusEmpty", "err"); return; }
  chrome.storage.local.set({ apiKey: key }, () => setStatus("statusSaved", "ok"));
});

btnClear.addEventListener("click", () => {
  chrome.storage.local.remove("apiKey", () => {
    apiKeyInput.value = "";
    setStatus("statusCleared", "ok");
  });
});

apiKeyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") btnSave.click(); });

// ── Filtre events ─────────────────────────────────────────────
async function loadEventsList() {
  // Récupère le slug de la page active
  let tournamentSlug = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_TOURNAMENT_SLUG" }).catch(() => null);
      tournamentSlug = response?.slug || null;
    }
  } catch (_) {}

  // Fallback sur le dernier slug connu
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

  // Attend que les events soient disponibles (la map peut encore être en cours de build)
  let events = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await storageGet([`events_${tournamentSlug}`]);
    events = result[`events_${tournamentSlug}`];
    if (events?.length) break;
    await new Promise(r => setTimeout(r, 800)); // attend 800ms entre chaque essai
  }

  const { enabledEventIds } = await storageGet(["enabledEventIds"]);

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
  await new Promise((r) => chrome.storage.local.set({ enabledEventIds }, r));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "REFRESH_ICONS" });
  setStatus("statusApplied", "ok");
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const { apiKey, lang } = await storageGet(["apiKey", "lang"]);
  if (apiKey) apiKeyInput.value = apiKey;

  // Applique la langue sauvegardée (défaut : fr)
  const savedLang = lang === "en" ? "en" : "fr";
  btnFr.classList.toggle("active", savedLang === "fr");
  btnEn.classList.toggle("active", savedLang === "en");
  currentLang = savedLang;
  applyTranslations();

  await loadEventsList();
}

init();