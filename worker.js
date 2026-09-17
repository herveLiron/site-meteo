// Worker "site-meteo" : sert les fichiers statiques (index.html, etc.) et expose
// une route API server-side qui va chercher la température extérieure mesurée
// par la station météo personnelle (via Home Assistant), sans jamais exposer
// le token HA au navigateur.

const ENTITY_ID = "sensor.gw2000a_outdoor_temperature";
const HA_BASE = "https://ha.rvliron.fr";
const CACHE_TTL_SECONDS = 600; // 10 minutes
const TIMEZONE = "Europe/Paris";

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

// Renvoie l'instant UTC correspondant à minuit (heure de Paris) du jour courant,
// en testant les deux décalages possibles (UTC+1 hiver / UTC+2 été).
function parisMidnightUTC(now) {
  const { date } = parisDateParts(now);
  for (const offsetHours of [2, 1]) {
    const candidate = new Date(
      `${date}T00:00:00.000${offsetHours >= 0 ? "+" : "-"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`
    );
    const check = parisDateParts(candidate);
    if (check.date === date && check.hour === 0) return candidate;
  }
  return new Date(`${date}T00:00:00.000Z`);
}

async function handleExterieur(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/exterieur-jour", request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const now = new Date();
  const start = parisMidnightUTC(now);
  const url =
    `${HA_BASE}/api/history/period/${start.toISOString()}` +
    `?filter_entity_id=${ENTITY_ID}&end_time=${now.toISOString()}&minimal_response`;

  const haResp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.HA_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!haResp.ok) {
    return new Response(JSON.stringify({ error: "ha_unreachable", status: haResp.status }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const raw = await haResp.json();
  const states = (raw[0] || [])
    .map((s) => ({ value: parseFloat(s.state), at: new Date(s.last_changed) }))
    .filter((s) => Number.isFinite(s.value));

  const buckets = Array.from({ length: 24 }, () => []);
  const { date: todayDate, hour: currentHour } = parisDateParts(now);
  for (const s of states) {
    const { date: sDate, hour } = parisDateParts(s.at);
    if (sDate === todayDate) buckets[hour].push(s.value);
  }

  const hourly = buckets.map((b) =>
    b.length ? Math.round((b.reduce((a, v) => a + v, 0) / b.length) * 10) / 10 : null
  );

  // Les heures futures de la journée n'ont pas de mesure : on les laisse à null
  // plutôt que de les fusionner avec l'heure courante.
  for (let h = currentHour + 1; h < 24; h++) hourly[h] = null;

  const body = JSON.stringify({
    date: todayDate,
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
    return env.ASSETS.fetch(request);
  },
};
