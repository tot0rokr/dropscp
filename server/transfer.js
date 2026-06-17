const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sessions = require('./ssh-session');
const transferLog = require('./transfer-log');

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
    cancelled: job.cancelled,
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

// Build the persisted log record for a finished job (job summary + per-file detail).
function buildLogRecord(job) {
  let ok = 0, err = 0, cancelled = 0;
  for (const l of job.leaves) {
    if (l.status === 'done') ok++;
    else if (l.status === 'error') err++;
    else if (l.status === 'cancelled') cancelled++;
  }
  return {
    id: job.id,
    startedAt: job.startedAt,
    finishedAt: Date.now(),
    direction: job.direction,            // 'upload' | 'download' | 'r2r'
    srcHost: job.srcHost,                // { username, host, port } | null (=local)
    dstHost: job.dstHost,
    status: job.status,                  // 'done' | 'error'
    cancelled: job.cancelled,
    error: job.error || null,            // fatal batch-level error
    totalFiles: job.totalFiles,
    okFiles: ok,
    errorFiles: err,
    cancelledFiles: cancelled,
    totalBytes: job.totalBytes,
    transferredBytes: job.transferredBytes,
    planErrors: job.errors.slice(),      // planning-stage errors
    files: job.leaves.map((l) => ({
      name: l.name,
      src: l.src,
      dst: l.dst,
      size: l.size,
      status: l.status,
      error: l.error || null,
    })),
  };
}

function complete(job, kind, payload) {
  // kind is 'done' or 'fail'. We never emit Node's special 'error' event
  // because an unhandled emit on 'error' crashes the process when no SSE
  // consumer is attached yet.
  if (job.finished) return;
  job.finished = true;
  job.status = kind === 'done' ? 'done' : 'error';
  if (kind === 'fail') job.error = payload.message;
  emitProgress(job, true);
  job.events.emit(kind, payload);
  // Persist a transfer-log record (best-effort; never let it break completion).
  try { transferLog.append(buildLogRecord(job)); } catch (_) {}
  setTimeout(() => jobs.delete(job.id), 30_000);
}

function create({ direction, sessionId, dstSessionId, items, workers }) {
  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id,
    direction,                     // 'upload' | 'download' | 'r2r'
    sessionId,                     // src session for r2r, the only session for up/down
    dstSessionId,                  // r2r only: destination session
    // Connection info per end, captured now (the session may be gone by the time
    // the job finishes). Local end is null; remote ends carry { username, host, port }.
    startedAt: Date.now(),
    srcHost: direction === 'upload' ? null : sessions.getInfo(sessionId),
    dstHost: direction === 'upload' ? sessions.getInfo(sessionId)
           : direction === 'r2r'    ? sessions.getInfo(dstSessionId)
           : null,
    items: items.slice(),          // [{ src, dst }, ...] — dst is the FINAL path (includes basename)
    workers: Math.max(1, Math.floor(workers) || 1),
    status: 'pending',
    cancelled: false,              // set by cancelJob (full cancel)
    totalBytes: 0,
    transferredBytes: 0,
    totalFiles: 0,
    doneFiles: 0,
    leaves: [],                    // [{ id, name, src, dst, size, transferred, status, error, _sftp, _sftpSession, _cancel, _abort }]
    errors: [],                    // planning-stage errors (no leaf exists)
    error: null,                   // fatal batch-level error
    events: new EventEmitter(),
    finished: false,
    // up/down dynamic-queue engine state:
    nextIdx: 0,                    // cursor into leaves[]
    activeWorkers: 0,
    channels: [],                  // all checked-out transfer channels (for release)
    idle: [],                      // channels free to start a worker on
    _transferOne: null,            // putFile | getFile (chosen at start)
    _appending: false,             // suppress finalize while appendItems is planning
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
// Each driver registers leaf._abort so a cancel can settle the promise
// immediately even if ssh2's callback is swallowed by the channel teardown.
function putFile(sftp, leaf, job) {
  return new Promise((resolve, reject) => {
    leaf.status = 'active';
    leaf.transferred = 0;
    let prev = 0, settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      leaf._abort = null;
      if (err) return reject(err);
      leaf.status = 'done';
      leaf.transferred = leaf.size;
      resolve();
    };
    leaf._abort = (err) => done(err || new Error('cancelled'));
    sftp.fastPut(leaf.src, leaf.dst, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        leaf.transferred = transferred;
        prev = transferred;
        emitProgress(job);
      },
    }, (err) => done(err));
  });
}

function getFile(sftp, leaf, job) {
  return new Promise((resolve, reject) => {
    leaf.status = 'active';
    leaf.transferred = 0;
    let prev = 0, settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      leaf._abort = null;
      if (err) return reject(err);
      leaf.status = 'done';
      leaf.transferred = leaf.size;
      resolve();
    };
    leaf._abort = (err) => done(err || new Error('cancelled'));
    sftp.fastGet(leaf.src, leaf.dst, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        leaf.transferred = transferred;
        prev = transferred;
        emitProgress(job);
      },
    }, (err) => done(err));
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
    _sftp: null,
    _sftpSession: null,
    _cancel: false,
    _abort: null,
  });
}

// ---- Planning: expand items[] into leaf-file jobs and pre-create dest dirs ----
// `items` defaults to job.items; appendItems passes a fresh batch so only the
// newly-added leaves get their destination dirs ensured.
async function planUpload(job, sftp, items = job.items) {
  const startLen = job.leaves.length;
  for (const it of items) {
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
  for (let k = startLen; k < job.leaves.length; k++) dirs.add(posixDirname(job.leaves[k].dst));
  for (const d of dirs) {
    try { await sftpEnsureDir(sftp, d); }
    catch (_) { /* surfaced per-leaf during putFile */ }
  }
}

async function planDownload(job, sftp, items = job.items) {
  const startLen = job.leaves.length;
  for (const it of items) {
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
  for (let k = startLen; k < job.leaves.length; k++) dirs.add(path.dirname(job.leaves[k].dst));
  for (const d of dirs) {
    try { await fsp.mkdir(d, { recursive: true }); }
    catch (_) { /* surfaced per-leaf during getFile */ }
  }
}

// ---- R2R: planning + relay driver ----
async function planR2R(job, srcSftp, dstSftp, items = job.items) {
  const startLen = job.leaves.length;
  for (const it of items) {
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
  for (let k = startLen; k < job.leaves.length; k++) dirs.add(posixDirname(job.leaves[k].dst));
  for (const d of dirs) {
    try { await sftpEnsureDir(dstSftp, d); }
    catch (_) { /* surfaced per-leaf during upload phase */ }
  }
}

// Relay one leaf: src(SFTP) → local temp → dst(SFTP). Cleans up its temp file.
// Updates leaf._sftp/_sftpSession per phase so a cancel kills the right channel.
function relayLeafTransfer(srcSftp, dstSftp, leaf, tempPath, job) {
  return new Promise((resolve, reject) => {
    leaf.status = 'active';
    leaf.transferred = 0;
    leaf.phase = 'download';
    leaf._sftp = srcSftp;
    leaf._sftpSession = job.sessionId;
    let prev = 0, settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      leaf._abort = null;
      fsp.unlink(tempPath).catch(() => {});
      reject(err);
    };
    leaf._abort = (err) => fail(err || new Error('cancelled'));

    srcSftp.fastGet(leaf.src, tempPath, {
      step: (transferred) => {
        job.transferredBytes += (transferred - prev);
        leaf.transferred = transferred;
        prev = transferred;
        emitProgress(job);
      },
    }, (downErr) => {
      if (settled) return;
      if (downErr) return fail(downErr);
      // Phase 2: upload from local temp to dst
      leaf.phase = 'upload';
      leaf.transferred = 0;
      leaf._sftp = dstSftp;
      leaf._sftpSession = job.dstSessionId;
      prev = 0;
      dstSftp.fastPut(tempPath, leaf.dst, {
        step: (transferred) => {
          job.transferredBytes += (transferred - prev);
          leaf.transferred = transferred;
          prev = transferred;
          emitProgress(job);
        },
      }, (upErr) => {
        if (settled) return;
        fsp.unlink(tempPath).catch(() => {});
        if (upErr) return fail(upErr);
        settled = true;
        leaf._abort = null;
        leaf.status = 'done';
        leaf.transferred = leaf.size;
        resolve();
      });
    });
  });
}

// ---- Cancellation ----
// Best-effort removal of the partially-written destination file after a cancel.
async function deletePartial(job, leaf) {
  try {
    if (job.direction === 'download') {
      await fsp.unlink(leaf.dst).catch(() => {});
    } else if (job.direction === 'upload') {
      await sessions.removeRecursive(job.sessionId, leaf.dst).catch(() => {});
    } else { // r2r — dst lives on the destination session
      await sessions.removeRecursive(job.dstSessionId, leaf.dst).catch(() => {});
    }
  } catch (_) { /* best-effort */ }
}

// Kill the channel currently moving `leaf` (so fastPut/fastGet errors out) and
// settle its promise immediately via the registered abort.
function abortLeaf(leaf) {
  if (leaf._sftp) sessions.discardSftp(leaf._sftpSession, leaf._sftp);
  if (leaf._abort) leaf._abort(new Error('cancelled'));
}

function cancelLeaf(job, leafId) {
  const leaf = job.leaves[leafId];
  if (!leaf) return false;
  if (leaf.status === 'done' || leaf.status === 'error' || leaf.status === 'cancelled') return true;
  leaf._cancel = true;
  if (leaf.status === 'active') abortLeaf(leaf);
  return true;
}

function cancelJob(job) {
  job.cancelled = true;
  for (const leaf of job.leaves) {
    if (leaf.status === 'active') abortLeaf(leaf);
  }
  emitProgress(job, true);
  return true;
}

// ---- Dynamic-queue engine (upload/download; supports appendItems) ----
function maybeFinalize(job) {
  if (job.finished || job._appending) return;
  if (job.activeWorkers > 0) return;
  const drained = job.nextIdx >= job.leaves.length;
  if (!drained && !job.cancelled) return;
  if (job.cancelled) {
    for (const leaf of job.leaves) {
      if (leaf.status === 'waiting') leaf.status = 'cancelled';
    }
  }
  sessions.releaseSftp(job.sessionId, job.channels);
  complete(job, 'done', { ok: true, errors: job.errors });
}

function pump(job) {
  if (job.finished) return;
  while (!job.cancelled && job.idle.length > 0 && job.nextIdx < job.leaves.length) {
    const sftp = job.idle.pop();
    job.activeWorkers++;
    runWorker(job, sftp);
  }
  maybeFinalize(job);
}

async function runWorker(job, sftp) {
  try {
    while (!job.cancelled) {
      const i = job.nextIdx;
      if (i >= job.leaves.length) break;
      job.nextIdx++;
      const leaf = job.leaves[i];

      if (leaf._cancel) {                 // cancelled while waiting — skip it
        leaf.status = 'cancelled';
        job.doneFiles++;
        emitProgress(job, true);
        continue;
      }

      leaf._sftp = sftp;
      leaf._sftpSession = job.sessionId;
      let channelDead = false;
      try {
        await job._transferOne(sftp, leaf, job);
      } catch (err) {
        if (leaf._cancel || job.cancelled) {
          leaf.status = 'cancelled';
          leaf.error = null;
          channelDead = true;            // cancel works by killing the channel
          await deletePartial(job, leaf);
        } else {
          leaf.status = 'error';
          leaf.error = err.message;
        }
      } finally {
        leaf._sftp = null;
      }
      job.doneFiles++;
      emitProgress(job, true);

      if (job.cancelled) break;
      if (channelDead) {
        // Individual-leaf cancel killed this channel; grab a fresh one to keep going.
        const repl = await sessions.checkoutSftp(job.sessionId, 1).catch(() => []);
        if (!repl.length) { sftp = null; break; }
        sftp = repl[0];
        job.channels.push(sftp);
      }
    }
  } catch (_) { /* never let a worker reject unhandled */ }
  job.activeWorkers--;
  if (sftp) job.idle.push(sftp);          // dead channels are dropped (sftp === null)
  maybeFinalize(job);
}

// ---- Batch drivers ----
async function startUpDown(job) {
  const channels = await sessions.checkoutSftp(job.sessionId, job.workers);
  if (!channels.length) throw new Error('no SFTP channels available');
  job.workers = channels.length;
  job.channels = channels.slice();
  job.idle = channels.slice();

  if (job.direction === 'upload') await planUpload(job, channels[0]);
  else await planDownload(job, channels[0]);

  job.totalFiles = job.leaves.length;
  job.totalBytes = job.leaves.reduce((s, l) => s + (l.size || 0), 0);
  emitProgress(job, true);

  job._transferOne = (job.direction === 'upload') ? putFile : getFile;
  pump(job);   // launches workers; finalize happens via maybeFinalize
}

// Append more files to a still-running up/down job (same session + direction).
// Returns false if the job already finished — caller should start a new job.
async function appendItems(job, items) {
  if (job.finished || job.direction === 'r2r') return false;
  job._appending = true;
  try {
    const [planSftp] = await sessions.checkoutSftp(job.sessionId, 1).catch(() => []);
    try {
      if (job.direction === 'upload') await planUpload(job, planSftp || job.channels[0], items);
      else await planDownload(job, planSftp || job.channels[0], items);
    } finally {
      if (planSftp) sessions.releaseSftp(job.sessionId, [planSftp]);
    }
    job.totalFiles = job.leaves.length;
    job.totalBytes = job.leaves.reduce((s, l) => s + (l.size || 0), 0);
  } finally {
    job._appending = false;
  }
  emitProgress(job, true);
  pump(job);
  return true;
}

async function startR2R(job) {
  const tempDir = path.join(os.tmpdir(), `dropscp-relay-${job.id}`);
  let tempCreated = false;
  try {
    const [srcChannels, dstChannels] = await Promise.all([
      sessions.checkoutSftp(job.sessionId, job.workers),
      sessions.checkoutSftp(job.dstSessionId, job.workers),
    ]);
    if (!srcChannels.length || !dstChannels.length) {
      throw new Error('no SFTP channels available');
    }
    job.workers = Math.min(srcChannels.length, dstChannels.length);
    job.srcChannels = srcChannels.slice();
    job.dstChannels = dstChannels.slice();

    await fsp.mkdir(tempDir, { recursive: true });
    tempCreated = true;

    await planR2R(job, srcChannels[0], dstChannels[0]);

    job.totalFiles = job.leaves.length;
    // R2R moves each byte twice (download to temp + upload to dst)
    job.totalBytes = 2 * job.leaves.reduce((s, l) => s + (l.size || 0), 0);
    emitProgress(job, true);

    if (job.leaves.length === 0) {
      sessions.releaseSftp(job.sessionId, srcChannels);
      sessions.releaseSftp(job.dstSessionId, dstChannels);
      complete(job, 'done', { ok: true, errors: job.errors });
      return;
    }

    let idx = 0;
    async function worker(i) {
      let srcSftp = srcChannels[i % srcChannels.length];
      let dstSftp = dstChannels[i % dstChannels.length];
      while (!job.cancelled) {
        const k = idx++;
        if (k >= job.leaves.length) return;
        const leaf = job.leaves[k];
        if (leaf._cancel) {
          leaf.status = 'cancelled';
          job.doneFiles++;
          emitProgress(job, true);
          continue;
        }
        const tempPath = path.join(tempDir, String(k));
        let killedSession = null;
        try {
          await relayLeafTransfer(srcSftp, dstSftp, leaf, tempPath, job);
        } catch (err) {
          if (leaf._cancel || job.cancelled) {
            leaf.status = 'cancelled';
            leaf.error = null;
            killedSession = leaf._sftpSession;   // the channel killed by the cancel
            await deletePartial(job, leaf);
          } else {
            leaf.status = 'error';
            leaf.error = err.message;
          }
        } finally {
          leaf._sftp = null;
        }
        job.doneFiles++;
        emitProgress(job, true);

        if (job.cancelled) return;
        if (killedSession) {
          // Replace whichever side's channel the cancel tore down.
          if (killedSession === job.sessionId) {
            const [s2] = await sessions.checkoutSftp(job.sessionId, 1).catch(() => []);
            if (!s2) return;
            srcSftp = s2; job.srcChannels.push(s2);
          } else {
            const [d2] = await sessions.checkoutSftp(job.dstSessionId, 1).catch(() => []);
            if (!d2) return;
            dstSftp = d2; job.dstChannels.push(d2);
          }
        }
      }
    }

    const workerCount = Math.min(job.workers, job.leaves.length);
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
    if (job.cancelled) {
      for (const leaf of job.leaves) {
        if (leaf.status === 'waiting') leaf.status = 'cancelled';
      }
    }
    sessions.releaseSftp(job.sessionId, job.srcChannels);
    sessions.releaseSftp(job.dstSessionId, job.dstChannels);
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

module.exports = { create, get, start, snapshot, appendItems, cancelJob, cancelLeaf };
