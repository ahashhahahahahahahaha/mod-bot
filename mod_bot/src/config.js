require("dotenv").config();

const SPAM = {
  msgWindowMs: 4 * 1000,
  msgThreshold: 5,
  warnWindowMs: 2 * 60 * 1000,
  warnsToPunish: 3,
  muteStagesMs: [5 * 60 * 1000, 15 * 60 * 1000, 90 * 60 * 1000],
};

const TEN_HOURS = 10 * 60 * 60 * 1000;

const CEZA_LIMIT = {
  windowMs: 24 * 60 * 60 * 1000,
  warnAt: 15,
  punishAt: 30,
  punishReason: "Yetkiyi kötüye kullanım",
};

const cfg = {
  token: process.env.TOKEN,
guildId: process.env.GUILD_ID,

vmuteRoleId: process.env.VMUTE_ROLE_ID ?? "1476334909957214380",
vmuteCooldownSec: Number(process.env.VMUTE_COOLDOWN_SEC ?? 20),

// (opsiyonel) botun kaç saniyede bir aynı kanalda tekrar mute denemesini engellesin
vmuteCooldownSec: Number(process.env.VMUTE_COOLDOWN_SEC ?? 20),

  ownerId: process.env.OWNER_ID,
  commandsChannelId: process.env.BOT_COMMANDS_CHANNEL_ID,

  staffRoleId: process.env.REGISTER_STAFF_ROLE_ID,

  mutedRoleId: process.env.MUTED_ROLE_ID,
  allMutedLogChannelId: process.env.ALL_MUTED_LOG_CHANNEL_ID || null,

  maleRoleId: process.env.ROLE_MALE_ID,
  femaleRoleId: process.env.ROLE_FEMALE_ID,

  penaltyRoleId: process.env.PENALTY_ROLE_ID,
  penaltyChannelId: process.env.PENALTY_CHANNEL_ID,

  unregisteredRoleId: process.env.ROLE_UNREGISTERED_ID,

  commandsRoleId: process.env.COMMANDS_ROLE_ID,

  modRole1Id: process.env.MOD_ROLE_1_ID,
  modRole2Id: process.env.MOD_ROLE_2_ID,
  modRole3Id: process.env.MOD_ROLE_3_ID,
  modRole4Id: process.env.MOD_ROLE_4_ID,
  modRole5Id: process.env.MOD_ROLE_5_ID,
  modRole6Id: process.env.MOD_ROLE_6_ID,
  modRole7Id: process.env.MOD_ROLE_7_ID,
  winnerRoleId: process.env.WINNER_ROLE_ID,

  cezaLogChannelId: process.env.CEZA_LOG_CHANNEL_ID || null,
};

function validateEnv(cfgObj) {
  const must = (v, name) => {
    if (!v) {
      console.error(`[CONFIG] Missing ${name} in .env`);
      process.exit(1);
    }
  };

  [
    "token",
    "guildId",
    "ownerId",
    "commandsChannelId",
    "staffRoleId",
    "maleRoleId",
    "femaleRoleId",
    "penaltyRoleId",
    "penaltyChannelId",
    "unregisteredRoleId",
    "mutedRoleId",
    "commandsRoleId",
    "modRole1Id",
    "modRole2Id",
    "modRole3Id",
    "modRole4Id",
    "modRole5Id",
    "modRole6Id",
    "modRole7Id",
    "winnerRoleId",
    "vmuteRoleId",
  ].forEach((k) => must(cfgObj[k], k));

  if (cfgObj.staffRoleId === cfgObj.unregisteredRoleId) {
  console.error("[CONFIG] STAFF ile UNREGISTERED aynı olamaz. .env düzelt.");
  process.exit(1);
}
}

module.exports = { cfg, validateEnv, SPAM, TEN_HOURS, CEZA_LIMIT };