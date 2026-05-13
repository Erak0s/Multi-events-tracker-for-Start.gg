// ============================================================
//  start.gg Multi-Event Tracker — content.js
//  v3 : stop propagation + navigation vers la phase active
// ============================================================

const API_URL = "https://api.start.gg/gql/alpha";

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function getTournamentSlug() {
  const m = window.location.pathname.match(/\/tournament\/([^\/]+)/);
  return m ? m[1] : null;
}
function getCurrentEventSlug() {
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
        if (p.gamerTag) tags.push(p.gamerTag.toLowerCase().trim());
    page++;
  }
  return tags;
}

// ── Construit la map joueur → events ─────────────────────────
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

  const map = {};
  for (let i = 0; i < toProcess.length; i += 3) {
    await Promise.all(
      toProcess.slice(i, i + 3).map(async (event) => {
        try {
          const tags = await fetchEventEntrants(event.id, apiKey);
          for (const tag of tags) {
            if (!map[tag]) map[tag] = [];
            map[tag].push({
              eventId: event.id,
              eventName: event.name,
              eventSlug: event.slug,
              gameImageUrl: event.gameImageUrl,
              gameName: event.gameName,
            });
          }
        } catch (err) {
          console.warn(`[startgg-tracker] Erreur event "${event.name}":`, err);
        }
      })
    );
  }
  return map;
}

// ── Fetch la PhaseGroup active du joueur dans un event ───────
// Retourne l'URL bracketUrl de la phase où le joueur joue actuellement.
// Priorité : phase ACTIVE (state=2), sinon la plus récente, sinon null.
async function fetchPlayerPhaseUrl(gamerTag, eventId, apiKey) {
  // Étape 1 : trouver l'entrant ID
  const entrantQuery = `
    query FindEntrant($eventId: ID!, $gamerTag: String!) {
      event(id: $eventId) {
        entrants(query: { filter: { name: $gamerTag }, page: 1, perPage: 5 }) {
          nodes {
            id
            participants { gamerTag }
          }
        }
      }
    }
  `;
  const entrantData = await gqlQuery(entrantQuery, { eventId, gamerTag }, apiKey);
  const nodes = entrantData?.data?.event?.entrants?.nodes || [];
  const entrant = nodes.find((n) =>
    n.participants?.some((p) => p.gamerTag.toLowerCase().trim() === gamerTag.toLowerCase().trim())
  );
  if (!entrant) return null;

  // Étape 2 : récupérer les sets récents pour trouver la phaseGroup
  const setsQuery = `
    query EntrantSets($entrantId: ID!) {
      entrant(id: $entrantId) {
        paginatedSets(page: 1, perPage: 30, sortType: RECENT) {
          nodes {
            phaseGroup {
              id
              displayIdentifier
              state
              bracketUrl
              phase { name }
            }
          }
        }
      }
    }
  `;
  const setsData = await gqlQuery(setsQuery, { entrantId: entrant.id }, apiKey);
  const sets = setsData?.data?.entrant?.paginatedSets?.nodes || [];
  if (!sets.length) return null;

  // Déduplique les phaseGroups
  const seen = new Set();
  const groups = [];
  for (const s of sets) {
    const pg = s.phaseGroup;
    if (!pg || seen.has(pg.id)) continue;
    seen.add(pg.id);
    groups.push(pg);
  }

  // state: 1=CREATED, 2=ACTIVE, 3=COMPLETED
  // On prend la phase active en priorité, sinon la première de la liste (= la plus récente)
  const best = groups.find((g) => g.state === 2) || groups[0];
  return best?.bracketUrl || null;
}

// ── Injection des icônes ──────────────────────────────────────
function injectIcons(playerEventMap) {
  const selectors = [
    "[class*='entrantName']",
    "[class*='player-name']",
    "[class*='participantName']",
    "[class*='name--']",
    "[data-testid*='entrant']",
  ];

  document.querySelectorAll(selectors.join(", ")).forEach((el) => {
    if (el.dataset.sggTracked) return;
    el.dataset.sggTracked = "1";

    const tags = el.textContent.trim().split("/").map((t) => t.trim().toLowerCase());

    for (const tag of tags) {
      const events = playerEventMap[tag];
      if (!events?.length) continue;

      for (const { eventId, eventName, eventSlug, gameImageUrl, gameName } of events) {
        const a = document.createElement("a");
        a.className = "sgg-event-icon";
        // Pas de href natif : on gère l'ouverture manuellement pour stopper la propagation
        a.dataset.eventId = eventId;
        a.dataset.eventSlug = eventSlug;
        a.dataset.playerTag = tag;
        a.dataset.resolved = "0";
        a.title = `${eventName}${gameName ? ` · ${gameName}` : ""}`;
        a.setAttribute("role", "button");
        a.setAttribute("aria-label", `Voir le bracket ${eventName}`);

        if (gameImageUrl) {
          const img = document.createElement("img");
          img.src = gameImageUrl;
          img.alt = gameName || eventName;
          img.className = "sgg-game-img";
          a.appendChild(img);
        } else {
          a.textContent = "🎮";
        }

        // ── Bloque les événements souris AVANT que start.gg les capture ──
        for (const evtType of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"]) {
          a.addEventListener(evtType, (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
          }, true);
        }

        // ── Clic principal : résolution lazy de l'URL de phase ────────
        a.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          // URL déjà résolue lors d'un clic précédent
          if (a.dataset.resolved === "1") {
            window.open(a.dataset.resolvedUrl, "_blank", "noopener");
            return;
          }

          // Indicateur visuel de chargement
          a.classList.add("sgg-loading");

          const { apiKey } = await storageGet(["apiKey"]);
          let finalUrl = `https://www.start.gg/${eventSlug}`;

          if (apiKey) {
            try {
              const phaseUrl = await fetchPlayerPhaseUrl(tag, eventId, apiKey);
              if (phaseUrl) finalUrl = phaseUrl;
            } catch (err) {
              console.warn("[startgg-tracker] Phase URL error:", err);
            }
          }

          a.dataset.resolved = "1";
          a.dataset.resolvedUrl = finalUrl;
          a.classList.remove("sgg-loading");

          window.open(finalUrl, "_blank", "noopener");
        }, true); // capture=true : on passe avant les listeners de start.gg

        el.appendChild(a);
      }
    }
  });
}

// ── Supprime toutes les icônes injectées ─────────────────────
function clearIcons() {
  document.querySelectorAll(".sgg-event-icon").forEach((el) => el.remove());
  document.querySelectorAll("[data-sgg-tracked]").forEach((el) => {
    delete el.dataset.sggTracked;
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "REFRESH_ICONS") {
    playerEventMapCache = null;
    clearIcons();
    run();
  }
});

function observeDOM(callback) {
  const observer = new MutationObserver(() => callback());
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
      console.info(`[startgg-tracker] ${Object.keys(playerEventMapCache).length} joueurs multi-events indexés`);
    }
    injectIcons(playerEventMapCache);
  } catch (e) {
    console.error("[startgg-tracker]", e);
  } finally {
    pending = false;
  }
}

run();
let debounce;
observeDOM(() => {
  clearTimeout(debounce);
  debounce = setTimeout(run, 800);
});
