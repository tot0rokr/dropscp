const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const sessions = require('./ssh-session');

const jobs = new Map();
const PROGRESS_INTERVAL_MS = 100;

// ---- POSIX path helpers (remote paths) ----
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

// ---- Directory walkers (caller has already verified input is a directory) ----
async function walkLocalDir(root) {
  const out = [];
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

async function walkRemoteDir(sftp, root) {
  const out = [];
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
    totalBytes: job.totalBytes,
    transferredBytes: job.transferredBytes,
    totalFiles: job.totalFiles,
    doneFiles: job.doneFiles,
    currentFiles: Array.from(job.currentFiles),
    currentFile: job.currentFiles.values().next().value || '',
    errors: job.errors.slice(),
    workers: job.workers,
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
  // kind is 'done' or 'fail'. We never emit Node's special 'error' event
  // because an unhandled emit on 'error' crashes the process when no SSE
  // consumer is attached yet.
  job.status = kind === 'done' ? 'done' : 'error';
  if (kind === 'fail') job.error = payload.message;
  emitProgress(job, true);
  job.events.emit(kind, payload);
  setTimeout(() => jobs.delete(job.id), 30_000);
}

function create({ direction, sessionId, items, workers }) {
  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id,
    direction,                     // 'upload' | 'download'
    sessionId,
    items: items.slice(),          // [{ src, dst }, ...] — dst is the FINAL path (includes basename)
    workers: Math.max(1, Math.floor(workers) || 1),
    status: 'pending',
    totalBytes: 0,
    transferredBytes: 0,
    totalFiles: 0,
    doneFiles: 0,
    currentFiles: new Set(),       // active leaf paths across workers
    errors: [],                    // [{ src, message }]
    error: null,                   // fatal batch-level error
    events: new EventEmitter(),
    _lastEmit: 0,
  };
  job.events.setMaxListeners(40);
  jobs.set(id, job);
  return job;
}

function get(id) {
  return jobs.get(id);
}

// ---- File-level transfer drivers ----
function putFile(sftp, leaf, job) {
  return new Promise((resolve, reject) => {
    job.currentFiles.add(leaf.dst);
    let prev = 0;
    sftp.fastPut(leaf.src, leaf.dst, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        prev = transferred;
        emitProgress(job);
      },
    }, (err) => {
      job.currentFiles.delete(leaf.dst);
      if (err) reject(err); else resolve();
    });
  });
}

function getFile(sftp, leaf, job) {
  return new Promise((resolve, reject) => {
    job.currentFiles.add(leaf.src);
    let prev = 0;
    sftp.fastGet(leaf.src, leaf.dst, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        prev = transferred;
        emitProgress(job);
      },
    }, (err) => {
      job.currentFiles.delete(leaf.src);
      if (err) reject(err); else resolve();
    });
  });
}

// ---- Planning: expand items[] into leaf-file jobs and pre-create dest dirs ----
async function planUpload(job, sftp) {
  const leaves = [];
  for (const it of job.items) {
    let stat;
    try { stat = await fsp.stat(it.src); }
    catch (err) { job.errors.push({ src: it.src, message: 'stat failed: ' + err.message }); continue; }
    if (stat.isFile()) {
      leaves.push({ src: it.src, dst: it.dst, size: stat.size });
    } else if (stat.isDirectory()) {
      let files;
      try { files = await walkLocalDir(it.src); }
      catch (err) { job.errors.push({ src: it.src, message: 'walk failed: ' + err.message }); continue; }
      for (const f of files) {
        const rel = path.relative(it.src, f.path).split(path.sep).join('/');
        const remotePath = rel ? posixJoin(it.dst, rel) : it.dst;
        leaves.push({ src: f.path, dst: remotePath, size: f.size });
      }
    }
  }
  const dirs = new Set();
  for (const l of leaves) dirs.add(posixDirname(l.dst));
  for (const d of dirs) {
    try { await sftpEnsureDir(sftp, d); }
    catch (_) { /* surfaced per-leaf during putFile */ }
  }
  return leaves;
}

async function planDownload(job, sftp) {
  const leaves = [];
  for (const it of job.items) {
    const stat = await sftpStat(sftp, it.src);
    if (!stat) { job.errors.push({ src: it.src, message: 'remote not found' }); continue; }
    if (stat.isFile()) {
      leaves.push({ src: it.src, dst: it.dst, size: stat.size });
    } else if (stat.isDirectory()) {
      let files;
      try { files = await walkRemoteDir(sftp, it.src); }
      catch (err) { job.errors.push({ src: it.src, message: 'walk failed: ' + err.message }); continue; }
      for (const f of files) {
        const rel = f.path.startsWith(it.src + '/')
          ? f.path.slice(it.src.length + 1)
          : posixBasename(f.path);
        const localPath = path.join(it.dst, rel.split('/').join(path.sep));
        leaves.push({ src: f.path, dst: localPath, size: f.size });
      }
    }
  }
  const dirs = new Set();
  for (const l of leaves) dirs.add(path.dirname(l.dst));
  for (const d of dirs) {
    try { await fsp.mkdir(d, { recursive: true }); }
    catch (_) { /* surfaced per-leaf during getFile */ }
  }
  return leaves;
}

// ---- Batch driver ----
async function start(job) {
  try {
    job.status = 'running';
    emitProgress(job, true);

    const channels = await sessions.acquireSftpPool(job.sessionId, job.workers);
    if (!channels.length) throw new Error('no SFTP channels available');
    job.workers = channels.length;

    const leaves = (job.direction === 'upload')
      ? await planUpload(job, channels[0])
      : await planDownload(job, channels[0]);

    job.totalFiles = leaves.length;
    job.totalBytes = leaves.reduce((s, l) => s + (l.size || 0), 0);
    emitProgress(job, true);

    if (leaves.length === 0) {
      complete(job, 'done', { ok: true, errors: job.errors });
      return;
    }

    let idx = 0;
    const transferOne = (job.direction === 'upload') ? putFile : getFile;

    async function worker(sftp) {
      while (true) {
        const i = idx++;
        if (i >= leaves.length) return;
        const leaf = leaves[i];
        try {
          await transferOne(sftp, leaf, job);
        } catch (err) {
          job.errors.push({ src: leaf.src, message: err.message });
        }
        job.doneFiles++;
        emitProgress(job, true);
      }
    }

    // Don't spin up more workers than there's work for
    const activeChannels = channels.slice(0, Math.min(channels.length, leaves.length));
    await Promise.all(activeChannels.map((sftp) => worker(sftp)));

    complete(job, 'done', { ok: true, errors: job.errors });
  } catch (err) {
    complete(job, 'fail', { message: err.message });
  }
}

module.exports = { create, get, start, snapshot };
