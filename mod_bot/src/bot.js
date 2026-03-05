const fs = require("fs");
const path = require("path");
const { setupVmuteService } = require("./services/vmuteService");
const {
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  AuditLogEvent
} = require("discord.js");

const { SPAM, TEN_HOURS, CEZA_LIMIT } = require("./config");

// bot.js artık botu KURMUYOR.
// Sadece event/komut handlerlarını attach ediyor.
function attachBot({ client, cfg, store, saveStore, queue }) {
  // RAM runtime (restart olunca sıfırlanır)
  const spamRuntime = new Map(); // userId -> { msgs: number[], warns: number[] }
  // STREAM ODA SAHİP (channelId -> userId)
  const streamOdaSahip = new Map();
  // actorId -> timestamps[]
const streamerServerMuteRuntime = new Map();

// server-mute abuse runtime (executorId -> timestamps[])
  const serverMuteAbuseRuntime = new Map();

// store alanları garanti
    store.voiceMutes = store.voiceMutes || {};
    store.penaltyPersist = store.penaltyPersist || {};
    store.penalties = store.penalties || {};
    store.penaltyHistory = store.penaltyHistory || {};
    store.streamerServerMuteAbuse = store.streamerServerMuteAbuse || {};
    store.voiceMutes = store.voiceMutes || {};
    // VMUTE service (voiceStateUpdate attach eder)
  const vmute = setupVmuteService(client, cfg, console);

// =======================
// HELPERS
// =======================
const STREAMER_SERVER_MUTE_ABUSE = {
  windowMs: 24 * 60 * 60 * 1000,
  punishAt: 3,
  punishReason: "Streamer yetkisi ile SERVER VMUTE kötüye kullanım",
};

function getStreamerServerMuteState(staffId) {
  const now = Date.now();
  let s = store.streamerServerMuteAbuse[staffId];

  if (!s || !s.windowStart) {
    s = { windowStart: now, count: 0 };
    store.streamerServerMuteAbuse[staffId] = s;
    return s;
  }

  if (now - s.windowStart >= STREAMER_SERVER_MUTE_ABUSE.windowMs) {
    s.windowStart = now;
    s.count = 0;
    store.streamerServerMuteAbuse[staffId] = s;
  }

  return s;
}

function hasStreamerRole(member) {
  return member?.roles?.cache?.has(cfg.streamerRoleId);
}

async function logMuted(guild, text) {
  if (!cfg.allMutedLogChannelId) return;
  const ch = await guild.channels.fetch(cfg.allMutedLogChannelId).catch(() => null);
  if (ch) ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

function safeText(input, maxLen = 500) {
  const s = String(input ?? "");
  const noPings = s
    .replace(/@/g, "@\u200b")
    .replace(/<@/g, "<\u200b@")
    .replace(/<#/g, "<\u200b#")
    .replace(/<:/g, "<\u200b:")
    .replace(/`/g, "ˋ");
  return noPings.length > maxLen ? noPings.slice(0, maxLen - 3) + "..." : noPings;
}

async function logCezaEmbed(guild, { title, description, fields = [] }) {
  if (!cfg.cezaLogChannelId) return;
  const ch = await guild.channels.fetch(cfg.cezaLogChannelId).catch(() => null);
  if (!ch) return;

  const embed = new EmbedBuilder()
    .setTitle(safeText(title, 120))
    .setDescription(safeText(description, 1500))
    .setTimestamp(new Date());

  const safeFields = (fields || []).slice(0, 10).map((f) => ({
    name: safeText(f?.name, 256) || "Bilgi",
    value: safeText(f?.value, 1024) || "-",
    inline: Boolean(f?.inline),
  }));

  if (safeFields.length) embed.addFields(safeFields);

  ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

function hasStaffPerm(member) {
  return (
    member.roles.cache.has(cfg.staffRoleId) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator)
  );
}

async function setOnlyPenalty(member, penaltyRole, reason = "Cezalı: sadece cezalı kalsın") {
  const rolesToRemove = member.roles.cache.filter(
    (r) => r.id !== member.guild.id && r.id !== penaltyRole.id && r.editable
  );

  if (rolesToRemove.size) {
    await member.roles.remove(rolesToRemove, reason).catch((e) => {
      throw e;
    });
  }

  if (!member.roles.cache.has(penaltyRole.id)) {
    await member.roles.add(penaltyRole, reason).catch((e) => {
      throw e;
    });
  }
}

function hasCommands(member) {
  if (!member) return false;
  if (member.id === cfg.ownerId) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return member.roles.cache.has(cfg.commandsRoleId);
}

// Level: 0 = none, 1..7 = Mod-1..7, 8 = Winner
function getModLevel(member) {
  if (!member) return 0;
  if (member.id === cfg.ownerId) return 999;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return 999;

  if (member.roles.cache.has(cfg.winnerRoleId)) return 8;
  if (member.roles.cache.has(cfg.modRole7Id)) return 7;
  if (member.roles.cache.has(cfg.modRole6Id)) return 6;
  if (member.roles.cache.has(cfg.modRole5Id)) return 5;
  if (member.roles.cache.has(cfg.modRole4Id)) return 4;
  if (member.roles.cache.has(cfg.modRole3Id)) return 3;
  if (member.roles.cache.has(cfg.modRole2Id)) return 2;
  if (member.roles.cache.has(cfg.modRole1Id)) return 1;

  return 0;
}
function isPrivileged(member) {
  if (!member) return false;
  if (member.id === cfg.ownerId) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (hasCommands(member)) return true;
  if (getModLevel(member) > 0) return true;
  return false;
}
async function deny(interaction, msg) {
  const content = `❌ ${msg}`;
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content }).catch(() => {});
  }
  return interaction.reply({ content, ephemeral: true }).catch(() => {});
}

async function requireAccess(interaction, staffMember, minLevel, why = "Yetkin yok.") {
  if (!hasCommands(staffMember)) {
    await deny(interaction, "Bu komut için **Commands** rolü gerekli.");
    return false;
  }
  const lvl = getModLevel(staffMember);
  if (lvl < minLevel) {
    await deny(interaction, `${why} (Gerekli seviye: **${minLevel}**, Sen: **${lvl}**)`);
    return false;
  }
  return true;
}

function backupRoles(member) {
  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id)
    .map((r) => r.id);

  const prev = store.roleBackup[member.id] || { lastRoles: [], history: [] };

  const same = prev.lastRoles.length === roles.length && prev.lastRoles.every((x) => roles.includes(x));

  if (!same) {
    prev.history = prev.history || [];
    prev.history.push({ ts: Date.now(), roles });
    if (prev.history.length > 15) prev.history = prev.history.slice(-15);

    prev.lastRoles = roles;
    store.roleBackup[member.id] = prev;
    saveStore(store);
  }
}

function pushPenaltyHistory(userId, entry) {
  store.penaltyHistory[userId] = store.penaltyHistory[userId] || [];
  store.penaltyHistory[userId].push(entry);
  if (store.penaltyHistory[userId].length > 30) {
    store.penaltyHistory[userId] = store.penaltyHistory[userId].slice(-30);
  }
}

function getCezaLimitState(staffId) {
  const now = Date.now();
  let s = store.cezaLimit[staffId];

  if (!s || !s.windowStart) {
    s = { windowStart: now, count: 0 };
    store.cezaLimit[staffId] = s;
    return s;
  }

  if (now - s.windowStart >= CEZA_LIMIT.windowMs) {
    s.windowStart = now;
    s.count = 0;
    store.cezaLimit[staffId] = s;
  }

  return s;
}

function msToHuman(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}sa ${m}dk`;
  if (m > 0) return `${m}dk ${sec}sn`;
  return `${sec}sn`;
}

// =======================
// SLASH COMMANDS
// =======================
const commands = [
  new SlashCommandBuilder()
    .setName("kayit")
    .setDescription("Kayıt: kullanıcıya erkek/kız rolü verir.")
    .addUserOption((o) => o.setName("uye").setDescription("Kayıt edilecek üye").setRequired(true))
    .addStringOption((o) =>
      o
        .setName("cinsiyet")
        .setDescription("erkek / kiz")
        .setRequired(true)
        .addChoices({ name: "erkek", value: "erkek" }, { name: "kiz", value: "kiz" })
    ),

  new SlashCommandBuilder()
    .setName("ceza")
    .setDescription("Üyeyi süreli cezalı yapar (dakika cinsinden).")
    .addUserOption((o) => o.setName("uye").setDescription("Cezalı olacak üye").setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName("dakika")
        .setDescription("Ceza süresi (dakika)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(60 * 24 * 14)
    )
    .addStringOption((o) => o.setName("sebep").setDescription("Sebep (opsiyonel)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("cezalimit")
    .setDescription("24 saatlik /ceza limitini ve kalan hakkını gösterir."),

  new SlashCommandBuilder()
    .setName("rolbilgi")
    .setDescription("Belirtilen kullanıcının kayıtlı rol geçmişini gösterir (geri vermez).")
    .addUserOption((o) => o.setName("uye").setDescription("Rol bilgisi gösterilecek üye").setRequired(true)),

  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Üyeyi süreli yazılı susturur (Muted rolü).")
    .addUserOption((o) => o.setName("uye").setDescription("Mute olacak üye").setRequired(true))
    .addIntegerOption((o) =>
      o
        .setName("dakika")
        .setDescription("Mute süresi (dakika)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(60 * 24 * 14)
    )
    .addStringOption((o) => o.setName("sebep").setDescription("Sebep (zorunlu)").setRequired(true)),

new SlashCommandBuilder()
  .setName("vmute")
  .setDescription("Üyeyi süreli sesli susturur (VMuted rolü + sunucuda sustur).")
  .addUserOption((o) => o.setName("uye").setDescription("Vmute olacak üye").setRequired(true))
  .addIntegerOption((o) =>
    o
      .setName("dakika")
      .setDescription("Süre (dakika)")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(60 * 24 * 14)
  )
  .addStringOption((o) => o.setName("sebep").setDescription("Sebep (zorunlu)").setRequired(true)),

new SlashCommandBuilder()
  .setName("unvmute")
  .setDescription("Üyenin sesli susturmasını kaldırır (VMuted rolü).")
  .addUserOption((o) => o.setName("uye").setDescription("Vmute kalkacak üye").setRequired(true))
  .addStringOption((o) => o.setName("sebep").setDescription("Sebep (opsiyonel)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("sicil")
    .setDescription("Belirtilen kullanıcının cezalı sebep geçmişini gösterir.")
    .addUserOption((o) => o.setName("uye").setDescription("Sicili görüntülenecek üye").setRequired(true)),

  new SlashCommandBuilder()
    .setName("af")
    .setDescription("Kişinin cezasını affeder (SADECE OWNER).")
    .addUserOption((o) => o.setName("uye").setDescription("Affedilecek üye").setRequired(true))
    .addStringOption((o) => o.setName("sebep").setDescription("Af sebebi (opsiyonel)").setRequired(false)),
].map((c) => c.toJSON());

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(client.user.id, cfg.guildId), { body: commands });
  console.log("[SLASH] Guild commands registered.");
}

// =======================
// SWEEPS (restart-safe)
// =======================
async function penaltySweep() {
  try {
    const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
    if (!guild) return;

    const penaltyRole = await guild.roles.fetch(cfg.penaltyRoleId).catch(() => null);
    const unregRole = await guild.roles.fetch(cfg.unregisteredRoleId).catch(() => null);
    if (!penaltyRole) return;

    const now = Date.now();

    for (const [userId, data] of Object.entries(store.penalties)) {
      if (!data?.endsAt) {
        delete store.penalties[userId];
        continue;
      }
      if (now < data.endsAt) continue;

      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        if (member.roles.cache.has(cfg.penaltyRoleId)) {
          await member.roles.remove(penaltyRole, "Ceza süresi bitti").catch(() => {});
        }
        if (unregRole && !member.roles.cache.has(unregRole.id)) {
          await member.roles.add(unregRole, "Ceza sonrası kayıtsız").catch(() => {});
        }
      }

      delete store.penalties[userId];
      delete store.penaltyPersist[userId]; // süreli ceza bitince persist kalksın
    }

    saveStore(store);
  } catch (e) {
    console.error("[PENALTY] Sweep error:", e);
  }
}

async function muteSweep() {
  try {
    const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
    if (!guild) return;

    const muteRole = await guild.roles.fetch(cfg.mutedRoleId).catch(() => null);
    if (!muteRole) return;

    const now = Date.now();

    // spam-mute sweep
    for (const [userId, data] of Object.entries(store.mutes)) {
      if (!data?.expiresAt) {
        delete store.mutes[userId];
        continue;
      }
      if (now < data.expiresAt) continue;

      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && member.roles.cache.has(muteRole.id)) {
        await member.roles.remove(muteRole, "Mute süresi bitti").catch(() => {});
        await logMuted(guild, `✅ Mute bitti: ${member} (ID: ${userId})`);
      }
      delete store.mutes[userId];
    }
async function vmuteSweep() {
  try {
    const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
    if (!guild) return;

    const vmuteRole = await guild.roles.fetch(cfg.vmuteRoleId).catch(() => null);
    if (!vmuteRole) return;

    const now = Date.now();
    store.voiceMutes = store.voiceMutes || {};

    for (const [userId, data] of Object.entries(store.voiceMutes)) {
      if (!data?.expiresAt) {
        delete store.voiceMutes[userId];
        continue;
      }
      if (now < data.expiresAt) continue;

      const member = await guild.members.fetch(userId).catch(() => null);
     if (member) {
        if (member.roles.cache.has(vmuteRole.id)) {
          await member.roles.remove(vmuteRole, "Vmute süresi bitti").catch(() => {});
        }

        try {
          if (member.voice?.channelId && member.voice.serverMute === true) {
            await member.voice.setMute(false, "Vmute süresi bitti");
          }
        } catch {}
      }

      delete store.voiceMutes[userId];
    }

    saveStore(store);
  } catch (e) {
    console.error("[VMUTE] Sweep error:", e);
  }
}
    // manual mute sweep (/mute)
    store.manualMutes = store.manualMutes || {};
    for (const [userId, data] of Object.entries(store.manualMutes)) {
      if (!data?.expiresAt) {
        delete store.manualMutes[userId];
        continue;
      }
      if (now < data.expiresAt) continue;

      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && member.roles.cache.has(muteRole.id)) {
        await member.roles.remove(muteRole, "Manual mute süresi bitti").catch(() => {});
        await logMuted(guild, `✅ Manual mute bitti: ${member} (ID: ${userId})`);
      }
      delete store.manualMutes[userId];
    }

    saveStore(store);
  } catch (e) {
    console.error("[MUTE] Sweep error:", e);
  }
}

// =======================
// MEMBER EVENTS
// =======================
client.on("guildMemberAdd", async (member) => {
  if (member.guild.id !== cfg.guildId) return;

  // Persist cezalı
  if (store.penaltyPersist?.[member.id]?.active) {
    const penaltyRole = await member.guild.roles.fetch(cfg.penaltyRoleId).catch(() => null);
    if (penaltyRole) {
      await setOnlyPenalty(member, penaltyRole, "Persist: cezalı geri yüklendi (sadece cezalı)").catch(() => {});
    }
  }

  // Persist spam mute
  const sm = store.mutes?.[member.id];
  if (sm?.expiresAt && Date.now() < sm.expiresAt) {
    const muteRole = await member.guild.roles.fetch(cfg.mutedRoleId).catch(() => null);
    if (muteRole && !member.roles.cache.has(muteRole.id)) {
      await member.roles.add(muteRole, "Persist: mute geri yüklendi").catch(() => {});
    }
  }

  // Persist manual mute
  const mm = store.manualMutes?.[member.id];
  if (mm?.expiresAt && Date.now() < mm.expiresAt) {
    const muteRole = await member.guild.roles.fetch(cfg.mutedRoleId).catch(() => null);
    if (muteRole && !member.roles.cache.has(muteRole.id)) {
      await member.roles.add(muteRole, "Persist: manual mute geri yüklendi").catch(() => {});
    }
  }

  backupRoles(member);
});

client.on("guildMemberUpdate", (oldMember, newMember) => {
  if (newMember.guild.id !== cfg.guildId) return;
  if (oldMember.roles.cache.size !== newMember.roles.cache.size) backupRoles(newMember);
});
// =======================
// STREAMER SERVER VMUTE ABUSE (streamOdaSahip logic)
// =======================
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    if (!newState.guild || newState.guild.id !== cfg.guildId) return;

    const guild = newState.guild;

    // =========================
    // streamOdaSahip TRACKING
    // =========================
    const oldCh = oldState.channelId;
    const newCh = newState.channelId;

    // sahip kanaldan çıkarsa / kanal değiştirirse sahiplik sıfırlanır
    if (oldCh && oldCh !== newCh) {
      const sahipId = streamOdaSahip.get(oldCh);
      if (sahipId && sahipId === newState.id) streamOdaSahip.delete(oldCh);
    }
    if (oldCh && !newCh) {
      const sahipId = streamOdaSahip.get(oldCh);
      if (sahipId && sahipId === newState.id) streamOdaSahip.delete(oldCh);
    }

    // kanalda sahip yoksa ilk streaming TRUE olan sahip olur (sonra değişmez)
    if (newCh) {
      if (!streamOdaSahip.has(newCh) && newState.streaming === true) {
        streamOdaSahip.set(newCh, newState.id);
      }
    }

    // =========================
    // SERVER MUTE yakala (false -> true)
    // =========================
    const wasMuted = oldState.serverMute === true;
    const isMuted = newState.serverMute === true;
    if (wasMuted || !isMuted) return;

    const targetMember = newState.member;
    if (!targetMember) return;

    // Audit logdan susturanı bul
    const logs = await guild
      .fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 6 })
      .catch(() => null);
    if (!logs) return;

    const now = Date.now();

    const entry = logs.entries.find((e) => {
      if (!e?.target || e.target.id !== targetMember.id) return false;
      if (now - e.createdTimestamp > 8000) return false; // tolerans
      const changes = e.changes || [];
      return changes.some((c) => c?.key === "mute" && c?.new === true);
    });

    if (!entry?.executorId) return;

    const actorId = entry.executorId;

    // SELF VMUTE sayma
    if (actorId === targetMember.id) return;

    const actorMember = await guild.members.fetch(actorId).catch(() => null);
    if (!actorMember) return;

    // sadece streamer rolü olanlar
    if (!hasStreamerRole(actorMember)) return;

    // ✅ YETKİLİLER MUAF (commands/mod/admin/owner)
    if (isPrivileged(actorMember)) return;

    // actor hangi kanalda? (mute olayı hangi kanalda oldu)
    const chId = newState.channelId;
    const sahipId = chId ? streamOdaSahip.get(chId) : null;
    const isStreamOdaSahip = sahipId && sahipId === actorId;

    // limitler
    const windowMs = isStreamOdaSahip ? 20000 : 5000;
    const limit = isStreamOdaSahip ? 15 : 3;

    // runtime timestamps
    const arr = streamerServerMuteRuntime.get(actorId) || [];
    arr.push(now);
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    streamerServerMuteRuntime.set(actorId, arr);

    if (arr.length < limit) return;

    // cezalıya düşür
    const penaltyRole = await guild.roles.fetch(cfg.penaltyRoleId).catch(() => null);
    if (!penaltyRole) return;

    const why = isStreamOdaSahip
      ? `streamOdaSahip abuse: 20sn içinde ${arr.length}/${limit} sunucuda sustur`
      : `streamer abuse: 5sn içinde ${arr.length}/${limit} sunucuda sustur`;

    await setOnlyPenalty(actorMember, penaltyRole, why);

    const t = Date.now();
    store.penaltyPersist[actorMember.id] = { active: true, since: t, by: "system", reason: why };
    delete store.penalties[actorMember.id];

    pushPenaltyHistory(actorMember.id, {
      ts: t,
      by: "system",
      reason: why,
      minutes: null,
      source: "streamer-server-vmute-abuse",
    });

    saveStore(store);

    await logCezaEmbed(guild, {
      title: "⛔ STREAM ODA ABUSE → CEZALI",
      description: `Yetkili cezalıya düştü`,
      fields: [
        { name: "Kişi", value: `${actorMember.user.tag} (${actorMember.id})`, inline: false },
        { name: "Son hedef", value: `${targetMember.user.tag} (${targetMember.id})`, inline: false },
        { name: "Sebep", value: why, inline: false },
      ],
    });
  } catch (e) {
    console.error("[STREAMER_VMUTE_ABUSE]", e);
  }
});
// =======================
// READY
// =======================
client.on("ready", async () => {
  console.log(`[READY] ${client.user.tag}`);

  try {
    await registerSlashCommands();
  } catch (e) {
    console.error("[SLASH] Register failed:", e);
  }

  await penaltySweep();
  await muteSweep();
  await vmuteSweep();

  // ✅ Bot açılınca seste olan vmuted’ları bir kere mute et
  await vmute.enforceOnReady();

  setInterval(penaltySweep, 30 * 1000);
  setInterval(muteSweep, 30 * 1000);
  setInterval(vmuteSweep, 30 * 1000);
});
// =======================
// INTERACTIONS (QUEUE + DEFER FIX)
// =======================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // hızlı redler (kuyruk dışı)
  if (interaction.guildId !== cfg.guildId) {
    return interaction.reply({ content: "Bu komut bu sunucuda geçerli.", ephemeral: true }).catch(() => {});
  }
  if (interaction.channelId !== cfg.commandsChannelId) {
    return interaction
      .reply({
        content: `❌ Komutlar sadece <#${cfg.commandsChannelId}> kanalında kullanılabilir.`,
        ephemeral: true,
      })
      .catch(() => {});
  }

  // queue gecikmesi yüzünden 3sn timeout olmaması için:
  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  await queue.enqueue(async () => {
    try {
      const staffMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!staffMember) return interaction.editReply({ content: "❌ Yetkili bulunamadı." }).catch(() => {});

      // /cezalimit
      if (interaction.commandName === "cezalimit") {
        if (!(await requireAccess(interaction, staffMember, 1, "Bu komutu kullanamazsın."))) return;

        const st = getCezaLimitState(staffMember.id);
        const now = Date.now();
        const resetIn = msToHuman(CEZA_LIMIT.windowMs - (now - st.windowStart));
        const remainingWarn = Math.max(0, CEZA_LIMIT.warnAt - st.count);
        const remainingPunish = Math.max(0, CEZA_LIMIT.punishAt - st.count);

        return interaction.editReply({
          content:
            `📌 /ceza limit durumu (24 saat)\n` +
            `• Kullanılan: **${st.count}**\n` +
            `• Uyarıya kalan (${CEZA_LIMIT.warnAt}): **${remainingWarn}**\n` +
            `• Kalıcı cezalıya kalan (${CEZA_LIMIT.punishAt}): **${remainingPunish}**\n` +
            `• Reset: **${resetIn}** sonra`,
        });
      }

      // /rolbilgi
      if (interaction.commandName === "rolbilgi") {
        if (!(await requireAccess(interaction, staffMember, 2, "Bu komut için seviye yetersiz."))) return;

        const u = interaction.options.getUser("uye", true);
        const member = await interaction.guild.members.fetch(u.id).catch(() => null);
        const data = store.roleBackup[u.id];

        const currentRoles = member
          ? member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => r.name)
          : [];

        const lastSaved = (data?.lastRoles || []).map(
          (rid) => interaction.guild.roles.cache.get(rid)?.name || `BilinmeyenRol(${rid})`
        );

        const history = (data?.history || [])
          .slice(-5)
          .map((h) => {
            const names = (h.roles || []).map(
              (rid) => interaction.guild.roles.cache.get(rid)?.name || `?(${rid})`
            );
            const when = new Date(h.ts).toLocaleString("tr-TR");
            return `• ${when}: ${names.length ? names.join(", ") : "(boş)"}`;
          });

        const msg =
          `👤 **${safeText(u.tag, 200)}** (ID: ${u.id})\n\n` +
          `**Şu anki roller**:\n${currentRoles.length ? safeText(currentRoles.join(", "), 1800) : "(yok)"}\n\n` +
          `**Kayıtlı son roller (snapshot)**:\n${lastSaved.length ? safeText(lastSaved.join(", "), 1800) : "(yok)"}\n\n` +
          `**Son 5 rol geçmişi**:\n${history.length ? safeText(history.join("\n"), 1800) : "(yok)"}`;

        return interaction.editReply({ content: msg.slice(0, 1900) });
      }

      // /sicil
      if (interaction.commandName === "sicil") {
        if (!(await requireAccess(interaction, staffMember, 2, "Sicil yetkin yok."))) return;

        const u = interaction.options.getUser("uye", true);
        const list = (store.penaltyHistory[u.id] || []).slice(-10);

        const timed = store.penalties?.[u.id];
        const persist = store.penaltyPersist?.[u.id];

        let activeLine = "🟩 Aktif ceza: yok";
        if (persist?.active && !(timed?.endsAt && Date.now() < timed.endsAt)) {
          activeLine = `🟥 Aktif ceza: **KALICI** | Sebep: **${safeText(persist.reason || "Belirtilmedi", 200)}**`;
        } else if (timed?.endsAt && Date.now() < timed.endsAt) {
          activeLine =
            `🟥 Aktif ceza: ${new Date(timed.endsAt).toLocaleString("tr-TR")} bitiş | ` +
            `Sebep: **${safeText(timed.reason || "Yok", 200)}**`;
        }

        const lines = list.map((x) => {
          const when = new Date(x.ts).toLocaleString("tr-TR");
          const by = x.by && x.by !== "system" ? `<@${x.by}>` : "system";
          const min = x.minutes ? `${x.minutes}dk` : "-";
          const src = x.source || "-";
          return `• ${when} | by: ${safeText(by, 80)} | ${min} | ${safeText(src, 20)} | sebep: **${safeText(
            x.reason || "Yok",
            200
          )}**`;
        });

        const msg =
          `📁 **Sicil**: <@${u.id}> (ID: ${u.id})\n` +
          `${activeLine}\n\n` +
          `**Son 10 kayıt:**\n` +
          `${lines.length ? lines.join("\n") : "(kayıt yok)"}`;

        return interaction.editReply({ content: msg.slice(0, 1900) });
      }

      // /af (owner)
      if (interaction.commandName === "af") {
        if (interaction.user.id !== cfg.ownerId) return deny(interaction, "Bu komut sadece owner içindir.");

        const u = interaction.options.getUser("uye", true);
        const reason = safeText(interaction.options.getString("sebep") || "Belirtilmedi", 300);

        const member = await interaction.guild.members.fetch(u.id).catch(() => null);
        if (!member) return deny(interaction, "Üye bulunamadı.");

        const penaltyRole = await interaction.guild.roles.fetch(cfg.penaltyRoleId).catch(() => null);
        const unregRole = await interaction.guild.roles.fetch(cfg.unregisteredRoleId).catch(() => null);

        if (penaltyRole && member.roles.cache.has(penaltyRole.id)) {
          await member.roles.remove(penaltyRole, `AF: ${reason}`).catch(() => {});
        }

        delete store.penaltyPersist[u.id];
        delete store.penalties[u.id];

        if (unregRole && !member.roles.cache.has(unregRole.id)) {
          await member.roles.add(unregRole, "AF sonrası kayıtsız").catch(() => {});
        }

        pushPenaltyHistory(u.id, {
          ts: Date.now(),
          by: interaction.user.id,
          reason: `AF: ${reason}`,
          minutes: null,
          source: "/af",
        });

        saveStore(store);

        await logCezaEmbed(interaction.guild, {
          title: "✅ AF UYGULANDI",
          description: `Owner: ${interaction.user.tag} (ID: ${interaction.user.id})`,
          fields: [
            { name: "Hedef", value: `${u.tag} (ID: ${u.id})`, inline: false },
            { name: "Sebep", value: reason, inline: false },
          ],
        });

        return interaction.editReply({
          content: `✅ <@${u.id}> affedildi. (Cezalı kaldırıldı, persist temizlendi)`,
        });
      }

      // /kayit (public success)
      if (interaction.commandName === "kayit") {
        if (!(await requireAccess(interaction, staffMember, 1, "Kayıt yetkin yok."))) return;

        const target = interaction.options.getUser("uye", true);
        const gender = interaction.options.getString("cinsiyet", true);
        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!targetMember) return deny(interaction, "Üye bulunamadı.");

        if (targetMember.user.bot) return deny(interaction, "Botlara kayıt yapılmaz.");

        const maleRole = await interaction.guild.roles.fetch(cfg.maleRoleId).catch(() => null);
        const femaleRole = await interaction.guild.roles.fetch(cfg.femaleRoleId).catch(() => null);
        const unregRole = await interaction.guild.roles.fetch(cfg.unregisteredRoleId).catch(() => null);

        if (!maleRole || !femaleRole) return deny(interaction, "Rol ID’leri hatalı.");

        if (targetMember.roles.cache.has(cfg.maleRoleId) || targetMember.roles.cache.has(cfg.femaleRoleId)) {
          return deny(interaction, "Bu üye zaten kayıtlı görünüyor.");
        }

        if (unregRole && targetMember.roles.cache.has(unregRole.id)) {
          await targetMember.roles.remove(unregRole, "Kayıt: kayıtsız kaldır").catch(() => {});
        }

        const roleToGive = gender === "erkek" ? maleRole : femaleRole;
        await targetMember.roles.add(roleToGive, "Kayıt komutu").catch(() => {});

        backupRoles(targetMember);

        await interaction.followUp({
          content: `✅ ${targetMember} üyesine **${roleToGive.name}** rolü verildi.`,
          ephemeral: false,
        });

        return interaction.editReply({ content: "✅ İşlem tamamlandı." }).catch(() => {});
      }

      // /mute (manual mute)
      if (interaction.commandName === "mute") {
        if (!(await requireAccess(interaction, staffMember, 2, "Mute yetkin yok."))) return;

        const now = Date.now();
        const target = interaction.options.getUser("uye", true);
        const minutes = interaction.options.getInteger("dakika", true);
        const reason = safeText(interaction.options.getString("sebep", true), 500);

        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!targetMember) return deny(interaction, "Üye bulunamadı.");

        const forbidden =
          targetMember.id === staffMember.id ||
          targetMember.id === cfg.ownerId ||
          targetMember.user.bot ||
          getModLevel(targetMember) > 0;
        if (forbidden) return deny(interaction, "Bu hedefe mute uygulayamazsın.");

        if (targetMember.roles.cache.has(cfg.penaltyRoleId)) {
          return deny(interaction, "Bu üye zaten **cezalı**. Mute uygulanmaz.");
        }

        const muteRole = await interaction.guild.roles.fetch(cfg.mutedRoleId).catch(() => null);
        if (!muteRole) return deny(interaction, "Muted rol ID’si hatalı.");

        const ex = store.manualMutes?.[target.id];
        if (ex?.expiresAt && now < ex.expiresAt) {
          return deny(
            interaction,
            `Bu üye zaten mute.\nBitiş: ${new Date(ex.expiresAt).toLocaleString("tr-TR")}\nSebep: ${safeText(
              ex.reason || "-",
              200
            )}`
          );
        }

        try {
          if (!targetMember.roles.cache.has(muteRole.id)) {
            await targetMember.roles.add(muteRole, `Manual mute: ${minutes}dk | ${reason}`);
          }
        } catch (e) {
          return deny(interaction, "Mute uygulanamadı (Missing Permissions / Role hierarchy).");
        }

        store.manualMutes[target.id] = { expiresAt: now + minutes * 60 * 1000, by: interaction.user.id, reason };
        saveStore(store);

        await logCezaEmbed(interaction.guild, {
          title: "🔇 MUTE UYGULANDI (TEXT)",
          description: `Yetkili: ${staffMember.user.tag} (ID: ${staffMember.id})`,
          fields: [
            { name: "Hedef", value: `${targetMember.user.tag} (ID: ${targetMember.id})`, inline: false },
            { name: "Süre", value: `${minutes} dk`, inline: true },
            { name: "Sebep", value: reason, inline: false },
          ],
        });

        await logMuted(
          interaction.guild,
          `🔇 TEXT MUTE: ${targetMember} | ${minutes}dk | by ${staffMember} | sebep: ${reason}`
        );

        await interaction.followUp({
          content: `🔇 ${targetMember} **${minutes} dakika** mute. Sebep: **${reason}**`,
          ephemeral: false,
        });

        return interaction.editReply({ content: "✅ İşlem tamamlandı." }).catch(() => {});
      }
if (interaction.commandName === "vmute") {
  if (!(await requireAccess(interaction, staffMember, 2, "Vmute yetkin yok."))) return;

  const now = Date.now();
  const target = interaction.options.getUser("uye", true);
  const minutes = interaction.options.getInteger("dakika", true);
  const reason = safeText(interaction.options.getString("sebep", true), 500);

  const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!targetMember) return deny(interaction, "Üye bulunamadı.");

  const forbidden =
    targetMember.id === staffMember.id ||
    targetMember.id === cfg.ownerId ||
    targetMember.user.bot ||
    getModLevel(targetMember) > 0;
  if (forbidden) return deny(interaction, "Bu hedefe vmute uygulayamazsın.");

  const vmuteRole = await interaction.guild.roles.fetch(cfg.vmuteRoleId).catch(() => null);
  if (!vmuteRole) return deny(interaction, "VMuted rol ID’si hatalı.");

  store.voiceMutes = store.voiceMutes || {};
  const ex = store.voiceMutes[target.id];
  if (ex?.expiresAt && now < ex.expiresAt) {
    return deny(
      interaction,
      `Bu üye zaten vmute.\nBitiş: ${new Date(ex.expiresAt).toLocaleString("tr-TR")}\nSebep: ${safeText(
        ex.reason || "-",
        200
      )}`
    );
  }

  try {
    if (!targetMember.roles.cache.has(vmuteRole.id)) {
      await targetMember.roles.add(vmuteRole, `VMUTE: ${minutes}dk | ${reason}`);
    }
  } catch {
    return deny(interaction, "VMuted rolü verilemedi (Missing Permissions / Role hierarchy).");
  }

  store.voiceMutes[target.id] = {
    expiresAt: now + minutes * 60 * 1000,
    by: interaction.user.id,
    reason,
  };
  saveStore(store);

  // seste ise 1 kere server mute dene
  try {
    if (targetMember.voice?.channelId && targetMember.voice.serverMute !== true) {
      await targetMember.voice.setMute(true, `VMUTE: ${minutes}dk | ${reason}`);
    }
  } catch {}

  await logCezaEmbed(interaction.guild, {
    title: "🔇 VMUTE UYGULANDI (VOICE)",
    description: `Yetkili: ${staffMember.user.tag} (ID: ${staffMember.id})`,
    fields: [
      { name: "Hedef", value: `${targetMember.user.tag} (ID: ${targetMember.id})`, inline: false },
      { name: "Süre", value: `${minutes} dk`, inline: true },
      { name: "Sebep", value: reason, inline: false },
    ],
  });
if (interaction.commandName === "unvmute") {
  if (!(await requireAccess(interaction, staffMember, 2, "Unvmute yetkin yok."))) return;

  const target = interaction.options.getUser("uye", true);
  const reason = safeText(interaction.options.getString("sebep") || "Belirtilmedi", 300);

  const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!targetMember) return deny(interaction, "Üye bulunamadı.");

  const vmuteRole = await interaction.guild.roles.fetch(cfg.vmuteRoleId).catch(() => null);
  if (!vmuteRole) return deny(interaction, "VMuted rol ID’si hatalı.");

  try {
    if (targetMember.roles.cache.has(vmuteRole.id)) {
      await targetMember.roles.remove(vmuteRole, `UNVMUTE: ${reason}`);
    }
  } catch {
    return deny(interaction, "VMuted rolü kaldırılamadı (Missing Permissions / Role hierarchy).");
  }

  if (store.voiceMutes?.[target.id]) {
    delete store.voiceMutes[target.id];
    saveStore(store);
  }

  // seste ise unmute dene
  try {
    if (targetMember.voice?.channelId && targetMember.voice.serverMute === true) {
      await targetMember.voice.setMute(false, `UNVMUTE: ${reason}`);
    }
  } catch {}

  await logCezaEmbed(interaction.guild, {
    title: "🔊 VMUTE KALDIRILDI",
    description: `Yetkili: ${staffMember.user.tag} (ID: ${staffMember.id})`,
    fields: [
      { name: "Hedef", value: `${targetMember.user.tag} (ID: ${targetMember.id})`, inline: false },
      { name: "Sebep", value: reason, inline: false },
    ],
  });

  await interaction.followUp({
    content: `🔊 ${targetMember} vmute kaldırıldı. Sebep: **${reason}**`,
    ephemeral: false,
  });

  return interaction.editReply({ content: "✅ İşlem tamamlandı." }).catch(() => {});
}
  await interaction.followUp({
    content: `🔇 ${targetMember} **${minutes} dakika** vmute. Sebep: **${reason}**`,
    ephemeral: false,
  });

  return interaction.editReply({ content: "✅ İşlem tamamlandı." }).catch(() => {});
}
      // /ceza (FINAL UYUMLU)
      if (interaction.commandName === "ceza") {
        if (!(await requireAccess(interaction, staffMember, 4, "Ceza yetkin yok."))) return;

        const now = Date.now();
        const target = interaction.options.getUser("uye", true);
        const minutes = interaction.options.getInteger("dakika", true);
        const reason = safeText(interaction.options.getString("sebep") || "Belirtilmedi", 500);

        const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!targetMember) return deny(interaction, "Üye bulunamadı.");

        const penaltyRole = await interaction.guild.roles.fetch(cfg.penaltyRoleId).catch(() => null);
        if (!penaltyRole) return deny(interaction, "Cezalı rol ID’si hatalı.");

        const forbidden = targetMember.id === cfg.ownerId || targetMember.user.bot || hasStaffPerm(targetMember);

        if (forbidden) {
          const why =
            targetMember.id === cfg.ownerId
              ? "Owner'a ceza denemesi"
              : targetMember.user.bot
              ? "Bot'a ceza denemesi"
              : "Staff'a ceza denemesi";

          try {
            await setOnlyPenalty(staffMember, penaltyRole, CEZA_LIMIT.punishReason);

            store.penaltyPersist[staffMember.id] = {
              active: true,
              since: now,
              by: "system",
              reason: `${CEZA_LIMIT.punishReason} (${why})`,
            };
            delete store.penalties[staffMember.id];

            pushPenaltyHistory(staffMember.id, {
              ts: now,
              by: "system",
              reason: `${CEZA_LIMIT.punishReason} (${why})`,
              minutes: null,
              source: "redline",
            });

            saveStore(store);
          } catch (e) {
            return deny(
              interaction,
              "Kırmızı çizgi ihlali tespit edildi ama bot rol hiyerarşisi yetmediği için sana ceza uygulayamadım.\n" +
                "Çözüm: Bot rolünü moderatör rollerinin üstüne taşı ve botta **Manage Roles** yetkisi olduğundan emin ol."
            );
          }

          await logCezaEmbed(interaction.guild, {
            title: "🚨 KIRMIZI ÇİZGİ İHLALİ",
            description: `Yetkili: ${staffMember.user.tag} (ID: ${staffMember.id})`,
            fields: [
              { name: "Denediği hedef", value: `${targetMember.user.tag} (ID: ${targetMember.id})`, inline: false },
              { name: "Sebep", value: `${CEZA_LIMIT.punishReason} (${why})`, inline: false },
              { name: "Sonuç", value: "Hedefe işlem yapılmadı. Yetkili **kalıcı cezalı** oldu.", inline: false },
            ],
          });

          return deny(interaction, `⛔ Kırmızı çizgi ihlali: **${why}**\nHedefe işlem yok. Sen **kalıcı cezalı** oldun.`);
        }

        const activeTimed = store.penalties?.[target.id];
        const activePersist = store.penaltyPersist?.[target.id];

        const isActiveTimed = activeTimed?.endsAt && now < activeTimed.endsAt;
        const isActivePermanent = activePersist?.active && !isActiveTimed;

        if (isActiveTimed || isActivePermanent || targetMember.roles.cache.has(cfg.penaltyRoleId)) {
          const bitis = isActiveTimed ? new Date(activeTimed.endsAt).toLocaleString("tr-TR") : "KALICI";
          const sebep = (isActiveTimed ? activeTimed?.reason : activePersist?.reason) || "Belirtilmedi";
          return deny(
            interaction,
            `Bu üye zaten cezalı.\nBitiş: **${safeText(bitis, 60)}**\nSebep: **${safeText(sebep, 200)}**`
          );
        }

        const st = getCezaLimitState(staffMember.id);
        st.count = Number(st.count || 0) + 1;
        store.cezaLimit[staffMember.id] = st;

        if (st.count === CEZA_LIMIT.warnAt) {
          await logCezaEmbed(interaction.guild, {
            title: "⚠️ CEZA LIMIT UYARI",
            description: `Yetkili: ${staffMember.user.tag} (ID: ${staffMember.id})`,
            fields: [
              { name: "Sayaç (24s)", value: `${st.count}/${CEZA_LIMIT.punishAt}`, inline: true },
              { name: "Eşik", value: `${CEZA_LIMIT.warnAt} (uyarı)`, inline: true },
            ],
          });
        }

        if (st.count >= CEZA_LIMIT.punishAt) {
          try {
            await setOnlyPenalty(staffMember, penaltyRole, CEZA_LIMIT.punishReason);

            store.penaltyPersist[staffMember.id] = {
              active: true,
              since: now,
              by: "system",
              reason: CEZA_LIMIT.punishReason,
            };
            delete store.penalties[staffMember.id];

            pushPenaltyHistory(staffMember.id, {
              ts: now,
              by: "system",
              reason: CEZA_LIMIT.punishReason,
              minutes: null,
              source: "limit",
            });

            await logCezaEmbed(interaction.guild, {
              title: "⛔ STAFF CEZALI (KALICI)",
              description: `Yetkili: ${staffMember.user.tag} (ID: ${staffMember.id})`,
              fields: [
                { name: "Sayaç (24s)", value: `${st.count}/${CEZA_LIMIT.punishAt}`, inline: true },
                { name: "Sebep", value: CEZA_LIMIT.punishReason, inline: false },
              ],
            });

            st.windowStart = now;
            st.count = 0;
            store.cezaLimit[staffMember.id] = st;

            saveStore(store);
          } catch (e) {
            return deny(
              interaction,
              "Limit aşıldı ama bot rol hiyerarşisi yetmediği için sana ceza uygulayamadım.\n" +
                "Bot rolünü daha yukarı al ve Manage Roles ver."
            );
          }

          return deny(interaction, `⛔ Limit aşıldı. **Kalıcı cezalı** oldun. Sebep: **${CEZA_LIMIT.punishReason}**`);
        }

        try {
          await setOnlyPenalty(targetMember, penaltyRole, `Cezalı: ${minutes} dk | ${reason}`);
        } catch (e) {
          await logCezaEmbed(interaction.guild, {
            title: "❌ CEZA BAŞARISIZ (YETKİ)",
            description: `Yetkili: ${staffMember.user.tag} (ID: ${staffMember.id})`,
            fields: [
              { name: "Hedef", value: `${targetMember.user.tag} (ID: ${targetMember.id})`, inline: false },
              { name: "Hata", value: "Missing Permissions / Role hierarchy", inline: false },
            ],
          });

          return deny(
            interaction,
            "Bu üyeye ceza uygulayamadım (Missing Permissions).\n" +
              "Muhtemel sebep: Hedefin rolü botun rolünden yüksek veya botta **Manage Roles** yok."
          );
        }

        store.penaltyPersist[target.id] = { active: true, since: now, by: interaction.user.id, reason };
        store.penalties[target.id] = { endsAt: now + minutes * 60 * 1000, reason, by: interaction.user.id };

        pushPenaltyHistory(target.id, { ts: now, by: interaction.user.id, reason, minutes, source: "/ceza" });

        await logCezaEmbed(interaction.guild, {
          title: "⛔ CEZA UYGULANDI",
          description: `Yetkili: ${staffMember.user.tag} (ID: ${staffMember.id})`,
          fields: [
            { name: "Hedef", value: `${targetMember.user.tag} (ID: ${targetMember.id})`, inline: false },
            { name: "Süre", value: `${minutes} dk`, inline: true },
            { name: "Sebep", value: reason || "Belirtilmedi", inline: false },
            { name: "24s Sayaç", value: `${st.count}/${CEZA_LIMIT.punishAt}`, inline: true },
          ],
        });

        saveStore(store);

        if (st.count === CEZA_LIMIT.warnAt) {
          await interaction.editReply({
            content:
              `⚠️ Uyarı: Son 24 saatte **${CEZA_LIMIT.warnAt}** kez /ceza kullandın.\n\n` +
              `⛔ ${targetMember} **${minutes} dakika** cezalı yapıldı. Sebep: **${reason}**`,
          });
          return;
        }

        await interaction.followUp({
          content: `⛔ ${targetMember} **${minutes} dakika** cezalı yapıldı. Sebep: **${reason}**`,
          ephemeral: false,
        });

        return interaction.editReply({ content: "✅ İşlem tamamlandı." }).catch(() => {});
      }

      return interaction.editReply({ content: "❌ Bilinmeyen komut." }).catch(() => {});
    } catch (e) {
      console.error("[INTERACTION_HANDLER_ERR]", e);
      return interaction.editReply({ content: "❌ Bir hata oluştu (loglandı)." }).catch(() => {});
    }
  });
});

// =======================
// MESSAGE HANDLING (SPAM)
// =======================
client.on("messageCreate", async (message) => {
  if (!message.guild) return;
  if (message.guild.id !== cfg.guildId) return;
  if (message.author.bot) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  // Staff muaf
  if (hasStaffPerm(member)) return;

  // CEZALI: timeout kapalı
if (member.roles.cache.has(cfg.penaltyRoleId)) {
  return;
}

  // muted ise zaten yazamaması lazım
  if (member.roles.cache.has(cfg.mutedRoleId)) return;

  const now = Date.now();
  const st = spamRuntime.get(member.id) || { msgs: [], warns: [] };

  st.msgs.push(now);
  while (st.msgs.length && now - st.msgs[0] > SPAM.msgWindowMs) st.msgs.shift();

  if (st.msgs.length >= SPAM.msgThreshold) {
    st.msgs = [];
    st.warns.push(now);
    while (st.warns.length && now - st.warns[0] > SPAM.warnWindowMs) st.warns.shift();

    try {
      await message.reply(`⚠️ Spam/Flood uyarı: **${st.warns.length}/${SPAM.warnsToPunish}**`);
    } catch {}

    if (st.warns.length >= SPAM.warnsToPunish) {
      st.warns = [];

      const stage = Number(store.spamStage[member.id] || 0);
      const muteRole = await message.guild.roles.fetch(cfg.mutedRoleId).catch(() => null);
      if (!muteRole) {
        spamRuntime.set(member.id, st);
        return;
      }

      if (stage <= 2) {
        const dur = SPAM.muteStagesMs[stage];

        await member.roles.add(muteRole, "Spam cezası: Muted").catch(() => {});
        store.mutes[member.id] = { expiresAt: now + dur, stage: stage + 1 };
        store.spamStage[member.id] = stage + 1;
        saveStore(store);

        await logMuted(
          message.guild,
          `🔇 MUTED (${Math.round(dur / 60000)}dk) | stage=${stage + 1} | ${member} (ID: ${member.id})`
        );
      } else {
        const penaltyRole = await message.guild.roles.fetch(cfg.penaltyRoleId).catch(() => null);
        if (!penaltyRole) {
          spamRuntime.set(member.id, st);
          return;
        }

        if (member.roles.cache.has(muteRole.id)) {
          await member.roles.remove(muteRole, "Cezalıya yükseltildi").catch(() => {});
        }

        await setOnlyPenalty(member, penaltyRole, "Spam cezası: Cezalı (sadece cezalı kalsın)").catch(() => {});
        store.penaltyPersist[member.id] = { active: true, since: now, by: "system", reason: "Spam escalated" };

        pushPenaltyHistory(member.id, {
          ts: now,
          by: "system",
          reason: "Spam escalated",
          minutes: null,
          source: "spam",
        });

        store.spamStage[member.id] = 0;
        delete store.mutes[member.id];
        saveStore(store);

        await logMuted(message.guild, `⛔ CEZALI (spam escalated) | ${member} (ID: ${member.id})`);
      }
    }

    spamRuntime.set(member.id, st);
  } else {
    spamRuntime.set(member.id, st);
  }
});

} // attachBot end

module.exports = { attachBot };
