const fs = require('fs').promises;
const path = require('path');

async function ls(dirPath) {
  const abs = path.resolve(dirPath);
  const items = await fs.readdir(abs, { withFileTypes: true });
  return items.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory(),
  }));
}

async function mkdir(dirPath) {
  if (!dirPath) throw new Error('path is required');
  await fs.mkdir(path.resolve(dirPath));
}

function resolve(p) {
  return path.resolve(p);
}

module.exports = { ls, mkdir, resolve };
