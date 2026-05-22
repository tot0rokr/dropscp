const express = require('express');
const path = require('path');
const os = require('os');
const { loadConfig, clampWorkers } = require('./config');
const sessions = require('./ssh-session');
const localFs = require('./local-fs');
const transfer = require('./transfer');
const presets = require('./presets');

const config = loadConfig();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/connect', async (req, res) => {
  const { username, host, port, password } = req.body || {};
  if (!username || !host || !password) {
    return res.status(400).json({ error: 'username, host, and password are required' });
  }
  try {
    const sessionId = await sessions.create({
      username,
      host,
      port: Number(port) || 22,
      password,
    });
    res.json({ sessionId, username, host, port: Number(port) || 22 });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  sessions.close(req.body && req.body.sessionId);
  res.json({ ok: true });
});

app.get('/api/session/status', (req, res) => {
  const status = sessions.getStatus(req.query.sessionId);
  res.json({ status });
});

app.get('/api/ls', async (req, res) => {
  try {
    const result = await sessions.ls(req.query.sessionId, req.query.path || '.');
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mkdir', async (req, res) => {
  try {
    await sessions.mkdir(req.body.sessionId, req.body.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/local/ls', async (req, res) => {
  try {
    const target = req.query.path || os.homedir();
    const entries = await localFs.ls(target);
    res.json({ entries, path: localFs.resolve(target) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/local/mkdir', async (req, res) => {
  try {
    await localFs.mkdir(req.body.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Presets ----
app.get('/api/presets', (req, res) => {
  res.json({ presets: presets.list() });
});
app.post('/api/presets', (req, res) => {
  try {
    res.json({ presets: presets.upsert(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/presets/delete', (req, res) => {
  try {
    res.json({ presets: presets.remove(req.body && req.body.name) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Transfer ----
app.post('/api/transfer', (req, res) => {
  const { direction, sessionId, items, workers } = req.body || {};
  if (direction !== 'upload' && direction !== 'download') {
    return res.status(400).json({ error: 'direction must be "upload" or "download"' });
  }
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items[] required (non-empty)' });
  }
  for (const it of items) {
    if (!it || typeof it.src !== 'string' || typeof it.dst !== 'string' || !it.src || !it.dst) {
      return res.status(400).json({ error: 'each item must have non-empty src and dst' });
    }
  }
  const requestedWorkers = workers != null ? Number(workers) : config.transfer.workers;
  const cappedWorkers = Math.min(
    config.transfer.workers,
    clampWorkers(requestedWorkers)
  );
  try {
    const job = transfer.create({ direction, sessionId, items, workers: cappedWorkers });
    transfer.start(job);
    res.json({ jobId: job.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Same-host file operations (F8). One unified route; dispatches by side+op.
//   body: { side: 'local'|'remote', sessionId?, op, ...args }
//     move    -> { src, dst }            (rename across directories)
//     rename  -> { src, dst }            (same operation; separate op name for UX clarity)
//     delete  -> { paths: [string,...] } (directories are removed recursively)
//     copy    -> { src, dst }            (remote: cp -r via ssh exec; local: fs.cp recursive)
app.post('/api/fileop', async (req, res) => {
  const { side, op, sessionId } = req.body || {};
  if (side !== 'local' && side !== 'remote') {
    return res.status(400).json({ error: 'side must be "local" or "remote"' });
  }
  if (side === 'remote' && !sessionId) {
    return res.status(400).json({ error: 'sessionId required for remote ops' });
  }
  try {
    if (op === 'move' || op === 'rename') {
      const { src, dst } = req.body;
      if (!src || !dst) return res.status(400).json({ error: 'src and dst required' });
      if (src === dst) return res.json({ ok: true, noop: true });
      if (side === 'remote') await sessions.rename(sessionId, src, dst);
      else await localFs.rename(src, dst);
      res.json({ ok: true });
    } else if (op === 'delete') {
      const { paths } = req.body;
      if (!Array.isArray(paths) || paths.length === 0) {
        return res.status(400).json({ error: 'paths[] required (non-empty)' });
      }
      let count = 0;
      const errors = [];
      for (const p of paths) {
        try {
          if (side === 'remote') await sessions.removeRecursive(sessionId, p);
          else await localFs.remove(p);
          count++;
        } catch (err) {
          errors.push({ path: p, message: err.message });
        }
      }
      if (errors.length && count === 0) {
        return res.status(400).json({ error: errors[0].message, errors });
      }
      res.json({ ok: true, count, errors });
    } else if (op === 'copy') {
      const { src, dst } = req.body;
      if (!src || !dst) return res.status(400).json({ error: 'src and dst required' });
      if (side === 'remote') await sessions.copyPath(sessionId, src, dst);
      else await localFs.copy(src, dst);
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'unknown op: ' + op });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/r2r', (req, res) => {
  const { srcSessionId, dstSessionId, items, workers } = req.body || {};
  if (!srcSessionId || !dstSessionId) {
    return res.status(400).json({ error: 'srcSessionId and dstSessionId required' });
  }
  if (srcSessionId === dstSessionId) {
    return res.status(400).json({ error: 'src and dst must be different sessions' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items[] required (non-empty)' });
  }
  for (const it of items) {
    if (!it || typeof it.src !== 'string' || typeof it.dst !== 'string' || !it.src || !it.dst) {
      return res.status(400).json({ error: 'each item must have non-empty src and dst' });
    }
  }
  const requestedWorkers = workers != null ? Number(workers) : config.transfer.workers;
  const cappedWorkers = Math.min(
    config.transfer.workers,
    clampWorkers(requestedWorkers)
  );
  try {
    const job = transfer.create({
      direction: 'r2r',
      sessionId: srcSessionId,
      dstSessionId,
      items,
      workers: cappedWorkers,
    });
    transfer.start(job);
    res.json({ jobId: job.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/transfer/:jobId/events', (req, res) => {
  const job = transfer.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Initial snapshot
  send('progress', transfer.snapshot(job));
  if (job.status === 'done') { send('done', { ok: true }); return res.end(); }
  if (job.status === 'error') { send('fail', { message: job.error }); return res.end(); }

  const onProgress = (snap) => send('progress', snap);
  const onDone = (data) => { send('done', data); res.end(); };
  const onFail = (data) => { send('fail', data); res.end(); };

  job.events.on('progress', onProgress);
  job.events.once('done', onDone);
  job.events.once('fail', onFail);

  req.on('close', () => {
    job.events.off('progress', onProgress);
    job.events.off('done', onDone);
    job.events.off('fail', onFail);
  });
});

const { port, bindHost } = config.server;
app.listen(port, bindHost, () => {
  console.log(`dropscp running at http://${bindHost}:${port}`);
});
