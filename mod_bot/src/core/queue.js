function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createQueue({ concurrency = 2, minSpacingMs = 2500 } = {}) {
  let active = 0;
  let lastStart = 0;
  const pending = [];

  async function pump() {
    while (active < concurrency && pending.length) {
      const now = Date.now();
      const wait = Math.max(0, minSpacingMs - (now - lastStart));
      if (wait > 0) await sleep(wait);

      const job = pending.shift();
      active++;
      lastStart = Date.now();

      job.fn()
        .then(job.resolve)
        .catch(job.reject)
        .finally(() => {
          active--;
          pump().catch(() => {});
        });
    }
  }

  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      pending.push({ fn, resolve, reject });
      pump().catch(() => {});
    });
  }

  return { enqueue };
}

module.exports = { createQueue };