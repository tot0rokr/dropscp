/* dropscp UI — vanilla JS, no build step */
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
    connect:       (creds)        => api('POST', '/api/connect', creds),
    disconnect:    (sessionId)    => api('POST', '/api/disconnect', { sessionId }),
    remoteLs:      (sid, p)       => api('GET',  `/api/ls?sessionId=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}`),
    remoteMkdir:   (sid, p)       => api('POST', '/api/mkdir', { sessionId: sid, path: p }),
    localLs:       (p)            => api('GET',  p ? `/api/local/ls?path=${encodeURIComponent(p)}` : '/api/local/ls'),
    localMkdir:    (p)            => api('POST', '/api/local/mkdir', { path: p }),
    startTransfer: (body)         => api('POST', '/api/transfer', body),
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
    conflictDialog: $('#conflict-dialog'),
    conflictMessage:$('#conflict-message'),
    remotePane:     $('#pane-remote'),
    localPane:      $('#pane-local'),
    remotePath:     $('#remote-path'),
    localPath:      $('#local-path'),
    remoteTree:     $('#remote-tree'),
    localTree:      $('#local-tree'),
    statusBar:      $('#status-bar'),
    statusText:     $('#status-text'),
    statusMeta:     $('#status-meta'),
    progressFill:   $('#progress-fill'),
  };

  // ---- Path helpers ----
  function posixJoin(base, name) {
    if (!base || base === '/') return '/' + name;
    return base.replace(/\/+$/, '') + '/' + name;
  }
  function posixParent(p) {
    if (!p || p === '/' || p === '') return '/';
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    if (idx <= 0) return '/';
    return trimmed.slice(0, idx);
  }
  function joinLocal(base, name) {
    return base.replace(/[\\/]+$/, '') + '/' + name;
  }
  function parentLocal(p) { return p + '/..'; }

  // ---- Formatting ----
  function fmtSize(n) {
    if (n === undefined || n === null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' M';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' G';
  }
  function setPath(el, p) { el.textContent = p || '—'; el.title = p || ''; }

  // ---- Rendering ----
  function renderTree(ul, side, currentPath, entries, onDirOpen) {
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
      const fullPath = side === 'remote'
        ? posixJoin(currentPath, e.name)
        : joinLocal(currentPath, e.name);

      const li = document.createElement('li');
      li.className = e.isDirectory ? 'dir' : 'file';
      li.draggable = true;
      li.dataset.side = side;
      li.dataset.path = fullPath;
      li.dataset.name = e.name;
      li.dataset.isDir = e.isDirectory ? '1' : '0';

      const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = e.isDirectory ? '📁' : '📄';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = e.name;
      const size = document.createElement('span'); size.className = 'size'; size.textContent = e.isDirectory ? '' : fmtSize(e.size);
      li.append(icon, name, size);

      if (e.isDirectory) li.addEventListener('dblclick', () => onDirOpen(e));

      li.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.effectAllowed = 'copy';
        ev.dataTransfer.setData('application/json', JSON.stringify({
          side, path: fullPath, name: e.name, isDirectory: e.isDirectory,
        }));
        li.classList.add('dragging');
      });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));

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
      renderTree(dom.remoteTree, 'remote', data.path, data.entries,
        (e) => loadRemote(posixJoin(data.path, e.name)));
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
      renderTree(dom.localTree, 'local', data.path, data.entries,
        (e) => loadLocal(joinLocal(data.path, e.name)));
    } catch (err) {
      renderMessage(dom.localTree, 'error', 'local: ' + err.message);
    }
  }

  // ---- Pane action buttons (..  mkdir  refresh) ----
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const side = btn.dataset.side;
      const action = btn.dataset.action;
      const isRemote = side === 'remote';
      const pane = isRemote ? state.remote : state.local;
      if (isRemote && !state.session) return;

      if (action === 'up') {
        if (!pane.path) return;
        const parent = isRemote ? posixParent(pane.path) : parentLocal(pane.path);
        if (isRemote) loadRemote(parent); else loadLocal(parent);
      } else if (action === 'refresh') {
        if (isRemote) loadRemote(pane.path || '.');
        else loadLocal(pane.path || undefined);
      } else if (action === 'mkdir') {
        if (!pane.path) return;
        const name = window.prompt(`New folder name in:\n${pane.path}`);
        if (!name) return;
        const target = isRemote ? posixJoin(pane.path, name) : joinLocal(pane.path, name);
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

  // ---- Drag-and-drop wiring ----
  function setupDropZone(paneEl, side) {
    function clearHighlights() {
      paneEl.classList.remove('drag-into-pane');
      paneEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    }
    paneEl.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      const folderLi = ev.target.closest && ev.target.closest('li.dir');
      paneEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      if (folderLi && folderLi.dataset.side === side) {
        paneEl.classList.remove('drag-into-pane');
        folderLi.classList.add('drag-over');
      } else {
        paneEl.classList.add('drag-into-pane');
      }
    });
    paneEl.addEventListener('dragleave', (ev) => {
      if (!paneEl.contains(ev.relatedTarget)) clearHighlights();
    });
    paneEl.addEventListener('drop', (ev) => {
      ev.preventDefault();
      clearHighlights();
      let payload;
      try { payload = JSON.parse(ev.dataTransfer.getData('application/json')); }
      catch { return; }
      if (!payload || payload.side === side) return;
      if (side === 'remote' && !state.session) {
        window.alert('connect to a remote host first');
        return;
      }
      const folderLi = ev.target.closest && ev.target.closest('li.dir');
      let targetDir;
      if (folderLi && folderLi.dataset.side === side) {
        targetDir = folderLi.dataset.path;
      } else {
        targetDir = (side === 'remote') ? state.remote.path : state.local.path;
      }
      if (!targetDir) return;
      initiateTransfer(payload, side, targetDir);
    });
  }
  setupDropZone(dom.remotePane, 'remote');
  setupDropZone(dom.localPane, 'local');

  // ---- Conflict dialog ----
  function askConflict(name, targetDir) {
    return new Promise((resolve) => {
      dom.conflictMessage.textContent = `"${name}" already exists in ${targetDir}`;
      const onClick = (ev) => {
        const action = ev.target.dataset && ev.target.dataset.conflict;
        if (!action) return;
        cleanup();
        resolve(action);
      };
      const cleanup = () => {
        dom.conflictDialog.querySelectorAll('[data-conflict]').forEach((b) => b.removeEventListener('click', onClick));
        dom.conflictDialog.close();
      };
      dom.conflictDialog.querySelectorAll('[data-conflict]').forEach((b) => b.addEventListener('click', onClick));
      dom.conflictDialog.showModal();
    });
  }

  // ---- Transfer flow ----
  async function initiateTransfer(src, dstSide, dstDir) {
    // dstDir is the directory on dstSide that will receive the item.
    // Conflict: look for src.name in the *visible* listing of dstSide when dstDir == current visible path.
    const visibleListing = (dstSide === 'remote') ? state.remote : state.local;
    let conflict = false;
    if (visibleListing.path === dstDir) {
      conflict = visibleListing.entries.some((e) => e.name === src.name);
    } else {
      // Dropping into a sub-folder we haven't browsed; do a quick ls
      try {
        const data = (dstSide === 'remote')
          ? await Api.remoteLs(state.session.sessionId, dstDir)
          : await Api.localLs(dstDir);
        conflict = data.entries.some((e) => e.name === src.name);
      } catch (_) { /* if we can't list, let backend report on transfer */ }
    }
    if (conflict) {
      const action = await askConflict(src.name, dstDir);
      if (action !== 'overwrite') return;
    }

    const finalDst = (dstSide === 'remote')
      ? posixJoin(dstDir, src.name)
      : joinLocal(dstDir, src.name);
    const direction = (src.side === 'local') ? 'upload' : 'download';

    try {
      const { jobId } = await Api.startTransfer({
        direction,
        src: src.path,
        dst: finalDst,
        sessionId: state.session && state.session.sessionId,
      });
      await streamProgress(jobId, dstSide, dstDir);
    } catch (err) {
      window.alert('transfer failed: ' + err.message);
    }
  }

  // ---- Progress UI ----
  function showProgress() { dom.statusBar.hidden = false; dom.progressFill.style.width = '0%'; }
  function hideProgress() { dom.statusBar.hidden = true; }
  function updateProgress(snap) {
    const pct = snap.totalBytes > 0
      ? Math.min(100, (snap.transferredBytes / snap.totalBytes) * 100)
      : 0;
    dom.progressFill.style.width = pct.toFixed(1) + '%';
    const fileInfo = snap.totalFiles > 1
      ? ` (${snap.doneFiles}/${snap.totalFiles}) ${snap.currentFile}`
      : ` ${snap.currentFile}`;
    dom.statusText.textContent = (snap.direction === 'upload' ? 'Uploading' : 'Downloading') + fileInfo;
    dom.statusMeta.textContent = `${fmtSize(snap.transferredBytes)} / ${fmtSize(snap.totalBytes)}  ${pct.toFixed(0)}%`;
  }

  function streamProgress(jobId, refreshSide, refreshDir) {
    return new Promise((resolve) => {
      const es = new EventSource(`/api/transfer/${jobId}/events`);
      showProgress();
      es.addEventListener('progress', (e) => updateProgress(JSON.parse(e.data)));
      es.addEventListener('done', () => {
        es.close();
        hideProgress();
        // Refresh the side that received the file if we're viewing the target dir
        if (refreshSide === 'remote' && state.session && state.remote.path === refreshDir) {
          loadRemote(state.remote.path);
        } else if (refreshSide === 'local' && state.local.path === refreshDir) {
          loadLocal(state.local.path);
        }
        resolve();
      });
      es.addEventListener('fail', (e) => {
        es.close();
        hideProgress();
        let data = {};
        try { data = JSON.parse(e.data); } catch (_) {}
        window.alert('transfer error: ' + (data.message || 'unknown'));
        resolve();
      });
      es.onerror = () => {
        // Network/connection issue (not server-emitted 'fail')
        if (es.readyState === EventSource.CLOSED) return;
        es.close();
        hideProgress();
        window.alert('transfer stream disconnected');
        resolve();
      };
    });
  }

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
  loadLocal();
})();
