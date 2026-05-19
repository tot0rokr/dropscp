const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.DROPSCP_CONFIG_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'dropscp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  version: 1,
  server: { port: 8765, bindHost: '127.0.0.1' },
  presets: [],
  ui: { lastLocalPath: os.homedir() },
};

function loadConfig() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      server: { ...DEFAULT_CONFIG.server, ...(parsed.server || {}) },
      ui: { ...DEFAULT_CONFIG.ui, ...(parsed.ui || {}) },
    };
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

module.exports = { loadConfig, saveConfig, CONFIG_FILE, CONFIG_DIR };
