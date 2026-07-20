const fs = require('fs').promises;
const path = require('path');

async function ls(dirPath) {
  const abs = path.resolve(dirPath);
  const items = await fs.readdir(abs, { withFileTypes: true });
  return Promise.all(items.map(async (e) => {
    const entry = { name: e.name, isDirectory: e.isDirectory() };
    try {
      const st = await fs.stat(path.join(abs, e.name));
      entry.size = st.size;
      entry.mtime = Math.floor(st.mtimeMs / 1000);   // epoch seconds (matches sftp attrs.mtime)
    } catch (_) { /* unreadable entry (perm / dangling symlink) — leave size/mtime undefined */ }
    return entry;
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

// Resolve a path and classify it. `dir` is where a caller should navigate to:
// the path itself if it's a directory, else its parent. `name` is the basename
// when it's a file (for selection), else ''. Follows symlinks.
async function statPath(p) {
  const abs = path.resolve(p);
  const st = await fs.stat(abs);
  const isDirectory = st.isDirectory();
  return {
    path: abs,
    isDirectory,
    dir: isDirectory ? abs : path.dirname(abs),
    name: isDirectory ? '' : path.basename(abs),
  };
}

module.exports = { ls, mkdir, rename, remove, copy, resolve, statPath };
