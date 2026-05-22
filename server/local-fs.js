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

async function rename(oldPath, newPath) {
  if (!oldPath || !newPath) throw new Error('oldPath and newPath are required');
  await fs.rename(path.resolve(oldPath), path.resolve(newPath));
}

async function remove(targetPath) {
  if (!targetPath) throw new Error('path is required');
  await fs.rm(path.resolve(targetPath), { recursive: true, force: false });
}

async function copy(src, dst) {
  if (!src || !dst) throw new Error('src and dst are required');
  await fs.cp(path.resolve(src), path.resolve(dst), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

function resolve(p) {
  return path.resolve(p);
}

module.exports = { ls, mkdir, rename, remove, copy, resolve };
