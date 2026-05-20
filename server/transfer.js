const EventEmitter = require('events');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sessions = require('./ssh-session');

const jobs = new Map();
const PROGRESS_INTERVAL_MS = 100;

// ---- POSIX path helpers (remote paths are always POSIX) ----
function posixJoin(a, b) {
  if (!a || a === '/') return '/' + b.replace(/^\/+/, '');
  return a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, '');
}
function posixDirname(p) {
  if (!p || p === '/' || p === '') return '/';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}
function posixBasename(p) {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

// ---- SFTP promise wrappers ----
function sftpStat(sftp, p) {
  return new Promise((resolve) => sftp.stat(p, (err, attrs) => resolve(err ? null : attrs)));
}
function sftpMkdir(sftp, p) {
  return new Promise((resolve, reject) => sftp.mkdir(p, (err) => (err ? reject(err) : resolve())));
}
function sftpReaddir(sftp, p) {
  return new Promise((resolve, reject) => sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list))));
}
async function sftpEnsureDir(sftp, dir) {
  if (!dir || dir === '/') return;
  const existing = await sftpStat(sftp, dir);
  if (existing && existing.isDirectory()) return;
  const parent = posixDirname(dir);
  if (parent && parent !== dir) await sftpEnsureDir(sftp, parent);
  try {
    await sftpMkdir(sftp, dir);
  } catch (err) {
    const recheck = await sftpStat(sftp, dir);
    if (!recheck || !recheck.isDirectory()) throw err;
  }
}

// ---- Directory walkers ----
async function walkLocal(root) {
  const out = [];
  const stat = await fsp.stat(root);
  if (stat.isFile()) return [{ path: root, size: stat.size, relDirs: [] }];
  async function rec(dir) {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) await rec(p);
      else if (it.isFile()) {
        const s = await fsp.stat(p);
        out.push({ path: p, size: s.size });
      }
    }
  }
  await rec(root);
  return out;
}

async function walkRemote(sftp, root) {
  const out = [];
  const stat = await sftpStat(sftp, root);
  if (!stat) throw new Error('remote source not found: ' + root);
  if (stat.isFile()) return [{ path: root, size: stat.size }];
  async function rec(dir) {
    const items = await sftpReaddir(sftp, dir);
    for (const it of items) {
      const p = posixJoin(dir, it.filename);
      if (it.attrs.isDirectory()) await rec(p);
      else out.push({ path: p, size: it.attrs.size });
    }
  }
  await rec(root);
  return out;
}

// ---- Job lifecycle ----
function snapshot(job) {
  return {
    id: job.id,
    status: job.status,
    direction: job.direction,
    src: job.src,
    dst: job.dst,
    totalBytes: job.totalBytes,
    transferredBytes: job.transferredBytes,
    totalFiles: job.totalFiles,
    doneFiles: job.doneFiles,
    currentFile: job.currentFile,
    error: job.error,
  };
}

function emitProgress(job, force) {
  const now = Date.now();
  if (!force && now - job._lastEmit < PROGRESS_INTERVAL_MS) return;
  job._lastEmit = now;
  job.events.emit('progress', snapshot(job));
}

function complete(job, kind, payload) {
  job.status = kind === 'done' ? 'done' : 'error';
  if (kind === 'error') job.error = payload.message;
  emitProgress(job, true);
  job.events.emit(kind, payload);
  setTimeout(() => jobs.delete(job.id), 30_000);
}

function create(spec) {
  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id,
    direction: spec.direction,           // 'upload' | 'download'
    sessionId: spec.sessionId,
    src: spec.src,                       // upload: local abs path / download: remote path
    dst: spec.dst,                       // final destination path (parent dir + basename of src)
    status: 'pending',
    totalBytes: 0,
    transferredBytes: 0,
    totalFiles: 0,
    doneFiles: 0,
    currentFile: '',
    error: null,
    events: new EventEmitter(),
    _lastEmit: 0,
  };
  job.events.setMaxListeners(20);
  jobs.set(id, job);
  return job;
}

function get(id) {
  return jobs.get(id);
}

// ---- Transfer drivers ----
function putFile(sftp, localPath, remotePath, job) {
  return new Promise((resolve, reject) => {
    job.currentFile = posixBasename(remotePath);
    let prev = 0;
    sftp.fastPut(localPath, remotePath, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        prev = transferred;
        emitProgress(job);
      },
    }, (err) => (err ? reject(err) : resolve()));
  });
}

function getFile(sftp, remotePath, localPath, job) {
  return new Promise((resolve, reject) => {
    job.currentFile = posixBasename(remotePath);
    let prev = 0;
    sftp.fastGet(remotePath, localPath, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        prev = transferred;
        emitProgress(job);
      },
    }, (err) => (err ? reject(err) : resolve()));
  });
}

async function runUpload(job) {
  const { sftp } = sessions.get(job.sessionId);
  job.status = 'running';
  emitProgress(job, true);

  const stat = await fsp.stat(job.src);
  if (stat.isFile()) {
    job.totalFiles = 1;
    job.totalBytes = stat.size;
    await sftpEnsureDir(sftp, posixDirname(job.dst));
    await putFile(sftp, job.src, job.dst, job);
    job.doneFiles = 1;
  } else {
    const files = await walkLocal(job.src);
    job.totalFiles = files.length;
    job.totalBytes = files.reduce((s, f) => s + f.size, 0);
    await sftpEnsureDir(sftp, job.dst);
    for (const f of files) {
      const rel = path.relative(job.src, f.path).split(path.sep).join('/');
      const remotePath = posixJoin(job.dst, rel);
      await sftpEnsureDir(sftp, posixDirname(remotePath));
      await putFile(sftp, f.path, remotePath, job);
      job.doneFiles++;
      emitProgress(job, true);
    }
  }
}

async function runDownload(job) {
  const { sftp } = sessions.get(job.sessionId);
  job.status = 'running';
  emitProgress(job, true);

  const stat = await sftpStat(sftp, job.src);
  if (!stat) throw new Error('remote source not found: ' + job.src);

  if (stat.isFile()) {
    job.totalFiles = 1;
    job.totalBytes = stat.size;
    await fsp.mkdir(path.dirname(job.dst), { recursive: true });
    await getFile(sftp, job.src, job.dst, job);
    job.doneFiles = 1;
  } else {
    const files = await walkRemote(sftp, job.src);
    job.totalFiles = files.length;
    job.totalBytes = files.reduce((s, f) => s + f.size, 0);
    await fsp.mkdir(job.dst, { recursive: true });
    for (const f of files) {
      const rel = f.path.startsWith(job.src + '/')
        ? f.path.slice(job.src.length + 1)
        : posixBasename(f.path);
      const localPath = path.join(job.dst, rel.split('/').join(path.sep));
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      await getFile(sftp, f.path, localPath, job);
      job.doneFiles++;
      emitProgress(job, true);
    }
  }
}

async function start(job) {
  try {
    if (job.direction === 'upload') await runUpload(job);
    else if (job.direction === 'download') await runDownload(job);
    else throw new Error('unknown direction: ' + job.direction);
    complete(job, 'done', { ok: true });
  } catch (err) {
    complete(job, 'error', { message: err.message });
  }
}

module.exports = { create, get, start, snapshot };
