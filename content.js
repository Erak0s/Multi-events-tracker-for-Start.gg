// ============================================================
//  start.gg Multi-Event Tracker — content.js  v7
// ============================================================

const API_URL = "https://api.start.gg/gql/alpha";

// In-memory set of player names to highlight on next page load
let pendingHighlights = new Set();

function storageGet(keys) {
  return new Promise((r) => chrome.storage.local.get(keys, r));
}
function getTournamentSlug() {
  const m = window.location.pathname.match(/\/tournament\/([^\/]+)/);
  return m ? m[1] : null;
}
function getCurrentEventSlug() {
  const m = window.location.pathname.match(/\/event[s]?\/([^\/]+)/);
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

  chrome.runtime.sendMessage({ type: "EVENTS_UPDATED", slug: tournamentSlug }).catch(() => {});

  const activeIds = enabledEventIds ?? eventsForPopup.map((e) => e.id);
  const toProcess = eventsForPopup.filter((e) => activeIds.includes(e.id));

  const map = {};

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
            addEntry(rawTag, entry);
            const afterPipe = rawTag.split("|").pop().trim();
            addEntry(afterPipe, entry);
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
async function fetchPlayerPhaseUrl(rawTag, eventId, apiKey) {
  const combinedQuery = `
    query FindEntrantAndPhases($eventId: ID!, $gamerTag: String!) {
      event(id: $eventId) {
        phases {
          id phaseOrder
          phaseGroups(query: { page: 1, perPage: 50 }) {
            nodes { id state bracketUrl }
          }
        }
        entrants(query: { filter: { name: $gamerTag }, page: 1, perPage: 5 }) {
          nodes {
            id
            participants { gamerTag }
            seeds { phaseGroup { id } }
            paginatedSets(page: 1, perPage: 1, sortType: RECENT) {
              nodes { phaseGroup { id } }
            }
          }
        }
      }
    }
  `;
  const combinedData = await gqlQuery(combinedQuery, { eventId, gamerTag: rawTag }, apiKey);
  const event = combinedData?.data?.event;
  if (!event) return null;

  const entrant = (event.entrants?.nodes || []).find((n) =>
    n.participants?.some((p) => p.gamerTag.toLowerCase().trim() === rawTag.toLowerCase().trim())
  );
  if (!entrant) return null;

  const pgMap = {};
  for (const phase of event.phases || []) {
    for (const pg of phase.phaseGroups?.nodes || []) {
      pgMap[String(pg.id)] = { ...pg, phaseOrder: phase.phaseOrder ?? 0 };
    }
  }

  // Prefer the phaseGroup from an actual set (mid/post-tournament)
  const setPhaseGroupId = entrant.paginatedSets?.nodes?.[0]?.phaseGroup?.id;
  if (setPhaseGroupId && pgMap[String(setPhaseGroupId)]) {
    return pgMap[String(setPhaseGroupId)].bracketUrl || null;
  }

  // Fall back to the entrant's seed phaseGroup (pre-tournament, pools not started)
  const seedPhaseGroupId = entrant.seeds?.[0]?.phaseGroup?.id;
  if (seedPhaseGroupId && pgMap[String(seedPhaseGroupId)]) {
    return pgMap[String(seedPhaseGroupId)].bracketUrl || null;
  }

  // Last resort: earliest phase group by phaseOrder
  const groups = Object.values(pgMap).sort((a, b) => a.phaseOrder - b.phaseOrder);
  const active  = groups.find((g) => g.state === 2);
  const created = groups.find((g) => g.state === 1);
  const best = active || created || groups[0];
  return best?.bracketUrl || null;
}

// ── Highlight les joueurs en attente ─────────────────────────
function applyPendingHighlights() {
  if (!pendingHighlights.size) return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName?.toLowerCase();
      if (!tag || ["script","style","input","textarea","select","button","noscript"].includes(tag))
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
    const text = textNode.textContent.trim().toLowerCase();
    for (const tag of pendingHighlights) {
      if (text === tag.toLowerCase()) {
        const parent = textNode.parentElement;
        if (parent && !parent.classList.contains("sgg-highlight")) {
          parent.classList.add("sgg-highlight");
        }
      }
    }
  }

  // Clear after applying — one-shot highlight
  pendingHighlights.clear();
}

// ── Nombre max d'icônes visibles avant le badge "+" ─────────
const MAX_VISIBLE_ICONS = 2;

// ── Ouvre un bracket et enregistre le joueur à highlighter ───
async function openBracket(rawTag, eventId, eventSlug) {
  const { apiKey } = await storageGet(["apiKey"]);
  let finalUrl = `https://www.start.gg/${eventSlug}`;
  if (apiKey) {
    try { const u = await fetchPlayerPhaseUrl(rawTag, eventId, apiKey); if (u) finalUrl = u; }
    catch (err) { console.warn("[startgg-tracker] Phase URL error:", err); }
  }
  // Store the player name so the new tab's content script can highlight it
  const existing = await storageGet(["pendingHighlights"]);
  const current = existing.pendingHighlights || [];
  if (!current.includes(rawTag)) current.push(rawTag);
  await new Promise((r) => chrome.storage.local.set({ pendingHighlights: current }, r));
  window.open(finalUrl, "_blank", "noopener");
}

// ── Fabrique une icône individuelle ──────────────────────────
function buildIcon(rawTag, { eventId, eventName, eventSlug, gameImageUrl, gameName }) {
  const a = document.createElement("a");
  a.className = "sgg-event-icon";
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
    a.classList.add("sgg-loading");
    await openBracket(rawTag, eventId, eventSlug);
    a.classList.remove("sgg-loading");
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

    const existing = document.querySelector(".sgg-popover");
    if (existing && btn.classList.contains("open")) {
      closeAllPopovers();
      return;
    }
    closeAllPopovers();
    btn.classList.add("open");

    const popover = document.createElement("div");
    popover.className = "sgg-popover";

    for (const entry of hiddenEntries) {
      const row = document.createElement("a");
      row.className = "sgg-popover-row";
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
        row.classList.add("sgg-loading");
        await openBracket(rawTag, entry.eventId, entry.eventSlug);
        row.classList.remove("sgg-loading");
        closeAllPopovers();
      }, true);

      popover.appendChild(row);
    }

    document.body.appendChild(popover);

    const rect = btn.getBoundingClientRect();
    popover.style.position = "fixed";
    popover.style.bottom = `${window.innerHeight - rect.top + 8}px`;
    popover.style.right  = `${window.innerWidth - rect.right}px`;

    setTimeout(() => {
      document.addEventListener("click", closeAllPopovers, { once: true, capture: true });
    }, 0);
  }, true);

  return btn;
}

// ── Injection ─────────────────────────────────────────────────
function injectIcons(playerEventMap) {
  if (!playerEventMap || !Object.keys(playerEventMap).length) return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName?.toLowerCase();
      if (!tag || ["script","style","input","textarea","select","button","noscript"].includes(tag))
        return NodeFilter.FILTER_REJECT;
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

    const existingIcons = parent.querySelectorAll(".sgg-event-icon");
    if (existingIcons.length > 0) continue;

    const text = textNode.textContent.trim().toLowerCase();
    const entries = playerEventMap[text];
    if (!entries?.length) continue;

    const currentPath = window.location.pathname.replace("/events/", "/event/");
    const filtered = entries.filter(e => !currentPath.includes(e.eventSlug));
    if (!filtered.length) continue;

    parent.dataset.sggTracked = "1";

    const seenEvents = new Set();
    const deduped = [];
    for (const entry of filtered) {
      if (seenEvents.has(entry.eventId)) continue;
      seenEvents.add(entry.eventId);
      deduped.push(entry);
    }

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "REFRESH_ICONS") {
    playerEventMapCache = null;
    clearIcons();
    run();
    return false;
  }
  if (msg.type === "GET_TOURNAMENT_SLUG") {
    sendResponse({ slug: getTournamentSlug() });
    return false;
  }
});

// ── Observer DOM robuste ──────────────────────────────────────
let debounce;
function observeDOM() {
  const observer = new MutationObserver((mutations) => {
    const onlyOurChanges = mutations.every(m =>
      [...m.addedNodes].every(node =>
        node.nodeType === 1 && node.classList?.contains("sgg-event-icon")
      )
    );
    if (onlyOurChanges) return;

    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (playerEventMapCache) {
        injectIcons(playerEventMapCache);
        applyPendingHighlights();
      }
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
    const { apiKey, enabledEventIds, pendingHighlights: storedHighlights } = await storageGet(["apiKey", "enabledEventIds", "pendingHighlights"]);
    if (!apiKey) return;

    // Load pending highlights from storage into memory and clear storage
    if (storedHighlights?.length) {
      for (const tag of storedHighlights) pendingHighlights.add(tag);
      chrome.storage.local.remove("pendingHighlights");
    }

    const tournamentSlug = getTournamentSlug();
    if (!tournamentSlug) return;

    const currentEventSlug = getCurrentEventSlug();

    if (!playerEventMapCache) {
      playerEventMapCache = await buildPlayerEventMap(
        tournamentSlug, currentEventSlug, enabledEventIds ?? null, apiKey
      );
    }
    injectIcons(playerEventMapCache);
    applyPendingHighlights();
  } catch (e) {
    console.error("[startgg-tracker]", e);
  } finally {
    pending = false;
  }
}

// ── Inject highlight style ────────────────────────────────────
const style = document.createElement("style");
style.textContent = `.sgg-highlight { background-color: rgba(168, 85, 247, 0.25) !important; border-radius: 3px; padding: 0 2px; }`;
document.head.appendChild(style);

run();
observeDOM();