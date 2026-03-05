// punish-bot/src/ops/opsEvents.js
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

function makeEventId() {
  // kısa, yeterince unique
  return crypto.randomBytes(12).toString("hex");
}

function publishToFile(event, filePath) {
  const line = JSON.stringify(event) + "\n";
  fs.appendFileSync(filePath, line, "utf8");
}

function postJsonWebhook(urlStr, payload) {
  try {
    const u = new URL(urlStr);
    const body = Buffer.from(JSON.stringify(payload));
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {});
      }
    );
    req.on("error", () => {});
    req.write(body);
    req.end();
  } catch {
    // sessiz geç
  }
}

class OpsEvents {
  constructor({
    filePath = "./ops-events.jsonl",
    webhookUrl = null,
    schemaVersion = 1,
  } = {}) {
    this.filePath = filePath;
    this.webhookUrl = webhookUrl;
    this.schemaVersion = schemaVersion;

    // dosya yoksa oluştur
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, "", "utf8");
  }

  emit({ guildId, type, actor, target = null, reason = "", meta = {} }) {
    const ev = {
      v: this.schemaVersion,
      eventId: makeEventId(),
      ts: Date.now(),
      guildId,
      type,
      actor,   // { id, modLevel }
      target,  // { id } | null
      reason,
      meta,
    };

    publishToFile(ev, this.filePath);

    if (this.webhookUrl) {
      // webhook'a da aynı json gönderilir
      postJsonWebhook(this.webhookUrl, ev);
    }

    return ev;
  }
}

module.exports = { OpsEvents };