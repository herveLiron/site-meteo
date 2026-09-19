// Worker "site-meteo" : sert les fichiers statiques (index.html, etc.) et expose
// une route API server-side qui va chercher la température extérieure mesurée
// par la station météo personnelle (via Home Assistant), sans jamais exposer
// le token HA au navigateur.
//
// Deux mécanismes de donnée mesurée :
// - "aujourd'hui" (pas de paramètre ?date, ou ?date=<date du jour>) : lecture en direct
//   dans l'historique HA (~10 jours de rétention), mise en cache edge 10 min.
// - un jour passé (?date=AAAA-MM-JJ) : lecture dans l'archive KV (MESURES_JOUR), alimentée
//   chaque nuit par le handler `scheduled` qui archive la journée qui vient de se terminer.
//   Chaque entrée expire automatiquement au bout d'environ 1 an (fenêtre glissante).

const ENTITY_ID = "sensor.gw2000a_outdoor_temperature";
const HA_BASE = "https://ha.rvliron.fr";
const CACHE_TTL_SECONDS = 600; // 10 minutes (donnée "aujourd'hui", encore en évolution)
const TIMEZONE = "Europe/Paris";
const ARCHIVE_TTL_SECONDS = 366 * 24 * 60 * 60; // ~1 an : fenêtre glissante, KV supprime tout seul au-delà

// Découpe une date en { date: "AAAA-MM-JJ", hour: 0-23 } dans le fuseau Europe/Paris,
// quelle que soit l'heure UTC/DST au moment de l'appel.
function parisDateParts(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour === "24" ? "0" : parts.hour, 10),
  };
}

// Renvoie l'instant UTC correspondant à minuit (heure de Paris) pour la date "AAAA-MM-JJ"
// donnée, en testant les deux décalages possibles (UTC+1 hiver / UTC+2 été).
function parisMidnightForDate(dateStr) {
  for (const offsetHours of [2, 1]) {
    const candidate = new Date(
      `${dateStr}T00:00:00.000${offsetHours >= 0 ? "+" : "-"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`
    );
    const check = parisDateParts(candidate);
    if (check.date === dateStr && check.hour === 0) return candidate;
  }
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function parisMidnightUTC(now) {
  const { date } = parisDateParts(now);
  return parisMidnightForDate(date);
}

// Interroge l'historique HA sur la fenêtre [start, end) et renvoie une moyenne horaire
// (24 valeurs, null si aucune mesure pour l'heure). `cutoffHour`, si fourni, force à null
// toutes les heures postérieures (utilisé pour "aujourd'hui" : pas de mesure future).
async function fetchHourlyAverage(env, start, end, cutoffHour = null) {
  const url =
    `${HA_BASE}/api/history/period/${start.toISOString()}` +
    `?filter_entity_id=${ENTITY_ID}&end_time=${end.toISOString()}&minimal_response`;

  const haResp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.HA_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!haResp.ok) {
    throw new Error(`ha_unreachable:${haResp.status}`);
  }

  const raw = await haResp.json();
  const states = (raw[0] || [])
    .map((s) => ({ value: parseFloat(s.state), at: new Date(s.last_changed) }))
    .filter((s) => Number.isFinite(s.value));

  const buckets = Array.from({ length: 24 }, () => []);
  const { date: targetDate } = parisDateParts(start);
  for (const s of states) {
    const { date: sDate, hour } = parisDateParts(s.at);
    if (sDate === targetDate) buckets[hour].push(s.value);
  }

  const hourly = buckets.map((b) =>
    b.length ? Math.round((b.reduce((a, v) => a + v, 0) / b.length) * 10) / 10 : null
  );

  if (cutoffHour !== null) {
    for (let h = cutoffHour + 1; h < 24; h++) hourly[h] = null;
  }

  return hourly;
}

// Calcule et enregistre dans KV la courbe horaire mesurée pour une journée complète
// (déjà terminée) donnée en "AAAA-MM-JJ". Réutilisé par le cron quotidien et par le
// backfill manuel.
async function archiveDate(env, isoDate) {
  const dayStart = parisMidnightForDate(isoDate);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const hourly = await fetchHourlyAverage(env, dayStart, dayEnd, null);
  const body = JSON.stringify({
    date: isoDate,
    timezone: TIMEZONE,
    entity_id: ENTITY_ID,
    hourly,
    updated_at: new Date().toISOString(),
    archived: true,
  });
  await env.MESURES_JOUR.put(`mesure:${isoDate}`, body, { expirationTtl: ARCHIVE_TTL_SECONDS });
  return hourly;
}

// Archive la journée qui vient de se terminer (hier, heure de Paris). Appelé chaque nuit
// par le cron trigger.
async function archiveYesterday(env) {
  const now = new Date();
  const todayMidnight = parisMidnightUTC(now);
  const yesterdayInstant = new Date(todayMidnight.getTime() - 24 * 60 * 60 * 1000);
  const { date: yesterdayISO } = parisDateParts(yesterdayInstant);
  return archiveDate(env, yesterdayISO);
}

async function handleExterieurAujourdhui(request, env, ctx, todayParts) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/exterieur-jour", request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const start = parisMidnightUTC(now);

  let hourly;
  try {
    hourly = await fetchHourlyAverage(env, start, now, todayParts.hour);
  } catch (err) {
    return new Response(JSON.stringify({ error: "ha_unreachable", message: String(err) }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const body = JSON.stringify({
    date: todayParts.date,
    timezone: TIMEZONE,
    entity_id: ENTITY_ID,
    hourly,
    updated_at: now.toISOString(),
  });

  const response = new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=60, s-maxage=${CACHE_TTL_SECONDS}`,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleExterieurArchive(request, isoDate, env, ctx) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return new Response(JSON.stringify({ error: "invalid_date" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const stored = await env.MESURES_JOUR.get(`mesure:${isoDate}`);
  const body =
    stored ??
    JSON.stringify({
      date: isoDate,
      timezone: TIMEZONE,
      entity_id: ENTITY_ID,
      hourly: Array(24).fill(null),
      updated_at: null,
      archived: true,
      no_data: true,
    });

  const response = new Response(body, {
    headers: {
      "Content-Type": "application/json",
      // Une journée archivée ne change plus : cache long côté edge.
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleExterieur(request, env, ctx) {
  const url = new URL(request.url);
  const dateParam = url.searchParams.get("date");
  const now = new Date();
  const todayParts = parisDateParts(now);

  if (dateParam && dateParam !== todayParts.date) {
    return handleExterieurArchive(request, dateParam, env, ctx);
  }
  return handleExterieurAujourdhui(request, env, ctx, todayParts);
}

// Route d'admin ponctuelle : recalcule et archive les N derniers jours déjà terminés
// (par défaut 9, la limite de rétention utile de l'historique HA). Protégée par
// env.ADMIN_KEY (secret Cloudflare), à utiliser une fois pour amorcer l'archive.
async function handleAdminBackfill(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const requested = parseInt(url.searchParams.get("days") || "9", 10);
  const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 9) : 9;

  const now = new Date();
  const todayMidnight = parisMidnightUTC(now);
  const results = [];
  for (let i = 1; i <= days; i++) {
    const instant = new Date(todayMidnight.getTime() - i * 24 * 60 * 60 * 1000);
    const { date: isoDate } = parisDateParts(instant);
    try {
      const hourly = await archiveDate(env, isoDate);
      results.push({ date: isoDate, ok: true, heures_avec_donnee: hourly.filter((v) => v !== null).length });
    } catch (err) {
      results.push({ date: isoDate, ok: false, error: String(err) });
    }
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/exterieur-jour") {
      try {
        return await handleExterieur(request, env, ctx);
      } catch (err) {
        return new Response(JSON.stringify({ error: "internal_error", message: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
    }
    if (url.pathname === "/api/admin/archiver") {
      try {
        return await handleAdminBackfill(request, env);
      } catch (err) {
        return new Response(JSON.stringify({ error: "internal_error", message: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(archiveYesterday(env));
  },
};
