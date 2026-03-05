const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "penalties.json");

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return {
        penalties: {},
        mutes: {},
        penaltyPersist: {},
        spamStage: {},
        roleBackup: {},
        penaltyHistory: {},
        cezaLimit: {},
        manualMutes: {},
      };
    }
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    return {
      penalties: parsed.penalties || {},
      mutes: parsed.mutes || {},
      penaltyPersist: parsed.penaltyPersist || {},
      spamStage: parsed.spamStage || {},
      roleBackup: parsed.roleBackup || {},
      penaltyHistory: parsed.penaltyHistory || {},
      cezaLimit: parsed.cezaLimit || {},
      manualMutes: parsed.manualMutes || {},
    };
  } catch (e) {
    console.error("[STORE] Load error:", e);
    return {
      penalties: {},
      mutes: {},
      penaltyPersist: {},
      spamStage: {},
      roleBackup: {},
      penaltyHistory: {},
      cezaLimit: {},
      manualMutes: {},
    };
  }
}

function saveStore(store) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  } catch (e) {
    console.error("[STORE] Save error:", e);
  }
}

module.exports = { loadStore, saveStore };