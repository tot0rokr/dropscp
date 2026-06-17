const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');

// One completed transfer job per line (JSON). Kept in the config dir but in its
// own file so log growth never touches config.json reads/writes.
const LOG_FILE = path.join(CONFIG_DIR, 'transfer-log.jsonl');
const MAX_RECORDS = 1000;   // oldest records past this are dropped on append

// Read all parseable records (oldest first). Missing file -> [].
function readAll() {
  let raw;
  try {
    raw = fs.readFileSync(LOG_FILE, 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch (_) { /* skip bad line */ }
  }
  return out;
}

function writeAll(records) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  const tmp = LOG_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, LOG_FILE);
}

// Concurrent job completions can land at the same time; serialize file rewrites
// through a promise chain so they never clobber each other. Logging failures are
// swallowed — a broken log must never break a transfer.
let writeChain = Promise.resolve();
function append(record) {
  writeChain = writeChain.then(() => {
    try {
      const records = readAll();
      records.push(record);
      const trimmed = records.length > MAX_RECORDS
        ? records.slice(records.length - MAX_RECORDS)
        : records;
      writeAll(trimmed);
    } catch (_) { /* best-effort */ }
  });
  return writeChain;
}

// Most recent first, capped at `limit`.
function list(limit = 200) {
  const all = readAll();
  const n = Math.max(1, Math.floor(limit) || 200);
  return all.slice(Math.max(0, all.length - n)).reverse();
}

function clear() {
  try { fs.rmSync(LOG_FILE, { force: true }); } catch (_) {}
  try { fs.rmSync(LOG_FILE + '.tmp', { force: true }); } catch (_) {}
}

module.exports = { append, list, clear, LOG_FILE };
