// Vercel Serverless Function: /api/cron/check-reminders
//
// Wird NICHT von Vercel selbst zeitgesteuert (Vercel Cron erlaubt auf dem
// Hobby-Plan nur 1x pro Tag), sondern von einem externen, kostenlosen
// Cron-Dienst (z. B. cron-job.org) einmal pro Minute per HTTP-Request
// aufgerufen.
//
// Prüft für jeden gespeicherten Sync-Code, ob gerade (in der jeweiligen
// Zeitzone des Geräts) eine geplante Übung ansteht, und schickt in dem
// Fall eine echte Web-Push-Benachrichtigung an alle registrierten Geräte.
//
// Erwartete Environment Variables:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT            (z.B. "mailto:du@example.com")
//   CRON_SECRET              (frei gewählter geheimer String)
//
// Aufruf durch den externen Cron-Dienst:
//   https://DEINE-DOMAIN/api/cron/check-reminders?secret=DEIN_CRON_SECRET

const webpush = require("web-push");

async function redisCommand(command) {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const res = await fetch(restUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${restToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error("redis_error_" + res.status);
  return res.json();
}

function localDateAndTime(timezone) {
  const now = new Date();
  try {
    const dateStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now); // en-CA -> YYYY-MM-DD
    const timeStr = new Intl.DateTimeFormat("de-DE", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now); // HH:MM
    return { dateStr, timeStr: timeStr.replace("24:", "00:") };
  } catch {
    // Ungültige/unbekannte Zeitzone -> UTC als Fallback
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16);
    return { dateStr, timeStr };
  }
}

module.exports = async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    res.status(500).json({ error: "vapid_not_configured" });
    return;
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  let checked = 0;
  let notified = 0;
  const errors = [];

  try {
    const keysResult = await redisCommand(["KEYS", "klavierplaner:*"]);
    const keys = keysResult.result || [];

    for (const key of keys) {
      checked++;
      let record;
      try {
        const got = await redisCommand(["GET", key]);
        if (!got.result) continue;
        record = JSON.parse(got.result);
      } catch {
        continue;
      }

      const subs = Array.isArray(record.pushSubscriptions) ? record.pushSubscriptions : [];
      if (subs.length === 0) continue;

      const timezone = record.timezone || "UTC";
      const { dateStr, timeStr } = localDateAndTime(timezone);

      const dueEintraege = (record.eintraege || []).filter(
        e => !e.erledigt && e.datum === dateStr && e.uhrzeit === timeStr
      );
      if (dueEintraege.length === 0) continue;

      const stueckeById = {};
      for (const s of record.stuecke || []) stueckeById[s.id] = s;

      let subsChanged = false;
      const stillValidSubs = [];

      for (const sub of subs) {
        let subOk = true;
        for (const eintrag of dueEintraege) {
          const stueck = stueckeById[eintrag.stueckId];
          const title = "Zeit zum Üben 🎹";
          const body = stueck
            ? `${stueck.name} · ${eintrag.dauerMinuten} Min.`
            : `Übung · ${eintrag.dauerMinuten} Min.`;
          try {
            await webpush.sendNotification(sub, JSON.stringify({ title, body }));
            notified++;
          } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
              subOk = false; // Subscription ungültig/abgelaufen -> entfernen
            } else {
              errors.push(String(err.message || err));
            }
          }
        }
        if (subOk) stillValidSubs.push(sub);
        else subsChanged = true;
      }

      if (subsChanged) {
        record.pushSubscriptions = stillValidSubs;
        await redisCommand(["SET", key, JSON.stringify(record)]);
      }
    }

    res.status(200).json({ ok: true, checked, notified, errors });
  } catch (err) {
    res.status(500).json({ error: "server_error", message: String(err.message || err) });
  }
};
