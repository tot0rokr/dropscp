const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.DROPSCP_CONFIG_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'dropscp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const WORKERS_MAX = 10;
const WORKERS_MIN = 1;

const DEFAULT_CONFIG = {
  version: 1,
  server: { port: 8765, bindHost: '127.0.0.1' },
  transfer: { workers: 10 },
  presets: [],
  ui: { lastLocalPath: os.homedir() },
};

function clampWorkers(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_CONFIG.transfer.workers;
  return Math.max(WORKERS_MIN, Math.min(WORKERS_MAX, v));
}

function loadConfig() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_CONFIG,
      ...parsed,
      server: { ...DEFAULT_CONFIG.server, ...(parsed.server || {}) },
      transfer: { ...DEFAULT_CONFIG.transfer, ...(parsed.transfer || {}) },
      ui: { ...DEFAULT_CONFIG.ui, ...(parsed.ui || {}) },
    };
    merged.transfer.workers = clampWorkers(merged.transfer.workers);
    return merged;
  } catch (err) {
    try { fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak'); } catch (_) {}
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

module.exports = { loadConfig, saveConfig, clampWorkers, WORKERS_MAX, WORKERS_MIN, CONFIG_FILE, CONFIG_DIR };
