// ============================================================
//  start.gg Multi-Event Tracker — content.js  v7
// ============================================================

const API_URL = "https://api.start.gg/gql/alpha";

function storageGet(keys) {
  return new Promise((r) => chrome.storage.local.get(keys, r));
}
function getTournamentSlug() {
  const m = window.location.pathname.match(/\/tournament\/([^\/]+)/);
  return m ? m[1] : null;
}
function getCurrentEventSlug() {
  // Gère /event/xxx et /event/xxx/brackets/...
  const m = window.location.pathname.match(/\/event\/([^\/]+)/);
  return m ? m[1] : null;
}
async function gqlQuery(query, variables, apiKey) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Fetch events + image du jeu ──────────────────────────────
async function fetchTournamentEvents(tournamentSlug, apiKey) {
  const query = `
    query TournamentEvents($slug: String!) {
      tournament(slug: $slug) {
        events {
          id name slug
          videogame { id name images { url type } }
        }
      }
    }
  `;
  const data = await gqlQuery(query, { slug: tournamentSlug }, apiKey);
  return data?.data?.tournament?.events || [];
}

function pickGameImage(images) {
  if (!images?.length) return null;
  const icon = images.find((i) => i.type === "primary" || i.url?.includes("icon"));
  return (icon || images[0]).url || null;
}

// ── Fetch entrants (paginé) ───────────────────────────────────
async function fetchEventEntrants(eventId, apiKey) {
  const query = `
    query EventEntrants($eventId: ID!, $page: Int!) {
      event(id: $eventId) {
        entrants(query: { page: $page, perPage: 100 }) {
          pageInfo { totalPages }
          nodes { participants { gamerTag } }
        }
      }
    }
  `;
  let page = 1, totalPages = 1;
  const tags = [];
  while (page <= totalPages) {
    const data = await gqlQuery(query, { eventId, page }, apiKey);
    const d = data?.data?.event?.entrants;
    if (!d) break;
    totalPages = d.pageInfo?.totalPages || 1;
    for (const node of d.nodes || [])
      for (const p of node.participants || [])
        if (p.gamerTag) tags.push(p.gamerTag);
    page++;
  }
  return tags;
}

// ── Construit la map ──────────────────────────────────────────
async function buildPlayerEventMap(tournamentSlug, currentEventSlug, enabledEventIds, apiKey) {
  const allEvents = await fetchTournamentEvents(tournamentSlug, apiKey);
  const eventsForPopup = allEvents
    .filter((e) => !e.slug.endsWith(`/${currentEventSlug}`))
    .map((e) => ({
      id: String(e.id),
      name: e.name,
      slug: e.slug,
      gameImageUrl: pickGameImage(e.videogame?.images),
      gameName: e.videogame?.name || null,
    }));

  chrome.storage.local.set({
    [`events_${tournamentSlug}`]: eventsForPopup,
    lastTournamentSlug: tournamentSlug,
  });

  const activeIds = enabledEventIds ?? eventsForPopup.map((e) => e.id);
  const toProcess = eventsForPopup.filter((e) => activeIds.includes(e.id));

  const map = {}; // clé (string lowercase) → [entry]

  function addEntry(key, entry) {
    const k = key.toLowerCase().trim();
    if (!k || k.length < 2) return;
    if (!map[k]) map[k] = [];
    if (!map[k].some(e => e.rawTag === entry.rawTag && e.eventId === entry.eventId))
      map[k].push(entry);
  }

  for (let i = 0; i < toProcess.length; i += 3) {
    await Promise.all(
      toProcess.slice(i, i + 3).map(async (event) => {
        try {
          const rawTags = await fetchEventEntrants(event.id, apiKey);
          for (const rawTag of rawTags) {
            const entry = {
              eventId: event.id, eventName: event.name, eventSlug: event.slug,
              gameImageUrl: event.gameImageUrl, gameName: event.gameName, rawTag,
            };
            // Clé 1 : tag complet
            addEntry(rawTag, entry);
            // Clé 2 : partie après le dernier |
            const afterPipe = rawTag.split("|").pop().trim();
            addEntry(afterPipe, entry);
            // Clé 3 : dernier mot du tag (après espace)
            const lastWord = afterPipe.split(/\s+/).pop();
            addEntry(lastWord, entry);
          }
        } catch (err) {
          console.warn(`[startgg-tracker] Erreur event "${event.name}":`, err);
        }
      })
    );
  }

  const uniquePlayers = new Set(Object.values(map).flat().map(e => e.rawTag)).size;
  console.info(`[startgg-tracker] Map: ${Object.keys(map).length} clés, ${uniquePlayers} joueurs multi-events`);
  return map;
}

// ── Fetch la PhaseGroup active du joueur ─────────────────────
// Logique :
//   1. Phase ACTIVE (state=2) la plus avancée dans le bracket
//   2. Sinon phase CREATED (state=1) la plus avancée
//   3. Sinon la phase terminée la plus avancée (tournoi fini)
// "La plus avancée" = phaseOrder le plus élevé dans l'event.
async function fetchPlayerPhaseUrl(rawTag, eventId, apiKey) {
  // Requête 1 : entrant ID + ordre des phases de l'event
  const combinedQuery = `
    query FindEntrantAndPhases($eventId: ID!, $gamerTag: String!) {
      event(id: $eventId) {
        phases { id phaseOrder }
        entrants(query: { filter: { name: $gamerTag }, page: 1, perPage: 5 }) {
          nodes { id participants { gamerTag } }
        }
      }
    }
  `;
  const combinedData = await gqlQuery(combinedQuery, { eventId, gamerTag: rawTag }, apiKey);
  const event = combinedData?.data?.event;
  if (!event) return null;

  const phaseOrderMap = {};
  for (const ph of event.phases || []) phaseOrderMap[String(ph.id)] = ph.phaseOrder ?? 0;

  const entrant = (event.entrants?.nodes || []).find((n) =>
    n.participants?.some((p) => p.gamerTag.toLowerCase().trim() === rawTag.toLowerCase().trim())
  );
  if (!entrant) return null;

  // Requête 2 : sets de l'entrant avec phaseGroup
  const setsQuery = `
    query EntrantSets($entrantId: ID!) {
      entrant(id: $entrantId) {
        paginatedSets(page: 1, perPage: 50, sortType: RECENT) {
          nodes { phaseGroup { id state bracketUrl phase { id } } }
        }
      }
    }
  `;
  const setsData = await gqlQuery(setsQuery, { entrantId: entrant.id }, apiKey);
  const sets = setsData?.data?.entrant?.paginatedSets?.nodes || [];
  if (!sets.length) return null;

  // Déduplique et enrichit avec phaseOrder
  const seen = new Set();
  const groups = [];
  for (const s of sets) {
    const pg = s.phaseGroup;
    if (!pg || seen.has(pg.id)) continue;
    seen.add(pg.id);
    groups.push({ ...pg, order: phaseOrderMap[String(pg.phase?.id)] ?? 0 });
  }

  // Trie par phaseOrder décroissant (phase la plus avancée en premier)
  groups.sort((a, b) => b.order - a.order);

  const active  = groups.find((g) => g.state === 2); // ACTIVE
  const created = groups.find((g) => g.state === 1); // CREATED (pas encore commencé)
  const best = active || created || groups[0];        // fallback : plus avancée terminée
  return best?.bracketUrl || null;
}

// ── Nombre max d'icônes visibles avant le badge "+" ─────────
const MAX_VISIBLE_ICONS = 2;

// ── Fabrique une icône individuelle ──────────────────────────
function buildIcon(rawTag, { eventId, eventName, eventSlug, gameImageUrl, gameName }) {
  const a = document.createElement("a");
  a.className = "sgg-event-icon";
  a.dataset.resolved = "0";
  a.title = `${eventName}${gameName ? ` · ${gameName}` : ""}`;
  a.setAttribute("role", "button");
  a.setAttribute("aria-label", `Voir le bracket ${eventName}`);

  if (gameImageUrl) {
    const img = document.createElement("img");
    img.src = gameImageUrl; img.alt = gameName || eventName; img.className = "sgg-game-img";
    a.appendChild(img);
  } else {
    a.textContent = "🎮";
  }

  for (const evtType of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"]) {
    a.addEventListener(evtType, (e) => { e.stopPropagation(); e.stopImmediatePropagation(); }, true);
  }

  a.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (a.dataset.resolved === "1") { window.open(a.dataset.resolvedUrl, "_blank", "noopener"); return; }
    a.classList.add("sgg-loading");
    const { apiKey } = await storageGet(["apiKey"]);
    let finalUrl = `https://www.start.gg/${eventSlug}`;
    if (apiKey) {
      try { const u = await fetchPlayerPhaseUrl(rawTag, eventId, apiKey); if (u) finalUrl = u; }
      catch (err) { console.warn("[startgg-tracker] Phase URL error:", err); }
    }
    a.dataset.resolved = "1"; a.dataset.resolvedUrl = finalUrl;
    a.classList.remove("sgg-loading");
    window.open(finalUrl, "_blank", "noopener");
  }, true);

  return a;
}

// ── Ferme tous les popovers ouverts ──────────────────────────
function closeAllPopovers() {
  document.querySelectorAll(".sgg-popover").forEach((p) => p.remove());
  document.querySelectorAll(".sgg-more-btn.open").forEach((b) => b.classList.remove("open"));
}

// ── Fabrique le badge "+N" avec popover ──────────────────────
function buildMoreBadge(rawTag, hiddenEntries) {
  const btn = document.createElement("button");
  btn.className = "sgg-event-icon sgg-more-btn";
  btn.textContent = `+${hiddenEntries.length}`;
  btn.title = `${hiddenEntries.length} autre${hiddenEntries.length > 1 ? "s" : ""} event${hiddenEntries.length > 1 ? "s" : ""}`;

  for (const evtType of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"]) {
    btn.addEventListener(evtType, (e) => { e.stopPropagation(); e.stopImmediatePropagation(); }, true);
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

    // Toggle : si déjà ouvert, ferme
    const existing = document.querySelector(".sgg-popover");
    if (existing && btn.classList.contains("open")) {
      closeAllPopovers();
      return;
    }
    closeAllPopovers();
    btn.classList.add("open");

    // Crée le popover
    const popover = document.createElement("div");
    popover.className = "sgg-popover";

    for (const entry of hiddenEntries) {
      const row = document.createElement("a");
      row.className = "sgg-popover-row";
      row.dataset.resolved = "0";
      row.title = entry.eventName;
      row.setAttribute("role", "button");

      if (entry.gameImageUrl) {
        const img = document.createElement("img");
        img.src = entry.gameImageUrl; img.alt = entry.gameName || ""; img.className = "sgg-game-img";
        row.appendChild(img);
      } else {
        const ico = document.createElement("span");
        ico.textContent = "🎮"; ico.className = "sgg-popover-ico";
        row.appendChild(ico);
      }

      const label = document.createElement("span");
      label.className = "sgg-popover-label";
      label.textContent = entry.eventName;
      if (entry.gameName) {
        const sub = document.createElement("span");
        sub.className = "sgg-popover-sub";
        sub.textContent = entry.gameName;
        label.appendChild(document.createElement("br"));
        label.appendChild(sub);
      }
      row.appendChild(label);

      for (const evtType of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"]) {
        row.addEventListener(evtType, (e) => { e.stopPropagation(); e.stopImmediatePropagation(); }, true);
      }

      row.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (row.dataset.resolved === "1") {
          window.open(row.dataset.resolvedUrl, "_blank", "noopener");
          closeAllPopovers();
          return;
        }
        row.classList.add("sgg-loading");
        const { apiKey } = await storageGet(["apiKey"]);
        let finalUrl = `https://www.start.gg/${entry.eventSlug}`;
        if (apiKey) {
          try { const u = await fetchPlayerPhaseUrl(rawTag, entry.eventId, apiKey); if (u) finalUrl = u; }
          catch (err) { console.warn("[startgg-tracker] Phase URL error:", err); }
        }
        row.dataset.resolved = "1"; row.dataset.resolvedUrl = finalUrl;
        row.classList.remove("sgg-loading");
        window.open(finalUrl, "_blank", "noopener");
        closeAllPopovers();
      }, true);

      popover.appendChild(row);
    }

    // Téléporte dans le body pour échapper aux overflow:hidden parents
    document.body.appendChild(popover);

    // Positionne au-dessus du badge via getBoundingClientRect
    const rect = btn.getBoundingClientRect();
    popover.style.position = "fixed";
    popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    popover.style.right  = `${window.innerWidth - rect.right}px`;

    // Clic extérieur → ferme
    setTimeout(() => {
      document.addEventListener("click", closeAllPopovers, { once: true, capture: true });
    }, 0);
  }, true);

  return btn;
}

// ── Injection ─────────────────────────────────────────────────
// Stratégie : scan de TOUS les nœuds texte courts du DOM.
// C'est le seul moyen fiable car start.gg change ses classes CSS à chaque déploiement.
// On évite de marquer les éléments parents — on marque le nœud texte lui-même
// avec un attribut sur le parent, et on ré-injecte si le parent a été recréé par React.

function injectIcons(playerEventMap) {
  if (!playerEventMap || !Object.keys(playerEventMap).length) return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Ignore nœuds dans des éléments non-visibles ou fonctionnels
      const tag = node.parentElement?.tagName?.toLowerCase();
      if (!tag || ["script","style","input","textarea","select","button","noscript"].includes(tag)) 
        return NodeFilter.FILTER_REJECT;
      // Ignore les icônes déjà injectées
      if (node.parentElement?.classList?.contains("sgg-event-icon"))
        return NodeFilter.FILTER_REJECT;
      const t = node.textContent.trim();
      if (!t || t.length < 2 || t.length > 80 || t.includes("\n"))
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const textNode of nodes) {
    const parent = textNode.parentElement;
    if (!parent) continue;

    // Vérifie si cet élément a déjà des icônes injectées pour ce même texte
    // (évite les doublons sans bloquer la ré-injection si React recrée le nœud)
    const existingIcons = parent.querySelectorAll(".sgg-event-icon");
    if (existingIcons.length > 0) continue;

    const text = textNode.textContent.trim().toLowerCase();
    const entries = playerEventMap[text];
    if (!entries?.length) continue;

    // Marque l'élément pour ne pas le retraiter dans cette passe
    parent.dataset.sggTracked = "1";

    const seenEvents = new Set();
    const deduped = [];
    for (const entry of entries) {
      if (seenEvents.has(entry.eventId)) continue;
      seenEvents.add(entry.eventId);
      deduped.push(entry);
    }

    // Icônes visibles (max MAX_VISIBLE_ICONS)
    const visible = deduped.slice(0, MAX_VISIBLE_ICONS);
    const hidden  = deduped.slice(MAX_VISIBLE_ICONS);

    for (const entry of visible) {
      parent.appendChild(buildIcon(entry.rawTag, entry));
    }
    if (hidden.length > 0) {
      parent.appendChild(buildMoreBadge(deduped[0].rawTag, hidden));
    }
  }
}

// ── Nettoyage ─────────────────────────────────────────────────
function clearIcons() {
  document.querySelectorAll(".sgg-event-icon").forEach((el) => el.remove());
  document.querySelectorAll("[data-sgg-tracked]").forEach((el) => {
    delete el.dataset.sggTracked;
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "REFRESH_ICONS") { playerEventMapCache = null; clearIcons(); run(); }
});

// ── Observer DOM robuste ──────────────────────────────────────
// Relance injectIcons dès que React modifie le DOM, sans rebuild de la map.
// Utilise un debounce court pour grouper les mutations rapides.
let debounce;
function observeDOM() {
  const observer = new MutationObserver((mutations) => {
    // Ignore les mutations causées par nos propres injections
    const onlyOurChanges = mutations.every(m =>
      [...m.addedNodes].every(node =>
        node.nodeType === 1 && node.classList?.contains("sgg-event-icon")
      )
    );
    if (onlyOurChanges) return;

    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (playerEventMapCache) injectIcons(playerEventMapCache);
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

let playerEventMapCache = null;
let pending = false;

async function run() {
  if (pending) return;
  pending = true;
  try {
    const { apiKey, enabledEventIds } = await storageGet(["apiKey", "enabledEventIds"]);
    if (!apiKey) return;

    const tournamentSlug = getTournamentSlug();
    const currentEventSlug = getCurrentEventSlug();
    if (!tournamentSlug || !currentEventSlug) return;

    if (!playerEventMapCache) {
      playerEventMapCache = await buildPlayerEventMap(
        tournamentSlug, currentEventSlug, enabledEventIds ?? null, apiKey
      );
    }
    injectIcons(playerEventMapCache);
  } catch (e) {
    console.error("[startgg-tracker]", e);
  } finally {
    pending = false;
  }
}

run();
observeDOM();
