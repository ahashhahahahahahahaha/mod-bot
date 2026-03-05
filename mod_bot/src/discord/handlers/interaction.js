// punish-bot/src/discord/handlers/interaction.js
const { assertCanUse, getModLevel } = require("../../core/access");

function msHuman(ms) {
  if (!ms || ms <= 0) return "0s";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  return `${m}dk`;
}

function attachInteractionHandler({ client, cfg, rateLimiter, targetLock, opsEvents, queue }) {
  client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand()) return;
    if (!i.inGuild()) return i.reply({ content: "Sadece sunucuda.", ephemeral: true });

    // (discord timeout yememek için)
    await i.deferReply({ ephemeral: true });

    // queue her interaction'ı sıraya alsın (Discord API spacing)
    await queue.enqueue(async () => {
      try {
        const actor = i.member; // GuildMember
        const actionType = i.commandName.toUpperCase(); // şimdilik

        // hedefli komutlarda: option user
        const targetUser = i.options.getUser("user", false);
        const targetMember = targetUser ? await i.guild.members.fetch(targetUser.id).catch(() => null) : null;

        // ACCESS
        assertCanUse({ actor, target: targetMember, action: actionType }, cfg);

        // RATE LIMIT
        const rl = rateLimiter.checkAndHit({
          guildId: i.guildId,
          actorId: actor.id,
          targetId: targetMember?.id || null,
          type: actionType,
        });

        if (!rl.ok) {
          return i.editReply(`Rate limit: **${rl.scope}**. Tekrar dene: **${msHuman(rl.retryAfterMs)}**`);
        }

        // TARGET LOCK (hedef varsa)
        let lock = null;
        if (targetMember) {
          lock = targetLock.tryAcquire({
            guildId: i.guildId,
            targetId: targetMember.id,
            holder: `${actor.id}:${actionType}`,
          });
          if (!lock.ok) {
            return i.editReply("Hedef üzerinde başka bir işlem sürüyor. 5-10 sn sonra tekrar dene.");
          }
        }

        try {
          // ŞİMDİLİK TEST KOMUTU: /ping veya /test
          if (i.commandName === "ping") {
            // ops-events örneği
            opsEvents.emit({
              guildId: i.guildId,
              type: "PING",
              actor: { id: actor.id, modLevel: getModLevel(actor, cfg) },
              target: null,
              reason: "ping",
              meta: { latencyMs: client.ws.ping },
            });

            return i.editReply(`pong ✅ ws: ${client.ws.ping}ms`);
          }

          return i.editReply("Router çalışıyor ✅ (service bağlanmadı)");
        } finally {
          if (lock?.ok) targetLock.release({ key: lock.key });
        }
      } catch (err) {
        const msg = err?.message || "Bilinmeyen hata";
        return i.editReply(`Hata: ${msg}`).catch(() => {});
      }
    });
  });
}

module.exports = { attachInteractionHandler };