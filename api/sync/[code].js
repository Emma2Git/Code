// Vercel Serverless Function: /api/sync/[code]
//
// Speichert/liest die Sync-Daten über Upstash Redis (REST API).
// Zusätzlich zu den Übungsdaten werden hier jetzt auch die Zeitzone
// des Geräts und (optional) eine Web-Push-Subscription gespeichert,
// damit der Cron-Job (siehe /api/cron/check-reminders) echte
// Benachrichtigungen verschicken kann, auch wenn die App geschlossen ist.
//
// Voraussetzung: In den Vercel-Projekteinstellungen unter
// "Environment Variables" müssen gesetzt sein:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const CODE_REGEX = /^[A-Za-z0-9]{4,32}$/;

async function redisCommand(command) {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !restToken) {
    throw new Error("not_configured");
  }
  const res = await fetch(restUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${restToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    throw new Error("redis_error_" + res.status);
  }
  return res.json();
}

module.exports = async (req, res) => {
  const code = req.query.code;

  if (!code || !CODE_REGEX.test(code)) {
    res.status(400).json({ error: "invalid_code" });
    return;
  }

  const key = `klavierplaner:${code}`;

  try {
    if (req.method === "GET") {
      const result = await redisCommand(["GET", key]);
      if (!result.result) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      let data;
      try {
        data = JSON.parse(result.result);
      } catch {
        res.status(500).json({ error: "corrupt_data" });
        return;
      }
      // pushSubscriptions sind ein internes Server-Detail, nicht Teil der App-Daten
      const { pushSubscriptions, ...publicData } = data;
      res.status(200).json(publicData);
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          body = {};
        }
      }
      body = body || {};

      // Bestehenden Datensatz lesen, um pushSubscriptions nicht versehentlich
      // zu löschen, wenn ein normaler "Hochladen"-Aufruf ohne diese Info kommt.
      let existing = {};
      try {
        const existingResult = await redisCommand(["GET", key]);
        if (existingResult.result) existing = JSON.parse(existingResult.result);
      } catch {
        existing = {};
      }

      const { stuecke = [], eintraege = [], sessions = [], termine = [], timezone, pushSubscription, removePushEndpoint } = body;

      let pushSubscriptions = Array.isArray(existing.pushSubscriptions) ? existing.pushSubscriptions : [];

      if (pushSubscription && pushSubscription.endpoint) {
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== pushSubscription.endpoint);
        pushSubscriptions.push(pushSubscription);
      }
      if (removePushEndpoint) {
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== removePushEndpoint);
      }

      const payload = {
        stuecke,
        eintraege,
        sessions,
        termine,
        timezone: timezone || existing.timezone || "UTC",
        pushSubscriptions,
        updatedAt: new Date().toISOString(),
      };

      await redisCommand(["SET", key, JSON.stringify(payload)]);
      res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
      return;
    }

    res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    if (err.message === "not_configured") {
      res.status(500).json({ error: "server_not_configured" });
      return;
    }
    res.status(500).json({ error: "server_error" });
  }
};
