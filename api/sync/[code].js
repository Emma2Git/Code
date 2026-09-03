// Vercel Serverless Function: /api/sync/[code]
//
// Speichert/liest die Sync-Daten über Upstash Redis (REST API).
// Läuft automatisch mit, sobald dieses Repo auf Vercel deployt ist -
// kein separater Server nötig.
//
// Voraussetzung: In den Vercel-Projekteinstellungen unter
// "Environment Variables" müssen zwei Werte gesetzt sein:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
// (beide bekommst du kostenlos von einer Upstash-Redis-Datenbank,
// siehe Anleitung).

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
      res.status(200).json(data);
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
      const { stuecke = [], eintraege = [], sessions = [], termine = [] } = body || {};
      const payload = {
        stuecke,
        eintraege,
        sessions,
        termine,
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
