const { Client } = require('ssh2');
const crypto = require('crypto');

const sessions = new Map();

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function attachDeathListeners(s) {
  const markDead = () => {
    if (s.status === 'dead' || s.status === 'reconnecting') return;
    s.status = 'dead';
    s.sftp = null;
    s.sftpPool = [];
  };
  s.client.on('error', markDead);
  s.client.on('close', markDead);
  s.client.on('end', markDead);
}

function rawConnect({ username, host, port, password }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch (_) {}
      reject(err);
    };
    client
      .on('ready', async () => {
        try {
          const sftp = await openSftp(client);
          settled = true;
          resolve({ client, sftp });
        } catch (err) {
          fail(err);
        }
      })
      .on('error', fail)
      .connect({ username, host, port, password, readyTimeout: 10_000 });
  });
}

async function create({ username, host, port, password }) {
  const { client, sftp } = await rawConnect({ username, host, port, password });
  const id = crypto.randomBytes(16).toString('hex');
  const s = {
    client,
    sftp,
    sftpPool: [sftp],
    info: { username, host, port },
    password,
    status: 'connected',
    reconnectPromise: null,
  };
  sessions.set(id, s);
  attachDeathListeners(s);
  return id;
}

function get(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session not found');
  return s;
}

function getStatus(sessionId) {
  const s = sessions.get(sessionId);
  return s ? s.status : 'missing';
}

function close(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  // Prevent any pending reconnect from racing the explicit close.
  s.status = 'closed';
  s.password = null;
  try { s.client.end(); } catch (_) {}
  sessions.delete(sessionId);
}

async function reconnectInPlace(s) {
  const { client, sftp } = await rawConnect({ ...s.info, password: s.password });
  s.client = client;
  s.sftp = sftp;
  s.sftpPool = [sftp];
  s.status = 'connected';
  attachDeathListeners(s);
}

async function ensureAlive(sessionId) {
  const s = get(sessionId);
  if (s.status === 'connected') return s;
  if (s.status === 'closed') throw new Error('session closed');
  if (s.status === 'reconnecting') {
    await s.reconnectPromise;
    return s;
  }
  // status === 'dead'
  if (!s.password) throw new Error('cannot reconnect: no stored credentials');
  s.status = 'reconnecting';
  s.reconnectPromise = reconnectInPlace(s).catch((err) => {
    s.status = 'dead';
    throw err;
  });
  try {
    await s.reconnectPromise;
  } finally {
    s.reconnectPromise = null;
  }
  return s;
}

// Returns an array of `n` SFTP channels (always >= 1). Lazily opens new channels
// as needed and caches them on the session; channels live until the session is
// closed. If a channel open fails, returns whatever pool we have so far (>= 1).
async function acquireSftpPool(sessionId, n) {
  const s = await ensureAlive(sessionId);
  const want = Math.max(1, Math.floor(n) || 1);
  while (s.sftpPool.length < want) {
    try {
      const extra = await openSftp(s.client);
      s.sftpPool.push(extra);
    } catch (_) {
      break;
    }
  }
  return s.sftpPool.slice(0, Math.min(want, s.sftpPool.length));
}

async function ls(sessionId, dirPath) {
  const s = await ensureAlive(sessionId);
  const { sftp } = s;
  return new Promise((resolve, reject) => {
    sftp.realpath(dirPath || '.', (rpErr, resolved) => {
      const target = rpErr ? (dirPath || '.') : resolved;
      sftp.readdir(target, (err, list) => {
        if (err) return reject(err);
        const entries = list.map((e) => ({
          name: e.filename,
          isDirectory: e.attrs.isDirectory(),
          size: e.attrs.size,
          mtime: e.attrs.mtime,
        }));
        resolve({ path: target, entries });
      });
    });
  });
}

async function mkdir(sessionId, dirPath) {
  if (!dirPath) throw new Error('path is required');
  const s = await ensureAlive(sessionId);
  return new Promise((resolve, reject) => {
    s.sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  create,
  close,
  ls,
  mkdir,
  get,
  getStatus,
  ensureAlive,
  acquireSftpPool,
};
