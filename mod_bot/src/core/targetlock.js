// punish-bot/src/core/targetLock.js
class TargetLock {
  constructor({ ttlMs = 60_000 } = {}) {
    this.ttlMs = ttlMs;
    this.locks = new Map(); // key -> { until, holder }
    this._sweeper = setInterval(() => this.sweep(), Math.min(30_000, ttlMs)).unref?.();
  }

  _key(guildId, targetId) {
    return `${guildId}:${targetId}`;
  }

  tryAcquire({ guildId, targetId, holder = "unknown" }) {
    const now = Date.now();
    const key = this._key(guildId, targetId);
    const existing = this.locks.get(key);

    if (existing && existing.until > now) {
      return { ok: false, key, until: existing.until, holder: existing.holder };
    }

    this.locks.set(key, { until: now + this.ttlMs, holder });
    return { ok: true, key };
  }

  release({ key }) {
    if (!key) return;
    this.locks.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [key, v] of this.locks.entries()) {
      if (!v || v.until <= now) this.locks.delete(key);
    }
  }
}

module.exports = { TargetLock };