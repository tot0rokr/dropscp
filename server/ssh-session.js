const { Client } = require('ssh2');
const crypto = require('crypto');

const sessions = new Map();

function create({ username, host, port, password }) {
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
      .on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) return fail(err);
          const id = crypto.randomBytes(16).toString('hex');
          sessions.set(id, { client, sftp, info: { username, host, port } });
          settled = true;
          resolve(id);
        });
      })
      .on('error', fail)
      .connect({ username, host, port, password, readyTimeout: 10_000 });
  });
}

function get(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session not found');
  return s;
}

function close(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try { s.client.end(); } catch (_) {}
  sessions.delete(sessionId);
}

function ls(sessionId, dirPath) {
  const { sftp } = get(sessionId);
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

function mkdir(sessionId, dirPath) {
  if (!dirPath) return Promise.reject(new Error('path is required'));
  const { sftp } = get(sessionId);
  return new Promise((resolve, reject) => {
    sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { create, close, ls, mkdir, get };
