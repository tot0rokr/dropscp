/* dropscp M2 UI — vanilla JS, no build step */
(() => {
  // ---- State ----
  const state = {
    session: null,
    remote: { path: null, entries: [] },
    local:  { path: null, entries: [] },
  };

  // ---- API ----
  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  const Api = {
    connect: (creds)            => api('POST', '/api/connect', creds),
    disconnect: (sessionId)     => api('POST', '/api/disconnect', { sessionId }),
    remoteLs:    (sid, p)       => api('GET', `/api/ls?sessionId=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}`),
    remoteMkdir: (sid, p)       => api('POST', '/api/mkdir', { sessionId: sid, path: p }),
    localLs:     (p)            => api('GET', p ? `/api/local/ls?path=${encodeURIComponent(p)}` : '/api/local/ls'),
    localMkdir:  (p)            => api('POST', '/api/local/mkdir', { path: p }),
  };

  // ---- DOM ----
  const $ = (sel) => document.querySelector(sel);
  const dom = {
    sessionInfo:    $('#session-info'),
    connectBtn:     $('#connect-btn'),
    disconnectBtn:  $('#disconnect-btn'),
    loginDialog:    $('#login-dialog'),
    loginForm:      $('#login-form'),
    loginCancel:    $('#login-cancel'),
    loginError:     $('#login-error'),
    remotePath:     $('#remote-path'),
    localPath:      $('#local-path'),
    remoteTree:     $('#remote-tree'),
    localTree:      $('#local-tree'),
  };

  // ---- Path helpers ----
  // Remote paths are POSIX (server is *nix).
  function joinRemote(base, name) {
    if (!base || base === '/') return '/' + name;
    return base.replace(/\/+$/, '') + '/' + name;
  }
  function parentRemote(p) {
    if (!p || p === '/' || p === '') return '/';
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    if (idx <= 0) return '/';
    return trimmed.slice(0, idx);
  }
  // Local paths: backend uses path.resolve which normalizes both separators
  // and `..`, so we just append with '/' and let the server canonicalize.
  function joinLocal(base, name) {
    return base.replace(/[\\/]+$/, '') + '/' + name;
  }
  function parentLocal(p) {
    return p + '/..';
  }

  // ---- Rendering ----
  function fmtSize(n) {
    if (n === undefined || n === null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' M';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' G';
  }

  function setPath(el, p) {
    el.textContent = p || '—';
    el.title = p || '';
  }

  function renderTree(ul, entries, onDirOpen) {
    ul.replaceChildren();
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '(empty)';
      ul.appendChild(li);
      return;
    }
    const sorted = entries.slice().sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of sorted) {
      const li = document.createElement('li');
      li.className = e.isDirectory ? 'dir' : 'file';
      const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = e.isDirectory ? '📁' : '📄';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = e.name;
      const size = document.createElement('span'); size.className = 'size'; size.textContent = e.isDirectory ? '' : fmtSize(e.size);
      li.append(icon, name, size);
      if (e.isDirectory) li.addEventListener('dblclick', () => onDirOpen(e));
      ul.appendChild(li);
    }
  }

  function renderMessage(ul, cls, msg) {
    ul.replaceChildren();
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = msg;
    ul.appendChild(li);
  }

  // ---- Loaders ----
  async function loadRemote(p) {
    if (!state.session) return;
    renderMessage(dom.remoteTree, 'loading', 'loading…');
    try {
      const data = await Api.remoteLs(state.session.sessionId, p || '.');
      state.remote.path = data.path;
      state.remote.entries = data.entries;
      setPath(dom.remotePath, data.path);
      renderTree(dom.remoteTree, data.entries, (e) => loadRemote(joinRemote(data.path, e.name)));
    } catch (err) {
      renderMessage(dom.remoteTree, 'error', 'remote: ' + err.message);
    }
  }

  async function loadLocal(p) {
    renderMessage(dom.localTree, 'loading', 'loading…');
    try {
      const data = await Api.localLs(p);
      state.local.path = data.path;
      state.local.entries = data.entries;
      setPath(dom.localPath, data.path);
      renderTree(dom.localTree, data.entries, (e) => loadLocal(joinLocal(data.path, e.name)));
    } catch (err) {
      renderMessage(dom.localTree, 'error', 'local: ' + err.message);
    }
  }

  // ---- Pane action buttons ----
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const side = btn.dataset.side;
      const action = btn.dataset.action;
      const isRemote = side === 'remote';
      const pane = isRemote ? state.remote : state.local;
      if (isRemote && !state.session) return;

      if (action === 'up') {
        if (!pane.path) return;
        const parent = isRemote ? parentRemote(pane.path) : parentLocal(pane.path);
        if (isRemote) loadRemote(parent); else loadLocal(parent);
      } else if (action === 'refresh') {
        if (isRemote) loadRemote(pane.path || '.');
        else loadLocal(pane.path || undefined);
      } else if (action === 'mkdir') {
        if (!pane.path) return;
        const name = window.prompt(`New folder name in:\n${pane.path}`);
        if (!name) return;
        const target = isRemote ? joinRemote(pane.path, name) : joinLocal(pane.path, name);
        try {
          if (isRemote) await Api.remoteMkdir(state.session.sessionId, target);
          else await Api.localMkdir(target);
          if (isRemote) loadRemote(pane.path); else loadLocal(pane.path);
        } catch (err) {
          window.alert('mkdir failed: ' + err.message);
        }
      }
    });
  });

  // ---- Login ----
  function showLogin() {
    dom.loginError.hidden = true;
    dom.loginError.textContent = '';
    dom.loginDialog.showModal();
    setTimeout(() => dom.loginForm.username.focus(), 0);
  }

  dom.connectBtn.addEventListener('click', showLogin);
  dom.loginCancel.addEventListener('click', () => dom.loginDialog.close());

  dom.loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(dom.loginForm);
    const creds = {
      username: String(fd.get('username') || '').trim(),
      host:     String(fd.get('host') || '').trim(),
      port:     Number(fd.get('port')) || 22,
      password: String(fd.get('password') || ''),
    };
    try {
      const data = await Api.connect(creds);
      state.session = {
        sessionId: data.sessionId,
        username: data.username,
        host: data.host,
        port: data.port,
      };
      dom.sessionInfo.textContent = `${data.username}@${data.host}:${data.port}`;
      dom.connectBtn.hidden = true;
      dom.disconnectBtn.hidden = false;
      dom.loginDialog.close();
      dom.loginForm.reset();
      await loadRemote('.');
    } catch (err) {
      dom.loginError.textContent = err.message;
      dom.loginError.hidden = false;
    }
  });

  dom.disconnectBtn.addEventListener('click', async () => {
    if (!state.session) return;
    try { await Api.disconnect(state.session.sessionId); } catch (_) {}
    state.session = null;
    state.remote = { path: null, entries: [] };
    dom.sessionInfo.textContent = 'not connected';
    setPath(dom.remotePath, '');
    renderMessage(dom.remoteTree, 'empty', 'connect to a host to browse');
    dom.connectBtn.hidden = false;
    dom.disconnectBtn.hidden = true;
  });

  // ---- Init ----
  loadLocal();   // backend defaults to user home
})();
