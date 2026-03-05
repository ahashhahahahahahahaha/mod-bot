// src/services/vmuteService.js
const { Events } = require("discord.js");

/**
 * VMuted rolü taşıyan üyeleri her voice join / channel change anında 1 kez server-mute eder.
 * - Permission vermez, sadece "Right click -> Server mute" karşılığı: member.voice.setMute(true)
 * - Zaten mute ise tekrar çağırmaz.
 * - Cooldown ile spamı keser.
 */
function setupVmuteService(client, cfg, logger = console) {
  const cooldownMs = Math.max(0, (cfg.vmuteCooldownSec ?? 20) * 1000);

  // userId -> { channelId, at }
  const lastAction = new Map();

  function shouldActOnce(userId, channelId) {
    const now = Date.now();
    const prev = lastAction.get(userId);
    if (!prev) {
      lastAction.set(userId, { channelId, at: now });
      return true;
    }

    // Aynı kanalda kısa sürede tekrar tetiklenme: kes
    if (prev.channelId === channelId && now - prev.at < cooldownMs) return false;

    // Kanal değiştiyse veya süre geçtiyse: izin ver
    lastAction.set(userId, { channelId, at: now });
    return true;
  }

  async function tryServerMute(member, reason, channelIdForOnce) {
    // Member yoksa çık
    if (!member) return;

    // Rol kontrolü
    if (!member.roles?.cache?.has(cfg.vmuteRoleId)) return;

    // Ses bağlantısı yoksa çık
    const vs = member.voice;
    if (!vs?.channelId) return;

    // Bir kez kuralı (join / channel change için)
    if (!shouldActOnce(member.id, channelIdForOnce ?? vs.channelId)) return;

    // Zaten server muted ise tekrar çağırma
    if (vs.serverMute === true) return;

    // Yetki/hiyerarşi sorunlarını yumuşak yakala
    try {
      await vs.setMute(true, reason);
    } catch (err) {
      logger.warn?.(
        `[vmuteService] setMute failed for ${member.user?.tag ?? member.id}: ${err?.message ?? err}`
      );
    }
  }

  // Voice state update: join veya kanal değişimi yakala
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
      const member = newState.member ?? oldState.member;
      if (!member) return;

      const oldCh = oldState.channelId;
      const newCh = newState.channelId;

      // Kanal yoksa (leave) bir şey yapma
      if (!newCh) return;

      // Join veya kanal değişimi
      const joined = !oldCh && !!newCh;
      const moved = !!oldCh && !!newCh && oldCh !== newCh;
      if (!joined && !moved) return;

      await tryServerMute(
        member,
        moved ? "VMuted: channel move" : "VMuted: voice join",
        newCh
      );
    } catch (err) {
      logger.warn?.(`[vmuteService] voiceStateUpdate handler error: ${err?.message ?? err}`);
    }
  });

  // (Opsiyonel ama faydalı) Bot açılınca o anda seste olan VMuted'leri bir kez mute et
  async function enforceOnReady() {
    for (const guild of client.guilds.cache.values()) {
      // guild.voiceStates.cache: seste olan üyeler
      for (const [userId, vs] of guild.voiceStates.cache) {
        const member = vs.member;
        if (!member) continue;
        if(!vs.channelId) continue;
        // Ready sırasında "1 kez" mantığı: aynı kanala key verelim
        await tryServerMute(member, "VMuted: bot startup enforce", vs.channelId);
      }
    }
  }

  return { enforceOnReady };
}

module.exports = { setupVmuteService };