// punish-bot/src/core/access.js
function getModLevel(member, cfg) {
  if (!member) return cfg.levels.MEMBER;

  const roleIds = new Set(member.roles.cache.map((r) => r.id));

  if (cfg.roles.owner && roleIds.has(cfg.roles.owner)) return cfg.levels.OWNER;
  if (cfg.roles.admin && roleIds.has(cfg.roles.admin)) return cfg.levels.ADMIN;
  if (cfg.roles.mod && roleIds.has(cfg.roles.mod)) return cfg.levels.MOD;
  if (cfg.roles.staff && roleIds.has(cfg.roles.staff)) return cfg.levels.STAFF;

  return cfg.levels.MEMBER;
}

function hasCommands(member, cfg) {
  return getModLevel(member, cfg) >= cfg.levels.STAFF;
}

/**
 * actor: GuildMember
 * target: GuildMember | null
 * action: string (log amaçlı)
 */
function assertCanUse({ actor, target, action }, cfg) {
  const actorLvl = getModLevel(actor, cfg);
  if (actorLvl < cfg.levels.STAFF) {
    throw new Error("Yetkin yok (commands rol zorunlu).");
  }

  if (!target) return;

  if (actor.id === target.id) {
    throw new Error("Kendine işlem yapamazsın.");
  }

  const targetLvl = getModLevel(target, cfg);

  // Owner dokunulmaz (public güvenlik)
  if (cfg.roles.owner && target.roles.cache.has(cfg.roles.owner)) {
    throw new Error("Bu hedef korunuyor (owner).");
  }

  // Eşit/üst yetki hedefe işlem yok
  if (targetLvl >= cfg.levels.STAFF && actorLvl <= targetLvl) {
    throw new Error("Bu hedefe işlem yapamazsın (eşit/üst yetki).");
  }

  // Ek koruma: sunucu owner (guild owner) dokunulmaz
  if (target.guild && target.guild.ownerId === target.id) {
    throw new Error("Sunucu sahibine işlem yapılamaz.");
  }

  // Action bazlı ekstra kural koymak istersen burada
  // örn: ban sadece MOD ve üstü
  if (action === "BAN" && actorLvl < cfg.levels.MOD) {
    throw new Error("Ban için mod seviyesi yetersiz.");
  }
}

module.exports = { getModLevel, hasCommands, assertCanUse };