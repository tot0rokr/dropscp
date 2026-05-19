const express = require('express');
const path = require('path');
const { loadConfig } = require('./config');
const sessions = require('./ssh-session');
const localFs = require('./local-fs');

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
    const entries = await localFs.ls(req.query.path || process.cwd());
    res.json({ entries, path: localFs.resolve(req.query.path || process.cwd()) });
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

const { port, bindHost } = config.server;
app.listen(port, bindHost, () => {
  console.log(`dropscp running at http://${bindHost}:${port}`);
});
