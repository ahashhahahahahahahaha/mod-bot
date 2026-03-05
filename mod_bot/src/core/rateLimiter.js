// punish-bot/src/core/rateLimiter.js
class RateLimiter {
  constructor({
    staffWindowMs = 10 * 60 * 1000,
    targetWindowMs = 30 * 60 * 1000,
    staffMax = 25,     // 10dk içinde max işlem
    targetMax = 8,     // 30dk içinde tek hedefe max işlem
    aggWindowMs = 10 * 60 * 1000,
  } = {}) {
    this.staffWindowMs = staffWindowMs;
    this.targetWindowMs = targetWindowMs;
    this.staffMax = staffMax;
    this.targetMax = targetMax;
    this.aggWindowMs = aggWindowMs;

    this.staffHits = new Map();  // actorId -> number[]
    this.targetHits = new Map(); // guildId:targetId -> number[]
    this.aggHits = new Map();    // actorId:type -> number[]
  }

  _push(map, key, ts, windowMs) {
    const arr = map.get(key) || [];
    const cutoff = ts - windowMs;
    const filtered = arr.filter((t) => t > cutoff);
    filtered.push(ts);
    map.set(key, filtered);
    return filtered;
  }

  _peek(map, key, ts, windowMs) {
    const arr = map.get(key) || [];
    const cutoff = ts - windowMs;
    const filtered = arr.filter((t) => t > cutoff);
    map.set(key, filtered);
    return filtered;
  }

  /**
   * type: "MUTE" | "VMUTE" | "PENALTY_ADD" ...
   */
  checkAndHit({ guildId, actorId, targetId, type }) {
    const now = Date.now();

    // staff
    const staffArr = this._push(this.staffHits, actorId, now, this.staffWindowMs);
    if (staffArr.length > this.staffMax) {
      const oldest = staffArr[0];
      const retryAfterMs = (oldest + this.staffWindowMs) - now;
      return { ok: false, scope: "STAFF", retryAfterMs, count: staffArr.length, max: this.staffMax };
    }

    // target
    if (targetId) {
      const tKey = `${guildId}:${targetId}`;
      const targetArr = this._push(this.targetHits, tKey, now, this.targetWindowMs);
      if (targetArr.length > this.targetMax) {
        const oldest = targetArr[0];
        const retryAfterMs = (oldest + this.targetWindowMs) - now;
        return { ok: false, scope: "TARGET", retryAfterMs, count: targetArr.length, max: this.targetMax };
      }
    }

    // aggregation
    if (type) {
      const aKey = `${actorId}:${type}`;
      this._push(this.aggHits, aKey, now, this.aggWindowMs);
    }

    return { ok: true };
  }

  getAggregation({ actorId, type }) {
    const now = Date.now();
    const key = `${actorId}:${type}`;
    const arr = this._peek(this.aggHits, key, now, this.aggWindowMs);
    return { windowMs: this.aggWindowMs, count: arr.length };
  }
}

module.exports = { RateLimiter };