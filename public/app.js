/* dropscp UI — vanilla JS, no build step */
(() => {
  // ---- State ----
  function emptyRemoteState() {
    return { path: null, entries: [], sorted: [], selected: new Set(), anchorIdx: -1 };
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
    local:  { path: null, entries: [], sorted: [], selected: new Set(), anchorIdx: -1 },
    r2rMode: false,
    r2rHost: null,
    presets: [],
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
    startR2R:      (body)         => api('POST', '/api/r2r', body),
    listPresets:   ()             => api('GET',  '/api/presets'),
    savePreset:    (p)            => api('POST', '/api/presets', p),
    deletePreset:  (name)         => api('POST', '/api/presets/delete', { name }),
  };

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
    statusText:     $('#status-text'),
    statusMeta:     $('#status-meta'),
    progressFill:   $('#progress-fill'),
    transferList:   $('#transfer-list'),
    panes:          $('.panes'),
    splitter:       $('#pane-splitter'),
    r2rToggle:      $('#r2r-toggle'),
    r2rHostSelect:  $('#r2r-host-select'),
    rightTitle:     $('#right-title'),
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
      li.append(icon, name, size);

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
  async function loadRemote(p) {
    if (!state.session) return;
    clearSelection('remote');
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
    clearSelection('local');
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

  async function loadR2R(p) {
    if (!state.r2rHost) return;
    clearSelection('r2r');
    renderMessage(dom.localTree, 'loading', 'loading…');
    try {
      const data = await Api.remoteLs(state.r2rHost.session.sessionId, p || '.');
      state.r2rHost.remote.path = data.path;
      state.r2rHost.remote.entries = data.entries;
      setPath(dom.localPath, data.path);
      renderTree(dom.localTree, 'r2r', data.path, data.entries,
        (e) => loadR2R(posixJoin(data.path, e.name)));
    } catch (err) {
      renderMessage(dom.localTree, 'error', 'r2r: ' + err.message);
    }
  }

  function navigateSide(side, p) {
    if (side === 'remote') return loadRemote(p);
    if (side === 'r2r')    return loadR2R(p);
    return loadLocal(p);
  }

  // ---- Pane action buttons (..  mkdir  refresh) ----
  // Read side from the button's data-side at event time so r2r mode (which
  // flips the right pane's data-side to 'r2r') is picked up automatically.
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
      if (payload.side === side) return;
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
      initiateTransfer(payload.side, payload.items, side, targetDir);
    });
  }
  setupDropZone(dom.remotePane);
  setupDropZone(dom.localPane);

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
        await streamProgress(jobId, dstSide, dstDir, dstSessionId);
      } else {
        const direction = (srcSide === 'local') ? 'upload' : 'download';
        const originSessionId = sessionIdForSide('remote');
        const { jobId } = await Api.startTransfer({ direction, sessionId: originSessionId, items });
        await streamProgress(jobId, dstSide, dstDir, originSessionId);
      }
    } catch (err) {
      window.alert('transfer failed: ' + err.message);
    }
  }

  // ---- Progress UI ----
  // Rows are mutated in place (by leaf.id) to avoid full re-render on each tick.
  let leafRows = new Map();

  function showProgress() {
    leafRows = new Map();
    dom.transferList.replaceChildren();
    dom.statusBar.hidden = false;
    dom.progressFill.style.width = '0%';
    dom.statusText.textContent = 'Preparing…';
    dom.statusMeta.textContent = '';
  }
  function hideProgress() {
    dom.statusBar.hidden = true;
    leafRows = new Map();
    dom.transferList.replaceChildren();
  }

  function iconFor(leaf) {
    return fileIcon(leaf.name, false);
  }

  function makeLeafRow(leaf) {
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

    li.append(icon, name, bar, meta);
    return { el: li, fill, meta, name };
  }

  function applyLeafState(entry, leaf) {
    entry.el.dataset.status = leaf.status;
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
    } else { // waiting
      entry.fill.style.width = '0%';
      entry.meta.textContent = fmtSize(leaf.size);
      entry.meta.title = '';
    }
  }

  function updateLeavesList(leaves) {
    const frag = document.createDocumentFragment();
    let appended = false;
    for (const leaf of leaves) {
      let entry = leafRows.get(leaf.id);
      if (!entry) {
        entry = makeLeafRow(leaf);
        leafRows.set(leaf.id, entry);
        frag.appendChild(entry.el);
        appended = true;
      }
      applyLeafState(entry, leaf);
    }
    if (appended) dom.transferList.appendChild(frag);
  }

  function updateProgress(snap) {
    const pct = snap.totalBytes > 0
      ? Math.min(100, (snap.transferredBytes / snap.totalBytes) * 100)
      : (snap.totalFiles > 0 ? (snap.doneFiles / snap.totalFiles) * 100 : 0);
    dom.progressFill.style.width = pct.toFixed(1) + '%';

    const verb = snap.direction === 'upload' ? 'Uploading'
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
    dom.statusText.textContent = `${verb}${counter}${activeLabel}`;
    dom.statusMeta.textContent = `${fmtSize(snap.transferredBytes)} / ${fmtSize(snap.totalBytes)}  ${pct.toFixed(0)}%`;

    if (snap.leaves && snap.leaves.length) updateLeavesList(snap.leaves);
  }

  function streamProgress(jobId, refreshSide, refreshDir, originSessionId) {
    return new Promise((resolve) => {
      const es = new EventSource(`/api/transfer/${jobId}/events`);
      showProgress();
      let lastSnap = null;
      es.addEventListener('progress', (e) => {
        try { lastSnap = JSON.parse(e.data); updateProgress(lastSnap); } catch (_) {}
      });
      es.addEventListener('done', (e) => {
        es.close();
        let data = {};
        try { data = JSON.parse(e.data); } catch (_) {}
        const planErrs = (data.errors && data.errors.length) ? data.errors : (lastSnap && lastSnap.errors) || [];
        const leafErrs = (lastSnap && lastSnap.leaves)
          ? lastSnap.leaves.filter((l) => l.status === 'error').map((l) => ({ src: l.name, message: l.error || 'error' }))
          : [];
        const errs = planErrs.concat(leafErrs);
        hideProgress();
        if (errs.length) {
          const summary = errs.slice(0, 5).map((x) => `• ${basename(x.src)}: ${x.message}`).join('\n');
          const tail = errs.length > 5 ? `\n…and ${errs.length - 5} more` : '';
          window.alert(`Transfer finished with ${errs.length} error(s):\n${summary}${tail}`);
        }
        // Tab-aware auto-refresh: only refresh if the user hasn't switched away
        // from the originating session/dir while the transfer was running.
        const activeSid = state.session && state.session.sessionId;
        const r2rSid = state.r2rHost && state.r2rHost.session.sessionId;
        if (refreshSide === 'remote' && activeSid === originSessionId && state.remote.path === refreshDir) {
          loadRemote(state.remote.path);
        } else if (refreshSide === 'r2r' && r2rSid === originSessionId && state.r2rHost.remote.path === refreshDir) {
          loadR2R(state.r2rHost.remote.path);
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
        if (es.readyState === EventSource.CLOSED) return;
        es.close();
        hideProgress();
        window.alert('transfer stream disconnected');
        resolve();
      };
    });
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
      el.className = 'tab' + (idx === state.activeIdx ? ' active' : '');
      el.dataset.idx = String(idx);
      el.setAttribute('role', 'tab');
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = sessionLabel(tab.session);
      label.title = `${sessionLabel(tab.session)}  (sftp)`;
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
      setPath(dom.remotePath, state.remote.path);
      renderTree(dom.remoteTree, 'remote', state.remote.path, state.remote.entries,
        (e) => loadRemote(posixJoin(state.remote.path, e.name)));
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
      setPath(dom.remotePath, '');
      renderMessage(dom.remoteTree, 'empty', 'connect to a host to browse');
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

  // ---- Init ----
  loadLocal();
})();
