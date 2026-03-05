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

module.exports = { safeText };