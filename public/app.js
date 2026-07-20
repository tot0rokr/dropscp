/* dropscp UI — vanilla JS, no build step */
(() => {
  // ---- State ----
  function emptyRemoteState() {
    return { path: null, entries: [], sorted: [], selected: new Set(), anchorIdx: -1, history: [], histIdx: -1 };
  }
  // state.tabs[i] = { session: { sessionId, username, host, port }, remote: emptyRemoteState() }
  // state.session and state.remote are LIVE references to the active tab; rebound on switch.
  // R2R mode: state.r2rMode is true and state.r2rHost = { session, remote } points to the dst tab's
  // session + a pane-state for the right side that mirrors a remote tree instead of local FS.
  const state = {
    tabs: [],
    activeIdx: -1,
    session: null,
    remote: emptyRemoteState(),
    local:  { path: null, entries: [], sorted: [], selected: new Set(), anchorIdx: -1, history: [], histIdx: -1 },
    r2rMode: false,
    r2rHost: null,
    presets: [],
    transfers: new Map(),   // jobId -> { direction, originSessionId, key, refreshSide, refreshDir, es, snap, section }
  };

  // ---- API ----
  function extractSessionId(url, body) {
    const m = /[?&]sessionId=([^&]+)/.exec(url);
    if (m) return decodeURIComponent(m[1]);
    if (body && typeof body === 'object' && body.sessionId) return body.sessionId;
    return null;
  }
  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Anything that quacks like a session-level failure: refresh the tab's
      // health flag so the UI can turn the tab red.
      const sid = extractSessionId(url, body);
      const msg = String(data.error || '');
      if (sid && /session|reconnect|connect|ssh|timeout|ECONNRE|EHOSTUN|ETIMEDOUT/i.test(msg)) {
        pollSessionStatus(sid);
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }
  const Api = {
    connect:       (creds)        => api('POST', '/api/connect', creds),
    disconnect:    (sessionId)    => api('POST', '/api/disconnect', { sessionId }),
    sessionStatus: (sid)          => api('GET',  `/api/session/status?sessionId=${encodeURIComponent(sid)}`),
    remoteLs:      (sid, p)       => api('GET',  `/api/ls?sessionId=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}`),
    remoteMkdir:   (sid, p)       => api('POST', '/api/mkdir', { sessionId: sid, path: p }),
    remoteStat:    (sid, p)       => api('GET',  `/api/stat?sessionId=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}`),
    localLs:       (p)            => api('GET',  p ? `/api/local/ls?path=${encodeURIComponent(p)}` : '/api/local/ls'),
    localMkdir:    (p)            => api('POST', '/api/local/mkdir', { path: p }),
    localStat:     (p)            => api('GET',  `/api/local/stat?path=${encodeURIComponent(p)}`),
    startTransfer: (body)         => api('POST', '/api/transfer', body),
    startR2R:      (body)         => api('POST', '/api/r2r', body),
    appendTransfer:(jobId, items) => api('POST', `/api/transfer/${jobId}/append`, { items }),
    cancelTransfer:(jobId, leafId)=> api('POST', `/api/transfer/${jobId}/cancel`, leafId != null ? { leafId } : {}),
    fileop:        (body)         => api('POST', '/api/fileop', body),
    listPresets:   ()             => api('GET',  '/api/presets'),
    savePreset:    (p)            => api('POST', '/api/presets', p),
    renamePreset:  (name, newName)=> api('POST', '/api/presets/rename', { name, newName }),
    deletePreset:  (name)         => api('POST', '/api/presets/delete', { name }),
    fetchLog:      (limit)        => api('GET',  limit ? `/api/log?limit=${limit}` : '/api/log'),
    clearLog:      ()             => api('POST', '/api/log/clear'),
  };

  // ---- Tab health (auto-reconnect feedback) ----
  function setTabStatus(sessionId, status) {
    let changed = false;
    for (const tab of state.tabs) {
      if (tab.session.sessionId === sessionId && tab.status !== status) {
        tab.status = status;
        changed = true;
      }
    }
    if (changed) renderTabs();
  }
  async function pollSessionStatus(sessionId) {
    try {
      const r = await api('GET', `/api/session/status?sessionId=${encodeURIComponent(sessionId)}`);
      // 'missing' means the server has dropped the slot entirely — leave the
      // UI alone; closeTab handles that case via its own cleanup.
      if (r.status === 'connected' || r.status === 'dead' || r.status === 'reconnecting') {
        setTabStatus(sessionId, r.status);
      }
    } catch (_) { /* ignore — polling is best-effort */ }
  }

  // ---- DOM ----
  const $ = (sel) => document.querySelector(sel);
  const dom = {
    tabs:           $('#tabs'),
    connectBtn:     $('#connect-btn'),
    loginDialog:    $('#login-dialog'),
    loginForm:      $('#login-form'),
    loginCancel:    $('#login-cancel'),
    loginError:     $('#login-error'),
    presetSelect:   $('#preset-select'),
    presetSave:     $('#preset-save'),
    presetRename:   $('#preset-rename'),
    presetDelete:   $('#preset-delete'),
    conflictDialog: $('#conflict-dialog'),
    conflictMessage:$('#conflict-message'),
    remotePane:     $('#pane-remote'),
    localPane:      $('#pane-local'),
    remotePath:     $('#remote-path'),
    localPath:      $('#local-path'),
    remoteTree:     $('#remote-tree'),
    localTree:      $('#local-tree'),
    statusBar:      $('#status-bar'),
    transferList:   $('#transfer-list'),
    panes:          $('.panes'),
    splitter:       $('#pane-splitter'),
    r2rToggle:      $('#r2r-toggle'),
    r2rHostSelect:  $('#r2r-host-select'),
    rightTitle:     $('#right-title'),
    logBtn:         $('#log-btn'),
    logDialog:      $('#log-dialog'),
    logList:        $('#log-list'),
    logRefresh:     $('#log-refresh'),
    logClear:       $('#log-clear'),
    logClose:       $('#log-close'),
    dateToggle:     $('#date-toggle'),
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
  function fmtDate(secs) {
    if (!secs) return '';
    const d = new Date(secs * 1000);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function basename(p) {
    const trimmed = String(p).replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return idx < 0 ? trimmed : trimmed.slice(idx + 1);
  }

  // ---- File type icons (by extension) ----
  const EXT_ICONS = {
    // image
    jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼', webp: '🖼', svg: '🖼',
    bmp: '🖼', ico: '🖼', tif: '🖼', tiff: '🖼', heic: '🖼', avif: '🖼',
    // video
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬', flv: '🎬', m4v: '🎬', wmv: '🎬',
    // audio
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', m4a: '🎵', aac: '🎵', opus: '🎵',
    // archive
    zip: '🗜', tar: '🗜', gz: '🗜', bz2: '🗜', xz: '🗜', '7z': '🗜', rar: '🗜', tgz: '🗜', txz: '🗜',
    // code / scripts
    js: '📜', mjs: '📜', cjs: '📜', ts: '📜', tsx: '📜', jsx: '📜', vue: '📜', svelte: '📜',
    py: '📜', go: '📜', rs: '📜', java: '📜', kt: '📜', c: '📜', cc: '📜', cpp: '📜',
    h: '📜', hpp: '📜', cs: '📜', swift: '📜', rb: '📜', php: '📜',
    sh: '📜', bash: '📜', zsh: '📜', ps1: '📜', lua: '📜', sql: '📜',
    html: '📜', htm: '📜', css: '📜', scss: '📜', less: '📜',
    // data / config
    json: '🧾', yaml: '🧾', yml: '🧾', toml: '🧾', ini: '🧾', env: '🧾',
    xml: '🧾', csv: '🧾', tsv: '🧾',
    // documents
    pdf: '📕',
    doc: '📘', docx: '📘',
    xls: '📗', xlsx: '📗',
    ppt: '📙', pptx: '📙',
    md: '📝', markdown: '📝', txt: '📝', rst: '📝', log: '📝',
    // executable / installer
    exe: '⚙', msi: '⚙', app: '⚙', dmg: '⚙', deb: '⚙', rpm: '⚙', apk: '⚙', bin: '⚙',
    // disk image
    iso: '💿', img: '💿',
    // font
    ttf: '🔤', otf: '🔤', woff: '🔤', woff2: '🔤',
  };
  function fileIcon(name, isDirectory) {
    if (isDirectory) return '📁';
    const m = /\.([^.]+)$/.exec(name || '');
    if (!m) return '📄';
    return EXT_ICONS[m[1].toLowerCase()] || '📄';
  }

  // ---- Selection helpers ----
  function paneState(side) {
    if (side === 'remote') return state.remote;
    if (side === 'r2r') return state.r2rHost.remote;
    return state.local;
  }
  function sessionIdForSide(side) {
    if (side === 'remote') return state.session && state.session.sessionId;
    if (side === 'r2r') return state.r2rHost && state.r2rHost.session.sessionId;
    return null;
  }
  function clearSelection(side) {
    const p = paneState(side);
    p.selected.clear();
    p.anchorIdx = -1;
    refreshSelectionClasses(side);
    updateActionButtons();
  }

  function updateActionButtons() {
    for (const paneEl of [dom.remotePane, dom.localPane]) {
      const side = paneEl.dataset.side;
      const p = paneState(side);
      if (!p) continue;
      const count = p.selected.size;
      paneEl.querySelectorAll('[data-action="delete"], [data-action="copy"]').forEach((b) => {
        b.disabled = count < 1;
      });
      paneEl.querySelectorAll('[data-action="rename"]').forEach((b) => {
        b.disabled = count !== 1;
      });
    }
  }
  function refreshSelectionClasses(side) {
    const ul = side === 'remote' ? dom.remoteTree : dom.localTree;
    const sel = paneState(side).selected;
    ul.querySelectorAll('li[data-path]').forEach((li) => {
      if (sel.has(li.dataset.path)) li.classList.add('selected');
      else li.classList.remove('selected');
    });
  }
  function handleRowClick(ev, side, idx, fullPath) {
    const p = paneState(side);
    if (ev.shiftKey && p.anchorIdx >= 0) {
      const [lo, hi] = idx < p.anchorIdx ? [idx, p.anchorIdx] : [p.anchorIdx, idx];
      p.selected.clear();
      for (let i = lo; i <= hi; i++) {
        const e = p.sorted[i];
        if (e) p.selected.add(rowPath(side, p.path, e.name));
      }
    } else if (ev.ctrlKey || ev.metaKey) {
      if (p.selected.has(fullPath)) p.selected.delete(fullPath);
      else p.selected.add(fullPath);
      p.anchorIdx = idx;
    } else {
      p.selected.clear();
      p.selected.add(fullPath);
      p.anchorIdx = idx;
    }
    refreshSelectionClasses(side);
    updateActionButtons();
  }
  function rowPath(side, currentPath, name) {
    // Both 'remote' and 'r2r' use POSIX paths; only 'local' uses Windows-ish joining.
    return side === 'local' ? joinLocal(currentPath, name) : posixJoin(currentPath, name);
  }

  // ---- Rendering ----
  function renderTree(ul, side, currentPath, entries, onDirOpen) {
    ul.replaceChildren();
    const p = paneState(side);
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '(empty)';
      ul.appendChild(li);
      p.sorted = [];
      return;
    }
    const sorted = entries.slice().sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    p.sorted = sorted;
    sorted.forEach((e, idx) => {
      const fullPath = rowPath(side, currentPath, e.name);
      const li = document.createElement('li');
      li.className = e.isDirectory ? 'dir' : 'file';
      if (p.selected.has(fullPath)) li.classList.add('selected');
      li.draggable = true;
      li.dataset.side = side;
      li.dataset.path = fullPath;
      li.dataset.name = e.name;
      li.dataset.isDir = e.isDirectory ? '1' : '0';
      li.dataset.index = String(idx);

      const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = fileIcon(e.name, e.isDirectory);
      const name = document.createElement('span'); name.className = 'name'; name.textContent = e.name;
      const size = document.createElement('span'); size.className = 'size'; size.textContent = e.isDirectory ? '' : fmtSize(e.size);
      const date = document.createElement('span'); date.className = 'date'; date.textContent = fmtDate(e.mtime);
      li.append(icon, name, size, date);

      li.addEventListener('click', (ev) => {
        ev.stopPropagation();
        handleRowClick(ev, side, idx, fullPath);
      });
      if (e.isDirectory) li.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onDirOpen(e);
      });

      li.addEventListener('dragstart', (ev) => {
        // If this row isn't part of the selection, replace selection with just this row.
        if (!p.selected.has(fullPath)) {
          p.selected.clear();
          p.selected.add(fullPath);
          p.anchorIdx = idx;
          refreshSelectionClasses(side);
        }
        const items = sorted
          .map((entry) => ({ entry, path: rowPath(side, currentPath, entry.name) }))
          .filter((x) => p.selected.has(x.path))
          .map((x) => ({ path: x.path, name: x.entry.name, isDirectory: x.entry.isDirectory }));
        ev.dataTransfer.effectAllowed = 'copy';
        ev.dataTransfer.setData('application/json', JSON.stringify({ side, items }));
        // Mark dragging on every selected row
        ul.querySelectorAll('li.selected').forEach((el) => el.classList.add('dragging'));
        if (items.length > 1) {
          // Custom drag image showing count
          try {
            const ghost = document.createElement('div');
            ghost.className = 'drag-ghost';
            ghost.textContent = `${items.length} items`;
            document.body.appendChild(ghost);
            ev.dataTransfer.setDragImage(ghost, 12, 12);
            setTimeout(() => ghost.remove(), 0);
          } catch (_) {}
        }
      });
      li.addEventListener('dragend', () => {
        ul.querySelectorAll('li.dragging').forEach((el) => el.classList.remove('dragging'));
      });

      ul.appendChild(li);
    });
  }

  function renderMessage(ul, cls, msg) {
    ul.replaceChildren();
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = msg;
    ul.appendChild(li);
  }

  // ---- Loaders ----
  async function loadRemote(p, { record = true } = {}) {
    if (!state.session) return;
    clearSelection('remote');
    renderMessage(dom.remoteTree, 'loading', 'loading…');
    const sid = state.session.sessionId;
    try {
      const data = await Api.remoteLs(sid, p || '.');
      state.remote.path = data.path;
      state.remote.entries = data.entries;
      renderBreadcrumb('remote', dom.remotePath, data.path);
      renderTree(dom.remoteTree, 'remote', data.path, data.entries,
        (e) => loadRemote(posixJoin(data.path, e.name)));
      if (record) recordHistory(state.remote, data.path);
      updateHistButtons('remote');
      // ls succeeded — if the tab was marked dead/reconnecting, the lazy
      // backend reconnect just brought it back. Reflect that.
      setTabStatus(sid, 'connected');
    } catch (err) {
      renderMessage(dom.remoteTree, 'error', 'remote: ' + err.message);
    }
  }

  async function loadLocal(p, { record = true } = {}) {
    clearSelection('local');
    renderMessage(dom.localTree, 'loading', 'loading…');
    try {
      const data = await Api.localLs(p);
      state.local.path = data.path;
      state.local.entries = data.entries;
      renderBreadcrumb('local', dom.localPath, data.path);
      renderTree(dom.localTree, 'local', data.path, data.entries,
        (e) => loadLocal(joinLocal(data.path, e.name)));
      if (record) recordHistory(state.local, data.path);
      updateHistButtons('local');
    } catch (err) {
      renderMessage(dom.localTree, 'error', 'local: ' + err.message);
    }
  }

  async function loadR2R(p, { record = true } = {}) {
    if (!state.r2rHost) return;
    clearSelection('r2r');
    renderMessage(dom.localTree, 'loading', 'loading…');
    try {
      const data = await Api.remoteLs(state.r2rHost.session.sessionId, p || '.');
      state.r2rHost.remote.path = data.path;
      state.r2rHost.remote.entries = data.entries;
      renderBreadcrumb('r2r', dom.localPath, data.path);
      renderTree(dom.localTree, 'r2r', data.path, data.entries,
        (e) => loadR2R(posixJoin(data.path, e.name)));
      if (record) recordHistory(state.r2rHost.remote, data.path);
      updateHistButtons('r2r');
    } catch (err) {
      renderMessage(dom.localTree, 'error', 'r2r: ' + err.message);
    }
  }

  function navigateSide(side, p, opts) {
    if (side === 'remote') return loadRemote(p, opts);
    if (side === 'r2r')    return loadR2R(p, opts);
    return loadLocal(p, opts);
  }

  // ---- Breadcrumb path bar ----
  // The path header is a row of clickable/droppable segments: click an ancestor
  // to navigate there; drag files onto an ancestor to move (same side) or
  // transfer (cross side) them into it.
  function pathSegments(side, fullPath) {
    const raw = String(fullPath);
    if (side === 'local') {
      const norm = raw.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
      if (norm === '') return [{ label: '/', path: '/' }];
      const parts = norm.split('/');
      const segs = [];
      let acc = '';
      parts.forEach((part, i) => {
        if (i === 0) {
          if (part === '') { acc = '/'; segs.push({ label: '/', path: '/' }); }
          else { acc = part + '/'; segs.push({ label: part, path: acc }); }   // drive: "C:" -> "C:/"
        } else {
          acc = acc.replace(/\/+$/, '') + '/' + part;
          segs.push({ label: part, path: acc });
        }
      });
      return segs;
    }
    // posix (remote / r2r)
    const norm = raw.replace(/\/+$/, '');
    const segs = [{ label: '/', path: '/' }];
    let acc = '';
    norm.split('/').forEach((part) => {
      if (part === '') return;
      acc = acc + '/' + part;
      segs.push({ label: part, path: acc });
    });
    return segs;
  }

  function renderBreadcrumb(side, el, fullPath) {
    el.replaceChildren();
    if (!fullPath) { el.textContent = '—'; el.title = ''; return; }
    el.title = fullPath;
    const segs = pathSegments(side, fullPath);
    segs.forEach((seg, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        el.appendChild(sep);
      }
      const isCurrent = i === segs.length - 1;
      const crumb = document.createElement('span');
      crumb.className = 'crumb' + (isCurrent ? ' crumb-current' : '');
      crumb.textContent = seg.label;
      crumb.title = seg.path;
      // The current dir (last crumb) is neither a nav target nor a drop target —
      // dropping there would just be a move-into-same-folder. Only ancestors act.
      if (!isCurrent) {
        crumb.addEventListener('click', (ev) => {
          ev.stopPropagation();
          navigateSide(side, seg.path);
        });
        crumb.addEventListener('dragover', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          ev.dataTransfer.dropEffect = 'copy';
          crumb.classList.add('drag-over');
        });
        crumb.addEventListener('dragleave', () => crumb.classList.remove('drag-over'));
        crumb.addEventListener('drop', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          crumb.classList.remove('drag-over');
          let payload;
          try { payload = JSON.parse(ev.dataTransfer.getData('application/json')); }
          catch { return; }
          if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) return;
          if (payload.side === side) doMove(side, payload.items, seg.path);
          else initiateTransfer(payload.side, payload.items, side, seg.path);
        });
      }
      el.appendChild(crumb);
    });
    el.scrollLeft = el.scrollWidth;   // keep the current dir (rightmost) in view
  }

  // ---- Per-pane navigation history (back / forward) ----
  function recordHistory(pane, resolvedPath) {
    if (!pane) return;
    if (pane.histIdx >= 0 && pane.history[pane.histIdx] === resolvedPath) return;   // dedupe refresh
    pane.history = pane.history.slice(0, pane.histIdx + 1);   // drop the forward branch
    pane.history.push(resolvedPath);
    pane.histIdx = pane.history.length - 1;
  }

  function updateHistButtons(side) {
    const paneEl = side === 'remote' ? dom.remotePane : dom.localPane;
    const pane = paneState(side);
    const back = paneEl.querySelector('[data-action="back"]');
    const fwd = paneEl.querySelector('[data-action="forward"]');
    if (back) back.disabled = !pane || pane.histIdx <= 0;
    if (fwd) fwd.disabled = !pane || pane.histIdx >= pane.history.length - 1;
  }

  function goBack(side) {
    const pane = paneState(side);
    if (!pane || pane.histIdx <= 0) return;
    pane.histIdx -= 1;
    navigateSide(side, pane.history[pane.histIdx], { record: false });
  }
  function goForward(side) {
    const pane = paneState(side);
    if (!pane || pane.histIdx >= pane.history.length - 1) return;
    pane.histIdx += 1;
    navigateSide(side, pane.history[pane.histIdx], { record: false });
  }

  // ---- Pane action buttons (..  mkdir  refresh  delete  rename  copy) ----
  // Read side from the button's data-side at event time so r2r mode (which
  // flips the right pane's data-side to 'r2r') is picked up automatically.
  function backendSide(side) {
    return side === 'local' ? 'local' : 'remote';
  }

  function fileopBody(side, op, extra) {
    const body = Object.assign({ side: backendSide(side), op }, extra);
    if (side === 'remote' || side === 'r2r') body.sessionId = sessionIdForSide(side);
    return body;
  }

  function generateCopyName(originalName, existingNames) {
    // Insert "(copy)" before the extension (Windows-style); bump number on collision.
    const dot = originalName.lastIndexOf('.');
    const hasExt = dot > 0;
    const stem = hasExt ? originalName.slice(0, dot) : originalName;
    const ext = hasExt ? originalName.slice(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${i})${ext}`;
      if (!existingNames.has(candidate)) return candidate;
    }
    return `${stem} (copy ${Date.now()})${ext}`;
  }

  async function doDelete(side) {
    const pane = paneState(side);
    if (pane.selected.size === 0) return;
    const paths = Array.from(pane.selected);
    const msg = paths.length === 1
      ? `Delete "${basename(paths[0])}" permanently?\nDirectories are removed recursively.`
      : `Delete ${paths.length} items permanently?\nDirectories are removed recursively.`;
    if (!window.confirm(msg)) return;
    try {
      const res = await Api.fileop(fileopBody(side, 'delete', { paths }));
      if (res.errors && res.errors.length) {
        const sample = res.errors.slice(0, 5).map((e) => `• ${basename(e.path)}: ${e.message}`).join('\n');
        const tail = res.errors.length > 5 ? `\n…and ${res.errors.length - 5} more` : '';
        window.alert(`Deleted ${res.count}, ${res.errors.length} failed:\n${sample}${tail}`);
      }
    } catch (err) {
      window.alert('Delete failed: ' + err.message);
    }
    navigateSide(side, pane.path);
  }

  async function doRename(side) {
    const pane = paneState(side);
    if (pane.selected.size !== 1) return;
    const fullPath = Array.from(pane.selected)[0];
    const oldName = basename(fullPath);
    const newName = window.prompt('New name:', oldName);
    if (!newName || newName === oldName) return;
    if (/[\\/]/.test(newName)) { window.alert('name cannot contain / or \\'); return; }
    const parent = pane.path;
    const dst = side === 'local' ? joinLocal(parent, newName) : posixJoin(parent, newName);
    try {
      await Api.fileop(fileopBody(side, 'rename', { src: fullPath, dst }));
    } catch (err) {
      window.alert('Rename failed: ' + err.message);
    }
    navigateSide(side, parent);
  }

  async function doCopy(side) {
    const pane = paneState(side);
    if (pane.selected.size === 0) return;
    const existing = new Set(pane.entries.map((e) => e.name));
    const paths = Array.from(pane.selected);
    const errors = [];
    for (const fullPath of paths) {
      const oldName = basename(fullPath);
      const newName = generateCopyName(oldName, existing);
      existing.add(newName);
      const dst = side === 'local' ? joinLocal(pane.path, newName) : posixJoin(pane.path, newName);
      try {
        await Api.fileop(fileopBody(side, 'copy', { src: fullPath, dst }));
      } catch (err) {
        errors.push(`${oldName}: ${err.message}`);
      }
    }
    if (errors.length) {
      const sample = errors.slice(0, 5).join('\n');
      const tail = errors.length > 5 ? `\n…and ${errors.length - 5} more` : '';
      window.alert(`Copy errors:\n${sample}${tail}`);
    }
    navigateSide(side, pane.path);
  }

  async function doMove(side, items, dstDir) {
    if (!items.length) return;
    const pane = paneState(side);
    // No-op if every item already lives in the drop target.
    const parentOf = (p) => side === 'local'
      ? p.replace(/[\\/][^\\/]+$/, '') || pane.path
      : posixParent(p);
    const allHere = items.every((it) => parentOf(it.path) === dstDir);
    if (allHere) return;

    // Conflict detection against the destination listing.
    let dstEntries = null;
    if (pane.path === dstDir) dstEntries = pane.entries;
    else {
      try {
        const data = side === 'local'
          ? await Api.localLs(dstDir)
          : await Api.remoteLs(sessionIdForSide(side), dstDir);
        dstEntries = data.entries;
      } catch (_) {}
    }
    let workingItems = items.slice();
    if (dstEntries) {
      const names = new Set(dstEntries.map((e) => e.name));
      const conflicts = workingItems.filter((it) => names.has(it.name));
      if (conflicts.length) {
        const action = await askBatchConflict(conflicts.map((c) => c.name), dstDir);
        if (action === 'cancel') return;
        if (action === 'skip') {
          const set = new Set(conflicts.map((c) => c.name));
          workingItems = workingItems.filter((it) => !set.has(it.name));
        }
        // 'overwrite' is not a thing for rename — it would error. Treat as skip.
        if (action === 'overwrite') {
          const set = new Set(conflicts.map((c) => c.name));
          workingItems = workingItems.filter((it) => !set.has(it.name));
        }
      }
    }
    if (!workingItems.length) { navigateSide(side, pane.path); return; }

    const errors = [];
    for (const it of workingItems) {
      const dst = side === 'local' ? joinLocal(dstDir, it.name) : posixJoin(dstDir, it.name);
      try {
        await Api.fileop(fileopBody(side, 'move', { src: it.path, dst }));
      } catch (err) {
        errors.push(`${it.name}: ${err.message}`);
      }
    }
    if (errors.length) {
      const sample = errors.slice(0, 5).join('\n');
      const tail = errors.length > 5 ? `\n…and ${errors.length - 5} more` : '';
      window.alert(`Move errors:\n${sample}${tail}`);
    }
    navigateSide(side, pane.path);
  }

  // Select a single entry by name in the freshly loaded listing — used after a
  // path search that resolved to a file: we navigate to the folder, then
  // highlight (and scroll to) the file so the user sees where it landed.
  function selectEntryByName(side, name) {
    const pane = paneState(side);
    const idx = pane.sorted.findIndex((e) => e.name === name);
    if (idx < 0) return;
    const fullPath = rowPath(side, pane.path, pane.sorted[idx].name);
    pane.selected.clear();
    pane.selected.add(fullPath);
    pane.anchorIdx = idx;
    refreshSelectionClasses(side);
    updateActionButtons();
    const ul = side === 'remote' ? dom.remoteTree : dom.localTree;
    const li = ul.querySelector(`li[data-path="${CSS.escape(fullPath)}"]`);
    if (li) li.scrollIntoView({ block: 'nearest' });
  }

  async function doGoto(side) {
    const pane = paneState(side);
    const input = window.prompt('Go to path — a directory opens, a file opens its folder:', pane.path || '');
    if (input == null) return;
    const target = input.trim();
    if (!target) return;
    let info;
    try {
      info = side === 'local'
        ? await Api.localStat(target)
        : await Api.remoteStat(sessionIdForSide(side), target);
    } catch (err) {
      window.alert('Path not found: ' + err.message);
      return;
    }
    await navigateSide(side, info.dir);
    if (!info.isDirectory && info.name) selectEntryByName(side, info.name);
  }

  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const side = btn.dataset.side;
      const action = btn.dataset.action;
      if ((side === 'remote' || side === 'r2r') && !sessionIdForSide(side)) return;
      const pane = paneState(side);

      if (action === 'up') {
        if (!pane.path) return;
        const parent = side === 'local' ? parentLocal(pane.path) : posixParent(pane.path);
        navigateSide(side, parent);
      } else if (action === 'refresh') {
        // If the active tab might be dead, poll status alongside the reload so
        // the UI can update its colour as soon as the reconnect resolves.
        const sid = sessionIdForSide(side);
        if (sid) pollSessionStatus(sid);
        navigateSide(side, pane.path || (side === 'local' ? undefined : '.'));
      } else if (action === 'mkdir') {
        if (!pane.path) return;
        const name = window.prompt(`New folder name in:\n${pane.path}`);
        if (!name) return;
        const target = side === 'local' ? joinLocal(pane.path, name) : posixJoin(pane.path, name);
        try {
          if (side === 'remote' || side === 'r2r') {
            await Api.remoteMkdir(sessionIdForSide(side), target);
          } else {
            await Api.localMkdir(target);
          }
          navigateSide(side, pane.path);
        } catch (err) {
          window.alert('mkdir failed: ' + err.message);
        }
      } else if (action === 'back') {
        goBack(side);
      } else if (action === 'forward') {
        goForward(side);
      } else if (action === 'goto') {
        await doGoto(side);
      } else if (action === 'delete') {
        await doDelete(side);
      } else if (action === 'rename') {
        await doRename(side);
      } else if (action === 'copy') {
        await doCopy(side);
      }
    });
  });

  // ---- Click-on-background clears selection for that side ----
  function setupBackgroundClick(paneEl) {
    paneEl.addEventListener('click', (ev) => {
      if (ev.target.closest('li[data-path]')) return;
      if (ev.target.closest('button')) return;
      if (ev.target.closest('select')) return;
      clearSelection(paneEl.dataset.side);
    });
  }
  setupBackgroundClick(dom.remotePane);
  setupBackgroundClick(dom.localPane);

  // ---- Drag-and-drop wiring ----
  function setupDropZone(paneEl) {
    function clearHighlights() {
      paneEl.classList.remove('drag-into-pane');
      paneEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    }
    paneEl.addEventListener('dragover', (ev) => {
      const side = paneEl.dataset.side;
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
      const side = paneEl.dataset.side;
      ev.preventDefault();
      clearHighlights();
      let payload;
      try { payload = JSON.parse(ev.dataTransfer.getData('application/json')); }
      catch { return; }
      if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) return;
      if (side === 'remote' && !state.session) { window.alert('connect to a remote host first'); return; }
      if (side === 'r2r' && !state.r2rHost)   { window.alert('pick a destination host first'); return; }
      const folderLi = ev.target.closest && ev.target.closest('li.dir');
      let targetDir;
      if (folderLi && folderLi.dataset.side === side) {
        targetDir = folderLi.dataset.path;
      } else {
        targetDir = paneState(side).path;
      }
      if (!targetDir) return;
      // Same pane (local→local, remote→remote on the active host, r2r→r2r):
      // intra-host move, not a transfer. Dropping back into the same parent is
      // a no-op (doMove handles that).
      if (payload.side === side) {
        doMove(side, payload.items, targetDir);
        return;
      }
      initiateTransfer(payload.side, payload.items, side, targetDir);
    });
  }
  setupDropZone(dom.remotePane);
  setupDropZone(dom.localPane);

  // ---- Drag auto-scroll ----
  // The browser suppresses the mouse wheel during a native drag, so a long list
  // can't be scrolled to reach off-screen rows (or the breadcrumb) mid-drag.
  // While dragging near a tree's top/bottom edge, scroll it automatically.
  function setupDragAutoScroll(ul) {
    const EDGE = 90;        // px band at top/bottom that triggers scrolling
    const MIN_SPEED = 3;    // px/frame at the inner edge of the band (gentle)
    const MAX_SPEED = 30;   // px/frame right at the very edge (fast)
    let speed = 0;          // signed px/frame; 0 = idle
    let raf = null;
    function tick() {
      if (speed === 0) { raf = null; return; }
      ul.scrollTop += speed;
      raf = requestAnimationFrame(tick);
    }
    function stop() { speed = 0; if (raf !== null) { cancelAnimationFrame(raf); raf = null; } }
    // Speed ramps with depth into the band: gentle near the inner edge, fastest
    // right at the top/bottom edge (t: 0 → 1).
    const rampSpeed = (dist) => {
      const t = Math.max(0, Math.min(1, (EDGE - dist) / EDGE));
      return MIN_SPEED + t * (MAX_SPEED - MIN_SPEED);
    };
    ul.addEventListener('dragover', (ev) => {
      const rect = ul.getBoundingClientRect();
      const topDist = ev.clientY - rect.top;
      const botDist = rect.bottom - ev.clientY;
      if (topDist < EDGE) speed = -rampSpeed(topDist);
      else if (botDist < EDGE) speed = rampSpeed(botDist);
      else speed = 0;
      if (speed !== 0 && raf === null) raf = requestAnimationFrame(tick);
    });
    ul.addEventListener('dragleave', (ev) => { if (!ul.contains(ev.relatedTarget)) stop(); });
    ul.addEventListener('drop', stop);
    ul.addEventListener('dragend', stop);
  }
  setupDragAutoScroll(dom.remoteTree);
  setupDragAutoScroll(dom.localTree);

  // ---- Conflict dialog (batch-aware) ----
  function askBatchConflict(conflictNames, targetDir) {
    return new Promise((resolve) => {
      const n = conflictNames.length;
      const sample = conflictNames.slice(0, 3).map((x) => `"${x}"`).join(', ');
      const tail = n > 3 ? ` and ${n - 3} more` : '';
      dom.conflictMessage.textContent = n === 1
        ? `${sample} already exists in ${targetDir}`
        : `${n} items already exist in ${targetDir}: ${sample}${tail}`;
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
  async function initiateTransfer(srcSide, srcItems, dstSide, dstDir) {
    // 1) Detect conflicts against dst dir listing
    let dstEntries = null;
    const visible = paneState(dstSide);
    if (visible && visible.path === dstDir) {
      dstEntries = visible.entries;
    } else {
      try {
        let data;
        if (dstSide === 'remote') data = await Api.remoteLs(sessionIdForSide('remote'), dstDir);
        else if (dstSide === 'r2r') data = await Api.remoteLs(sessionIdForSide('r2r'), dstDir);
        else data = await Api.localLs(dstDir);
        dstEntries = data.entries;
      } catch (_) { dstEntries = null; }
    }
    let workingItems = srcItems.slice();
    if (dstEntries) {
      const existingNames = new Set(dstEntries.map((e) => e.name));
      const conflicts = workingItems.filter((it) => existingNames.has(it.name));
      if (conflicts.length) {
        const action = await askBatchConflict(conflicts.map((c) => c.name), dstDir);
        if (action === 'cancel') return;
        if (action === 'skip') {
          const conflictSet = new Set(conflicts.map((c) => c.name));
          workingItems = workingItems.filter((it) => !conflictSet.has(it.name));
        }
        // 'overwrite': keep workingItems as-is (sftp.fastPut overwrites; fs writeFile overwrites)
      }
    }
    if (!workingItems.length) return;

    // 2) Build batch payload (path joiner depends on destination side)
    const joinForDst = (dstSide === 'local') ? joinLocal : posixJoin;
    const items = workingItems.map((it) => ({ src: it.path, dst: joinForDst(dstDir, it.name) }));

    const isR2R = (srcSide === 'remote' || srcSide === 'r2r')
               && (dstSide === 'remote' || dstSide === 'r2r')
               && srcSide !== dstSide;
    try {
      if (isR2R) {
        const srcSessionId = sessionIdForSide(srcSide);
        const dstSessionId = sessionIdForSide(dstSide);
        const { jobId } = await Api.startR2R({ srcSessionId, dstSessionId, items });
        streamProgress(jobId, 'r2r', dstSide, dstDir, dstSessionId);
      } else {
        const direction = (srcSide === 'local') ? 'upload' : 'download';
        const originSessionId = sessionIdForSide('remote');
        // Same tab + same direction while a transfer runs: fold these files into
        // the running job instead of starting a second one (no channel sharing).
        const existing = findAppendable(originSessionId, direction);
        if (existing) {
          const { ok } = await Api.appendTransfer(existing.jobId, items);
          if (ok) {
            existing.refreshSide = dstSide;
            existing.refreshDir = dstDir;
            return;
          }
        }
        const { jobId } = await Api.startTransfer({ direction, sessionId: originSessionId, items });
        streamProgress(jobId, direction, dstSide, dstDir, originSessionId);
      }
    } catch (err) {
      window.alert('transfer failed: ' + err.message);
    }
  }

  function findAppendable(originSessionId, direction) {
    const key = originSessionId + '|' + direction;
    for (const t of state.transfers.values()) {
      if (t.key === key) return t;
    }
    return null;
  }

  // ---- Progress UI ----
  // Each running job gets its own section in the status bar. Concurrent jobs on
  // one host only happen for opposite-direction / R2R drops (same-direction
  // drops are folded into the running job by initiateTransfer). Rows are mutated
  // in place (by leaf.id) to avoid a full re-render on each tick.
  function iconFor(leaf) {
    return fileIcon(leaf.name, false);
  }

  function makeLeafRow(jobId, leaf) {
    const li = document.createElement('li');
    li.className = 'leaf';
    li.dataset.id = String(leaf.id);
    li.dataset.status = leaf.status;

    const icon = document.createElement('span'); icon.className = 'leaf-icon'; icon.textContent = iconFor(leaf);
    const name = document.createElement('span'); name.className = 'leaf-name'; name.textContent = leaf.name; name.title = leaf.name;
    const bar = document.createElement('span'); bar.className = 'leaf-bar';
    const fill = document.createElement('span'); fill.className = 'leaf-fill';
    bar.appendChild(fill);
    const meta = document.createElement('span'); meta.className = 'leaf-meta';
    const cancel = document.createElement('button');
    cancel.className = 'leaf-cancel'; cancel.type = 'button';
    cancel.textContent = '✕'; cancel.title = 'Cancel this file';
    cancel.addEventListener('click', () => { cancel.disabled = true; Api.cancelTransfer(jobId, leaf.id).catch(() => {}); });

    li.append(icon, name, bar, meta, cancel);
    return { el: li, fill, meta, name, cancel };
  }

  function applyLeafState(entry, leaf) {
    entry.el.dataset.status = leaf.status;
    const terminal = leaf.status === 'done' || leaf.status === 'error' || leaf.status === 'cancelled';
    entry.cancel.hidden = terminal;
    if (leaf.status === 'active') {
      const pct = leaf.size > 0 ? (leaf.transferred / leaf.size) * 100 : 0;
      entry.fill.style.width = pct.toFixed(0) + '%';
      entry.meta.textContent = `${fmtSize(leaf.transferred)} / ${fmtSize(leaf.size)}`;
      entry.meta.title = '';
    } else if (leaf.status === 'done') {
      entry.meta.textContent = fmtSize(leaf.size) + '  ✓';
      entry.meta.title = '';
    } else if (leaf.status === 'error') {
      entry.meta.textContent = '✗ ' + (leaf.error || 'error');
      entry.meta.title = leaf.error || '';
    } else if (leaf.status === 'cancelled') {
      entry.meta.textContent = '✕ cancelled';
      entry.meta.title = '';
    } else { // waiting
      entry.fill.style.width = '0%';
      entry.meta.textContent = fmtSize(leaf.size);
      entry.meta.title = '';
    }
  }

  function ensureSection(t) {
    if (t.section) return t.section;
    const root = document.createElement('div'); root.className = 'job-section'; root.dataset.jobId = t.jobId;
    const header = document.createElement('div'); header.className = 'job-header';
    const text = document.createElement('span'); text.className = 'job-text'; text.textContent = 'Preparing…';
    const track = document.createElement('div'); track.className = 'progress-track';
    const fill = document.createElement('div'); fill.className = 'progress-fill'; track.appendChild(fill);
    const meta = document.createElement('span'); meta.className = 'job-meta';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'job-cancel'; cancelBtn.type = 'button';
    cancelBtn.textContent = '✕'; cancelBtn.title = 'Cancel all';
    cancelBtn.addEventListener('click', () => { cancelBtn.disabled = true; Api.cancelTransfer(t.jobId).catch(() => {}); });
    header.append(text, track, meta, cancelBtn);
    const list = document.createElement('ul'); list.className = 'transfer-list';
    root.append(header, list);
    dom.transferList.appendChild(root);
    t.section = { root, fill, text, meta, cancelBtn, list, leafRows: new Map() };
    return t.section;
  }

  function updateLeaves(t, leaves) {
    const s = t.section;
    const frag = document.createDocumentFragment();
    let appended = false;
    for (const leaf of leaves) {
      let entry = s.leafRows.get(leaf.id);
      if (!entry) {
        entry = makeLeafRow(t.jobId, leaf);
        s.leafRows.set(leaf.id, entry);
        frag.appendChild(entry.el);
        appended = true;
      }
      applyLeafState(entry, leaf);
    }
    if (appended) s.list.appendChild(frag);
  }

  function updateJobSection(t, snap) {
    const s = ensureSection(t);
    const pct = snap.totalBytes > 0
      ? Math.min(100, (snap.transferredBytes / snap.totalBytes) * 100)
      : (snap.totalFiles > 0 ? (snap.doneFiles / snap.totalFiles) * 100 : 0);
    s.fill.style.width = pct.toFixed(1) + '%';

    const verb = snap.cancelled ? 'Cancelling'
              : snap.direction === 'upload' ? 'Uploading'
              : snap.direction === 'download' ? 'Downloading'
              : 'Relaying';
    const counter = snap.totalFiles > 0 ? ` (${snap.doneFiles}/${snap.totalFiles})` : '';
    const active = (snap.leaves || []).filter((l) => l.status === 'active');
    const labelFor = (l) => l.phase ? `${l.name} [${l.phase}]` : l.name;
    const activeLabel = active.length === 0
      ? (snap.totalFiles === 0 ? ' — planning…' : '')
      : active.length === 1
        ? ` — ${labelFor(active[0])}`
        : ` — ${labelFor(active[0])} (+${active.length - 1} more)`;
    s.text.textContent = `${verb}${counter}${activeLabel}`;
    s.meta.textContent = `${fmtSize(snap.transferredBytes)} / ${fmtSize(snap.totalBytes)}  ${pct.toFixed(0)}%`;
    if (snap.cancelled) s.cancelBtn.disabled = true;

    if (snap.leaves && snap.leaves.length) updateLeaves(t, snap.leaves);
  }

  function finishTransfer(t) {
    if (t.section) t.section.root.remove();
    state.transfers.delete(t.jobId);
    if (state.transfers.size === 0) dom.statusBar.hidden = true;
  }

  function autoRefresh(t) {
    // Tab-aware auto-refresh: only refresh if the user hasn't switched away
    // from the originating session/dir while the transfer was running.
    const activeSid = state.session && state.session.sessionId;
    const r2rSid = state.r2rHost && state.r2rHost.session.sessionId;
    if (t.refreshSide === 'remote' && activeSid === t.originSessionId && state.remote.path === t.refreshDir) {
      loadRemote(state.remote.path);
    } else if (t.refreshSide === 'r2r' && r2rSid === t.originSessionId && state.r2rHost.remote.path === t.refreshDir) {
      loadR2R(state.r2rHost.remote.path);
    } else if (t.refreshSide === 'local' && state.local.path === t.refreshDir) {
      loadLocal(state.local.path);
    }
  }

  function streamProgress(jobId, direction, refreshSide, refreshDir, originSessionId) {
    const t = {
      jobId, direction, originSessionId,
      key: originSessionId + '|' + direction,
      refreshSide, refreshDir, es: null, snap: null, section: null,
    };
    state.transfers.set(jobId, t);
    dom.statusBar.hidden = false;
    ensureSection(t);

    const es = new EventSource(`/api/transfer/${jobId}/events`);
    t.es = es;
    es.addEventListener('progress', (e) => {
      try { t.snap = JSON.parse(e.data); updateJobSection(t, t.snap); } catch (_) {}
    });
    es.addEventListener('done', (e) => {
      es.close();
      let data = {};
      try { data = JSON.parse(e.data); } catch (_) {}
      const lastSnap = t.snap;
      const planErrs = (data.errors && data.errors.length) ? data.errors : (lastSnap && lastSnap.errors) || [];
      const leafErrs = (lastSnap && lastSnap.leaves)
        ? lastSnap.leaves.filter((l) => l.status === 'error').map((l) => ({ src: l.name, message: l.error || 'error' }))
        : [];
      const errs = planErrs.concat(leafErrs);
      finishTransfer(t);
      if (errs.length) {
        const summary = errs.slice(0, 5).map((x) => `• ${basename(x.src)}: ${x.message}`).join('\n');
        const tail = errs.length > 5 ? `\n…and ${errs.length - 5} more` : '';
        window.alert(`Transfer finished with ${errs.length} error(s):\n${summary}${tail}`);
      }
      autoRefresh(t);
    });
    es.addEventListener('fail', (e) => {
      es.close();
      finishTransfer(t);
      let data = {};
      try { data = JSON.parse(e.data); } catch (_) {}
      window.alert('transfer error: ' + (data.message || 'unknown'));
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      es.close();
      finishTransfer(t);
      window.alert('transfer stream disconnected');
    };
  }

  // ---- Presets ----
  function populatePresetSelect() {
    const sel = dom.presetSelect;
    const prev = sel.value;
    sel.replaceChildren();
    const none = document.createElement('option');
    none.value = ''; none.textContent = '(none)';
    sel.appendChild(none);
    for (const p of state.presets) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.name}  —  ${p.username}@${p.host}:${p.port}`;
      sel.appendChild(opt);
    }
    if (state.presets.some((p) => p.name === prev)) sel.value = prev;
  }

  async function refreshPresets() {
    try {
      const data = await Api.listPresets();
      state.presets = data.presets || [];
    } catch (_) {
      state.presets = [];
    }
    populatePresetSelect();
  }

  dom.presetSelect.addEventListener('change', () => {
    const p = state.presets.find((x) => x.name === dom.presetSelect.value);
    if (!p) return;
    dom.loginForm.username.value = p.username;
    dom.loginForm.host.value = p.host;
    dom.loginForm.port.value = p.port;
    dom.loginForm.password.value = '';
    dom.loginForm.password.focus();
  });

  dom.presetSave.addEventListener('click', async () => {
    const fd = new FormData(dom.loginForm);
    const username = String(fd.get('username') || '').trim();
    const host = String(fd.get('host') || '').trim();
    const port = Number(fd.get('port')) || 22;
    if (!username || !host) {
      dom.loginError.textContent = 'fill username and host first';
      dom.loginError.hidden = false;
      return;
    }
    const suggested = dom.presetSelect.value || `${username}@${host}`;
    const name = window.prompt('Preset name:', suggested);
    if (!name) return;
    try {
      const data = await Api.savePreset({ name, username, host, port });
      state.presets = data.presets;
      populatePresetSelect();
      dom.presetSelect.value = name;
      dom.loginError.hidden = true;
    } catch (err) {
      dom.loginError.textContent = err.message;
      dom.loginError.hidden = false;
    }
  });

  dom.presetRename.addEventListener('click', async () => {
    const name = dom.presetSelect.value;
    if (!name) return;
    const newName = window.prompt('Rename preset:', name);
    if (!newName || newName === name) return;
    try {
      const data = await Api.renamePreset(name, newName);
      state.presets = data.presets;
      populatePresetSelect();
      dom.presetSelect.value = newName.trim();
      dom.loginError.hidden = true;
    } catch (err) {
      dom.loginError.textContent = err.message;
      dom.loginError.hidden = false;
    }
  });

  dom.presetDelete.addEventListener('click', async () => {
    const name = dom.presetSelect.value;
    if (!name) return;
    if (!window.confirm(`Delete preset "${name}"?`)) return;
    try {
      const data = await Api.deletePreset(name);
      state.presets = data.presets;
      populatePresetSelect();
      dom.presetSelect.value = '';
    } catch (err) {
      dom.loginError.textContent = err.message;
      dom.loginError.hidden = false;
    }
  });

  // ---- Tabs (multi-host) ----
  function sessionLabel(s) {
    return s.port === 22 ? `${s.username}@${s.host}` : `${s.username}@${s.host}:${s.port}`;
  }

  function renderTabs() {
    dom.tabs.replaceChildren();
    state.tabs.forEach((tab, idx) => {
      const el = document.createElement('div');
      let cls = 'tab';
      if (idx === state.activeIdx) cls += ' active';
      if (tab.status === 'dead') cls += ' disconnected';
      else if (tab.status === 'reconnecting') cls += ' reconnecting';
      el.className = cls;
      el.dataset.idx = String(idx);
      el.setAttribute('role', 'tab');
      const label = document.createElement('span');
      label.className = 'tab-label';
      const prefix = tab.status === 'dead' ? '⚠ ' : (tab.status === 'reconnecting' ? '↻ ' : '');
      label.textContent = prefix + sessionLabel(tab.session);
      label.title = tab.status === 'dead'
        ? `${sessionLabel(tab.session)} — disconnected; press Refresh to reconnect`
        : `${sessionLabel(tab.session)}  (sftp)`;
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close tab';
      el.append(label, close);
      el.addEventListener('click', (ev) => {
        if (ev.target === close) {
          ev.stopPropagation();
          closeTab(idx);
        } else if (idx !== state.activeIdx) {
          activateTab(idx);
        }
      });
      dom.tabs.appendChild(el);
    });
  }

  function bindActiveTab() {
    if (state.activeIdx < 0 || state.activeIdx >= state.tabs.length) {
      state.session = null;
      state.remote = emptyRemoteState();
      return;
    }
    const tab = state.tabs[state.activeIdx];
    state.session = tab.session;
    state.remote = tab.remote;
  }

  function activateTab(idx) {
    state.activeIdx = idx;
    bindActiveTab();
    renderTabs();
    if (state.remote.path === null) {
      // First time on this tab — load home dir
      loadRemote('.');
    } else {
      // Restore cached listing without an extra network call
      renderBreadcrumb('remote', dom.remotePath, state.remote.path);
      renderTree(dom.remoteTree, 'remote', state.remote.path, state.remote.entries,
        (e) => loadRemote(posixJoin(state.remote.path, e.name)));
      updateHistButtons('remote');
    }
    refreshR2RAvailability();
  }

  async function closeTab(idx) {
    const tab = state.tabs[idx];
    try { await Api.disconnect(tab.session.sessionId); } catch (_) {}
    state.tabs.splice(idx, 1);
    if (state.tabs.length === 0) {
      state.activeIdx = -1;
      bindActiveTab();
      renderTabs();
      renderBreadcrumb('remote', dom.remotePath, '');
      renderMessage(dom.remoteTree, 'empty', 'connect to a host to browse');
      updateHistButtons('remote');
      refreshR2RAvailability();
      return;
    }
    activateTab(Math.min(idx, state.tabs.length - 1));
  }

  // ---- Login ----
  const loginSubmitBtn = dom.loginForm.querySelector('button[type="submit"]');
  let connectInFlight = false;

  function setLoginBusy(busy) {
    for (const el of dom.loginForm.elements) {
      // Leave the Cancel button enabled so the user can still abort.
      if (el === dom.loginCancel) continue;
      el.disabled = busy;
    }
    loginSubmitBtn.textContent = busy ? 'Connecting…' : 'Connect';
    dom.loginDialog.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function showLogin() {
    dom.loginError.hidden = true;
    dom.loginError.textContent = '';
    refreshPresets();
    dom.loginDialog.showModal();
    setTimeout(() => dom.loginForm.username.focus(), 0);
  }
  dom.connectBtn.addEventListener('click', showLogin);
  dom.loginCancel.addEventListener('click', () => dom.loginDialog.close());

  dom.loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (connectInFlight) return;

    // Read form values BEFORE disabling — disabled inputs are excluded from
    // FormData per spec, which would silently send empty strings.
    const fd = new FormData(dom.loginForm);
    const creds = {
      username: String(fd.get('username') || '').trim(),
      host:     String(fd.get('host') || '').trim(),
      port:     Number(fd.get('port')) || 22,
      password: String(fd.get('password') || ''),
    };

    connectInFlight = true;
    dom.loginError.hidden = true;
    dom.loginError.textContent = '';
    setLoginBusy(true);
    try {
      const data = await Api.connect(creds);
      const tab = {
        session: {
          sessionId: data.sessionId,
          username: data.username,
          host: data.host,
          port: data.port,
        },
        remote: emptyRemoteState(),
        status: 'connected',
      };
      state.tabs.push(tab);
      dom.loginDialog.close();
      dom.loginForm.reset();
      activateTab(state.tabs.length - 1);
    } catch (err) {
      dom.loginError.textContent = err.message;
      dom.loginError.hidden = false;
    } finally {
      connectInFlight = false;
      setLoginBusy(false);
    }
  });

  // ---- R2R mode ----
  function otherTabs() {
    return state.tabs
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => i !== state.activeIdx)
      .map(({ t }) => t);
  }
  function populateR2RSelect() {
    const sel = dom.r2rHostSelect;
    const prevValue = sel.value;
    sel.replaceChildren();
    for (const t of otherTabs()) {
      const opt = document.createElement('option');
      opt.value = t.session.sessionId;
      opt.textContent = sessionLabel(t.session);
      sel.appendChild(opt);
    }
    if (state.r2rHost && otherTabs().some((t) => t.session.sessionId === state.r2rHost.session.sessionId)) {
      sel.value = state.r2rHost.session.sessionId;
    } else if (prevValue && otherTabs().some((t) => t.session.sessionId === prevValue)) {
      sel.value = prevValue;
    }
  }

  function setRightSide(toR2R) {
    const localPane = dom.localPane;
    const side = toR2R ? 'r2r' : 'local';
    localPane.dataset.side = side;
    localPane.querySelectorAll('[data-side]').forEach((el) => { el.dataset.side = side; });
    dom.localTree.dataset.side = side;
  }

  async function enableR2R() {
    const candidates = otherTabs();
    if (candidates.length === 0) return; // toggle should be disabled, but guard anyway
    const dstTab = candidates[0];
    state.r2rMode = true;
    state.r2rHost = { session: dstTab.session, remote: emptyRemoteState() };
    setRightSide(true);
    dom.rightTitle.hidden = true;
    dom.r2rHostSelect.hidden = false;
    populateR2RSelect();
    dom.r2rToggle.classList.add('active');
    await loadR2R('.');
  }

  function disableR2R() {
    state.r2rMode = false;
    state.r2rHost = null;
    setRightSide(false);
    dom.rightTitle.hidden = false;
    dom.r2rHostSelect.hidden = true;
    dom.r2rToggle.classList.remove('active');
    // Restore local listing
    loadLocal(state.local.path || undefined);
  }

  function refreshR2RAvailability() {
    // Called whenever tab set or active tab changes.
    const others = otherTabs();
    dom.r2rToggle.disabled = others.length === 0;
    if (state.r2rMode) {
      if (!state.r2rHost || !others.some((t) => t.session.sessionId === state.r2rHost.session.sessionId)) {
        // Current dst tab is gone (closed) or has become the active tab — turn off
        disableR2R();
      } else {
        populateR2RSelect();
      }
    }
  }

  dom.r2rToggle.addEventListener('click', () => {
    if (dom.r2rToggle.disabled) return;
    if (state.r2rMode) disableR2R();
    else enableR2R();
  });

  dom.r2rHostSelect.addEventListener('change', () => {
    if (!state.r2rMode) return;
    const sid = dom.r2rHostSelect.value;
    const tab = state.tabs.find((t) => t.session.sessionId === sid);
    if (!tab) return;
    state.r2rHost = { session: tab.session, remote: emptyRemoteState() };
    loadR2R('.');
  });

  // ---- Pane splitter (resizable divider) ----
  (function setupSplitter() {
    const MIN = 0.1, MAX = 0.9;
    let dragging = false;
    dom.splitter.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      document.body.classList.add('dragging-splitter');
      dom.splitter.classList.add('dragging');
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      const rect = dom.panes.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (ev.clientX - rect.left) / rect.width;
      const clamped = Math.min(MAX, Math.max(MIN, ratio));
      dom.panes.style.setProperty('--split', String(clamped));
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('dragging-splitter');
      dom.splitter.classList.remove('dragging');
    });
  })();

  // ---- Transfer log viewer ----
  function hostLabel(info) {
    return info ? sessionLabel(info) : 'Local';
  }
  function fmtWhen(ms) {
    if (!ms) return '';
    try { return new Date(ms).toLocaleString(); } catch (_) { return ''; }
  }
  function dirArrow(direction) {
    return direction === 'r2r' ? '⇄' : '→';
  }

  function makeLogFiles(entry) {
    const wrap = document.createElement('ul');
    wrap.className = 'log-files';
    const files = entry.files || [];
    if (!files.length) {
      const li = document.createElement('li');
      li.className = 'log-file empty';
      li.textContent = entry.error ? `(no files) ${entry.error}` : '(no files)';
      wrap.appendChild(li);
      return wrap;
    }
    for (const f of files) {
      const li = document.createElement('li');
      li.className = 'log-file';
      li.dataset.status = f.status;
      const icon = document.createElement('span'); icon.className = 'lf-icon'; icon.textContent = fileIcon(f.name, false);
      const name = document.createElement('span'); name.className = 'lf-name';
      name.textContent = f.name; name.title = `${f.src}  →  ${f.dst}`;
      const size = document.createElement('span'); size.className = 'lf-size'; size.textContent = fmtSize(f.size);
      const st = document.createElement('span'); st.className = 'lf-status';
      st.textContent = f.status === 'error' ? `✗ ${f.error || 'error'}`
                     : f.status === 'cancelled' ? '✕ cancelled'
                     : f.status === 'done' ? '✓'
                     : f.status;
      if (f.error) st.title = f.error;
      li.append(icon, name, size, st);
      wrap.appendChild(li);
    }
    return wrap;
  }

  function makeLogEntry(entry) {
    const li = document.createElement('li');
    li.className = 'log-entry';
    const failed = entry.status === 'error' || entry.errorFiles > 0;
    li.dataset.status = entry.cancelled ? 'cancelled' : (failed ? 'error' : 'done');

    const head = document.createElement('div'); head.className = 'log-entry-head';

    const when = document.createElement('span'); when.className = 'log-when'; when.textContent = fmtWhen(entry.startedAt);
    const route = document.createElement('span'); route.className = 'log-route';
    route.textContent = `${hostLabel(entry.srcHost)} ${dirArrow(entry.direction)} ${hostLabel(entry.dstHost)}`;
    route.title = route.textContent;
    const count = document.createElement('span'); count.className = 'log-count';
    count.textContent = `${entry.okFiles}/${entry.totalFiles} files`;
    if (entry.errorFiles) count.textContent += ` · ${entry.errorFiles} err`;
    if (entry.cancelledFiles) count.textContent += ` · ${entry.cancelledFiles} cancelled`;
    const bytes = document.createElement('span'); bytes.className = 'log-bytes'; bytes.textContent = fmtSize(entry.transferredBytes);
    const badge = document.createElement('span'); badge.className = 'log-badge';
    badge.textContent = entry.cancelled ? 'cancelled' : (failed ? 'error' : 'done');

    head.append(when, route, count, bytes, badge);
    li.appendChild(head);

    // Expand/collapse per-file detail on click.
    let detail = null;
    head.addEventListener('click', () => {
      if (detail) { detail.remove(); detail = null; li.classList.remove('expanded'); return; }
      detail = makeLogFiles(entry);
      li.appendChild(detail);
      li.classList.add('expanded');
    });
    return li;
  }

  function renderLog(entries) {
    dom.logList.replaceChildren();
    if (!entries || !entries.length) {
      const li = document.createElement('li');
      li.className = 'log-empty';
      li.textContent = 'No transfers logged yet.';
      dom.logList.appendChild(li);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of entries) frag.appendChild(makeLogEntry(e));
    dom.logList.appendChild(frag);
  }

  async function openLog() {
    try {
      const data = await Api.fetchLog();
      renderLog(data.entries || []);
    } catch (err) {
      renderLog([]);
      window.alert('Could not load transfer log: ' + err.message);
    }
    if (!dom.logDialog.open) dom.logDialog.showModal();
  }

  dom.logBtn.addEventListener('click', openLog);
  dom.logRefresh.addEventListener('click', openLog);
  dom.logClose.addEventListener('click', () => dom.logDialog.close());
  dom.logClear.addEventListener('click', async () => {
    if (!window.confirm('Clear the entire transfer log?')) return;
    try {
      await Api.clearLog();
      renderLog([]);
    } catch (err) {
      window.alert('Clear failed: ' + err.message);
    }
  });

  // ---- Date column toggle (show/hide modified date in trees) ----
  const SHOW_DATES_KEY = 'dropscp.showDates';
  function applyShowDates(on) {
    document.body.classList.toggle('show-dates', on);
    dom.dateToggle.classList.toggle('active', on);
  }
  function initDateToggle() {
    let on = false;
    try { on = localStorage.getItem(SHOW_DATES_KEY) === '1'; } catch (_) {}
    applyShowDates(on);
    dom.dateToggle.addEventListener('click', () => {
      const next = !document.body.classList.contains('show-dates');
      applyShowDates(next);
      try { localStorage.setItem(SHOW_DATES_KEY, next ? '1' : '0'); } catch (_) {}
    });
  }
  initDateToggle();

  // ---- Init ----
  loadLocal();
})();
