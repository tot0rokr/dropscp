const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
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
    leaves: job.leaves.map((l) => ({
      id: l.id,
      name: l.name,
      size: l.size,
      transferred: l.transferred,
      status: l.status,
      error: l.error,
      phase: l.phase,
    })),
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

function create({ direction, sessionId, dstSessionId, items, workers }) {
  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id,
    direction,                     // 'upload' | 'download' | 'r2r'
    sessionId,                     // src session for r2r, the only session for up/down
    dstSessionId,                  // r2r only: destination session
    items: items.slice(),          // [{ src, dst }, ...] — dst is the FINAL path (includes basename)
    workers: Math.max(1, Math.floor(workers) || 1),
    status: 'pending',
    totalBytes: 0,
    transferredBytes: 0,
    totalFiles: 0,
    doneFiles: 0,
    leaves: [],                    // [{ id, name, src, dst, size, transferred, status, error }]
    errors: [],                    // planning-stage errors (no leaf exists)
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
    leaf.status = 'active';
    leaf.transferred = 0;
    let prev = 0;
    sftp.fastPut(leaf.src, leaf.dst, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        leaf.transferred = transferred;
        prev = transferred;
        emitProgress(job);
      },
    }, (err) => {
      if (err) {
        leaf.status = 'error';
        leaf.error = err.message;
        reject(err);
      } else {
        leaf.status = 'done';
        leaf.transferred = leaf.size;
        resolve();
      }
    });
  });
}

function getFile(sftp, leaf, job) {
  return new Promise((resolve, reject) => {
    leaf.status = 'active';
    leaf.transferred = 0;
    let prev = 0;
    sftp.fastGet(leaf.src, leaf.dst, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        leaf.transferred = transferred;
        prev = transferred;
        emitProgress(job);
      },
    }, (err) => {
      if (err) {
        leaf.status = 'error';
        leaf.error = err.message;
        reject(err);
      } else {
        leaf.status = 'done';
        leaf.transferred = leaf.size;
        resolve();
      }
    });
  });
}

function pushLeaf(job, leaf) {
  job.leaves.push({
    id: job.leaves.length,
    name: leaf.name,
    src: leaf.src,
    dst: leaf.dst,
    size: leaf.size,
    transferred: 0,
    status: 'waiting',
    error: null,
  });
}

// ---- Planning: expand items[] into leaf-file jobs and pre-create dest dirs ----
async function planUpload(job, sftp) {
  for (const it of job.items) {
    let stat;
    try { stat = await fsp.stat(it.src); }
    catch (err) { job.errors.push({ src: it.src, message: 'stat failed: ' + err.message }); continue; }
    if (stat.isFile()) {
      pushLeaf(job, { src: it.src, dst: it.dst, size: stat.size, name: posixBasename(it.dst.replace(/\\/g, '/')) });
    } else if (stat.isDirectory()) {
      let files;
      try { files = await walkLocalDir(it.src); }
      catch (err) { job.errors.push({ src: it.src, message: 'walk failed: ' + err.message }); continue; }
      for (const f of files) {
        const rel = path.relative(it.src, f.path).split(path.sep).join('/');
        const remotePath = rel ? posixJoin(it.dst, rel) : it.dst;
        pushLeaf(job, { src: f.path, dst: remotePath, size: f.size, name: posixBasename(remotePath) });
      }
    }
  }
  const dirs = new Set();
  for (const l of job.leaves) dirs.add(posixDirname(l.dst));
  for (const d of dirs) {
    try { await sftpEnsureDir(sftp, d); }
    catch (_) { /* surfaced per-leaf during putFile */ }
  }
}

async function planDownload(job, sftp) {
  for (const it of job.items) {
    const stat = await sftpStat(sftp, it.src);
    if (!stat) { job.errors.push({ src: it.src, message: 'remote not found' }); continue; }
    if (stat.isFile()) {
      pushLeaf(job, { src: it.src, dst: it.dst, size: stat.size, name: posixBasename(it.src) });
    } else if (stat.isDirectory()) {
      let files;
      try { files = await walkRemoteDir(sftp, it.src); }
      catch (err) { job.errors.push({ src: it.src, message: 'walk failed: ' + err.message }); continue; }
      for (const f of files) {
        const rel = f.path.startsWith(it.src + '/')
          ? f.path.slice(it.src.length + 1)
          : posixBasename(f.path);
        const localPath = path.join(it.dst, rel.split('/').join(path.sep));
        pushLeaf(job, { src: f.path, dst: localPath, size: f.size, name: posixBasename(f.path) });
      }
    }
  }
  const dirs = new Set();
  for (const l of job.leaves) dirs.add(path.dirname(l.dst));
  for (const d of dirs) {
    try { await fsp.mkdir(d, { recursive: true }); }
    catch (_) { /* surfaced per-leaf during getFile */ }
  }
}

// ---- R2R: planning + relay driver ----
async function planR2R(job, srcSftp, dstSftp) {
  for (const it of job.items) {
    const stat = await sftpStat(srcSftp, it.src);
    if (!stat) { job.errors.push({ src: it.src, message: 'remote not found' }); continue; }
    if (stat.isFile()) {
      pushLeaf(job, { src: it.src, dst: it.dst, size: stat.size, name: posixBasename(it.src) });
    } else if (stat.isDirectory()) {
      let files;
      try { files = await walkRemoteDir(srcSftp, it.src); }
      catch (err) { job.errors.push({ src: it.src, message: 'walk failed: ' + err.message }); continue; }
      for (const f of files) {
        const rel = f.path.startsWith(it.src + '/')
          ? f.path.slice(it.src.length + 1)
          : posixBasename(f.path);
        const remoteDst = rel ? posixJoin(it.dst, rel) : it.dst;
        pushLeaf(job, { src: f.path, dst: remoteDst, size: f.size, name: posixBasename(f.path) });
      }
    }
  }
  const dirs = new Set();
  for (const l of job.leaves) dirs.add(posixDirname(l.dst));
  for (const d of dirs) {
    try { await sftpEnsureDir(dstSftp, d); }
    catch (_) { /* surfaced per-leaf during upload phase */ }
  }
}

// Relay one leaf: src(SFTP) → local temp → dst(SFTP). Cleans up its temp file.
function relayLeafTransfer(srcSftp, dstSftp, leaf, tempPath, job) {
  return new Promise((resolve, reject) => {
    leaf.status = 'active';
    leaf.transferred = 0;
    leaf.phase = 'download';
    let prev = 0;

    srcSftp.fastGet(leaf.src, tempPath, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        leaf.transferred = transferred;
        prev = transferred;
        emitProgress(job);
      },
    }, (downErr) => {
      if (downErr) {
        leaf.status = 'error';
        leaf.error = 'download: ' + downErr.message;
        fsp.unlink(tempPath).catch(() => {});
        return reject(downErr);
      }
      // Phase 2: upload from local temp to dst
      leaf.phase = 'upload';
      leaf.transferred = 0;
      prev = 0;
      dstSftp.fastPut(tempPath, leaf.dst, {
        step: (transferred) => {
          job.transferredBytes += (transferred - prev);
          leaf.transferred = transferred;
          prev = transferred;
          emitProgress(job);
        },
      }, (upErr) => {
        // Always try to delete temp, even on success
        fsp.unlink(tempPath).catch(() => {});
        if (upErr) {
          leaf.status = 'error';
          leaf.error = 'upload: ' + upErr.message;
          return reject(upErr);
        }
        leaf.status = 'done';
        leaf.transferred = leaf.size;
        resolve();
      });
    });
  });
}

// ---- Batch drivers ----
async function startUpDown(job) {
  const channels = await sessions.acquireSftpPool(job.sessionId, job.workers);
  if (!channels.length) throw new Error('no SFTP channels available');
  job.workers = channels.length;

  if (job.direction === 'upload') await planUpload(job, channels[0]);
  else await planDownload(job, channels[0]);

  job.totalFiles = job.leaves.length;
  job.totalBytes = job.leaves.reduce((s, l) => s + (l.size || 0), 0);
  emitProgress(job, true);

  if (job.leaves.length === 0) {
    complete(job, 'done', { ok: true, errors: job.errors });
    return;
  }

  let idx = 0;
  const transferOne = (job.direction === 'upload') ? putFile : getFile;

  async function worker(sftp) {
    while (true) {
      const i = idx++;
      if (i >= job.leaves.length) return;
      const leaf = job.leaves[i];
      try {
        await transferOne(sftp, leaf, job);
      } catch (_) { /* leaf.status/error already set */ }
      job.doneFiles++;
      emitProgress(job, true);
    }
  }

  const activeChannels = channels.slice(0, Math.min(channels.length, job.leaves.length));
  await Promise.all(activeChannels.map((sftp) => worker(sftp)));
  complete(job, 'done', { ok: true, errors: job.errors });
}

async function startR2R(job) {
  const tempDir = path.join(os.tmpdir(), `dropscp-relay-${job.id}`);
  let tempCreated = false;
  try {
    const [srcChannels, dstChannels] = await Promise.all([
      sessions.acquireSftpPool(job.sessionId, job.workers),
      sessions.acquireSftpPool(job.dstSessionId, job.workers),
    ]);
    if (!srcChannels.length || !dstChannels.length) {
      throw new Error('no SFTP channels available');
    }
    job.workers = Math.min(srcChannels.length, dstChannels.length);

    await fsp.mkdir(tempDir, { recursive: true });
    tempCreated = true;

    await planR2R(job, srcChannels[0], dstChannels[0]);

    job.totalFiles = job.leaves.length;
    // R2R moves each byte twice (download to temp + upload to dst)
    job.totalBytes = 2 * job.leaves.reduce((s, l) => s + (l.size || 0), 0);
    emitProgress(job, true);

    if (job.leaves.length === 0) {
      complete(job, 'done', { ok: true, errors: job.errors });
      return;
    }

    let idx = 0;
    async function worker(i) {
      const srcSftp = srcChannels[i % srcChannels.length];
      const dstSftp = dstChannels[i % dstChannels.length];
      while (true) {
        const k = idx++;
        if (k >= job.leaves.length) return;
        const leaf = job.leaves[k];
        const tempPath = path.join(tempDir, String(k));
        try {
          await relayLeafTransfer(srcSftp, dstSftp, leaf, tempPath, job);
        } catch (_) { /* leaf.status/error already set */ }
        job.doneFiles++;
        emitProgress(job, true);
      }
    }

    const workerCount = Math.min(job.workers, job.leaves.length);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
    complete(job, 'done', { ok: true, errors: job.errors });
  } finally {
    if (tempCreated) {
      fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function start(job) {
  try {
    job.status = 'running';
    emitProgress(job, true);
    if (job.direction === 'r2r') await startR2R(job);
    else await startUpDown(job);
  } catch (err) {
    complete(job, 'fail', { message: err.message });
  }
}

module.exports = { create, get, start, snapshot };
