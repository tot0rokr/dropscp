const express = require('express');
const path = require('path');
const os = require('os');
const { loadConfig } = require('./config');
const sessions = require('./ssh-session');
const localFs = require('./local-fs');
const transfer = require('./transfer');

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

// ---- Transfer ----
app.post('/api/transfer', (req, res) => {
  const { direction, sessionId, src, dst } = req.body || {};
  if (!direction || !src || !dst) {
    return res.status(400).json({ error: 'direction, src, dst required' });
  }
  if ((direction === 'upload' || direction === 'download') && !sessionId) {
    return res.status(400).json({ error: 'sessionId required for ' + direction });
  }
  try {
    const job = transfer.create({ direction, sessionId, src, dst });
    // Kick off async; do not await
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
  const onError = (data) => { send('fail', data); res.end(); };

  job.events.on('progress', onProgress);
  job.events.once('done', onDone);
  job.events.once('error', onError);

  req.on('close', () => {
    job.events.off('progress', onProgress);
    job.events.off('done', onDone);
    job.events.off('error', onError);
  });
});

const { port, bindHost } = config.server;
app.listen(port, bindHost, () => {
  console.log(`dropscp running at http://${bindHost}:${port}`);
});
