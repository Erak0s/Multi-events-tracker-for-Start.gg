// popup.js v2 — Clé API + filtre par event

const apiKeyInput = document.getElementById("apiKey");
const btnSave     = document.getElementById("btnSave");
const btnClear    = document.getElementById("btnClear");
const status      = document.getElementById("status");
const eventsSection = document.getElementById("eventsSection");
const eventsList  = document.getElementById("eventsList");
const noEvents    = document.getElementById("noEvents");
const toggleAllBtn = document.getElementById("toggleAll");
const applyBtn    = document.getElementById("applyBtn");

// ── Utils ────────────────────────────────────────────────────
function setStatus(msg, type) {
  status.textContent = msg;
  status.className = type === "ok" ? "ok" : "err";
  setTimeout(() => { status.textContent = ""; status.className = ""; }, 2500);
}

function storageGet(keys) {
  return new Promise((r) => chrome.storage.local.get(keys, r));
}

// ── Clé API ──────────────────────────────────────────────────
storageGet(["apiKey"]).then(({ apiKey }) => {
  if (apiKey) apiKeyInput.value = apiKey;
});

btnSave.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setStatus("⚠️ La clé est vide !", "err"); return; }
  chrome.storage.local.set({ apiKey: key }, () => setStatus("✅ Clé sauvegardée !", "ok"));
});

btnClear.addEventListener("click", () => {
  chrome.storage.local.remove("apiKey", () => {
    apiKeyInput.value = "";
    setStatus("🗑 Clé supprimée", "ok");
  });
});

apiKeyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") btnSave.click(); });

// ── Filtre events ────────────────────────────────────────────
async function loadEventsList() {
  const { lastTournamentSlug, enabledEventIds } = await storageGet([
    "lastTournamentSlug",
    "enabledEventIds",
  ]);

  if (!lastTournamentSlug) {
    eventsSection.style.display = "block";
    noEvents.style.display = "block";
    eventsList.style.display = "none";
    applyBtn.style.display = "none";
    return;
  }

  const { [`events_${lastTournamentSlug}`]: events } = await storageGet([
    `events_${lastTournamentSlug}`,
  ]);

  if (!events || events.length === 0) {
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

  // enabledEventIds null = tous actifs par défaut
  const activeSet = enabledEventIds
    ? new Set(enabledEventIds)
    : new Set(events.map((e) => e.id));

  eventsList.innerHTML = "";

  events.forEach((event) => {
    const isActive = activeSet.has(event.id);

    const row = document.createElement("label");
    row.className = "event-row" + (isActive ? " active" : "");

    // Checkbox
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isActive;
    cb.dataset.eventId = event.id;

    cb.addEventListener("change", () => {
      row.classList.toggle("active", cb.checked);
      updateToggleAllLabel();
    });

    // Image du jeu
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

    // Infos texte
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
  const allChecked = [...boxes].every((b) => b.checked);
  toggleAllBtn.textContent = allChecked ? "Tout décocher" : "Tout cocher";
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
  const enabledEventIds = [...boxes]
    .filter((b) => b.checked)
    .map((b) => b.dataset.eventId);

  await new Promise((r) => chrome.storage.local.set({ enabledEventIds }, r));

  // Demande au content script de se rafraîchir
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "REFRESH_ICONS" });
  }

  setStatus("✅ Filtre appliqué !", "ok");
});

// ── Init ─────────────────────────────────────────────────────
loadEventsList();
