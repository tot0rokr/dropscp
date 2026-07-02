const { loadConfig, saveConfig } = require('./config');

function list() {
  const cfg = loadConfig();
  return cfg.presets || [];
}

function upsert({ name, username, host, port }) {
  if (!name || !username || !host) {
    throw new Error('name, username, and host are required');
  }
  const cfg = loadConfig();
  const cleaned = (cfg.presets || []).filter((p) => p.name !== name);
  cleaned.push({
    name: String(name),
    username: String(username),
    host: String(host),
    port: Number(port) || 22,
  });
  cleaned.sort((a, b) => a.name.localeCompare(b.name));
  cfg.presets = cleaned;
  saveConfig(cfg);
  return cfg.presets;
}

function remove(name) {
  if (!name) throw new Error('name is required');
  const cfg = loadConfig();
  cfg.presets = (cfg.presets || []).filter((p) => p.name !== name);
  saveConfig(cfg);
  return cfg.presets;
}

function rename({ name, newName }) {
  if (!name || !newName) throw new Error('name and newName are required');
  const nextName = String(newName).trim();
  if (!nextName) throw new Error('newName is required');
  const cfg = loadConfig();
  const list = cfg.presets || [];
  const target = list.find((p) => p.name === name);
  if (!target) throw new Error(`preset "${name}" not found`);
  if (nextName !== name && list.some((p) => p.name === nextName)) {
    throw new Error(`a preset named "${nextName}" already exists`);
  }
  target.name = nextName;
  list.sort((a, b) => a.name.localeCompare(b.name));
  cfg.presets = list;
  saveConfig(cfg);
  return cfg.presets;
}

module.exports = { list, upsert, remove, rename };
