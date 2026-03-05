// punish-bot/src/index.js
require("dotenv").config();
const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { cfg, validateEnv } = require("./config");
const { loadStore, saveStore } = require("./store");
const { createQueue } = require("./core/queue"); // ✅ düzeldi
const { attachBot } = require("./bot");

validateEnv(cfg);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

process.on("unhandledRejection", (err) => console.error("[UNHANDLED_REJECTION]", err));
process.on("uncaughtException", (err) => console.error("[UNCAUGHT_EXCEPTION]", err));

const store = loadStore();
const queue = createQueue({ concurrency: 2, minSpacingMs: 2500 });

attachBot({ client, cfg, store, saveStore, queue });

client.login(cfg.token);