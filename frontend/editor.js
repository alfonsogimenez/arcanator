/* =========================================================
   editor.js  -  Timeline editor logic for Arcanator
   ========================================================= */

(() => {
  // -- URL params -------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const jobId     = params.get('job');
  if (!jobId) { window.location.href = '/'; return; }

  // -- DOM refs ---------------------------------------------
  const playBtn         = document.getElementById('play-btn');
  const currentTimeEl   = document.getElementById('current-time');
  const totalTimeEl     = document.getElementById('total-time');
  const wfZoom          = document.getElementById('wf-zoom');
  const wfZoomLabel     = document.getElementById('wf-zoom-label');
  const volumeSlider    = document.getElementById('volume');
  const timelineLoading = document.getElementById('timeline-loading');
  const timelineScroll  = document.getElementById('timeline-scroll');
  const columnsRow      = document.getElementById('columns-row');
  const addColumnBtn    = document.getElementById('add-column-btn');
  const exportBtn       = document.getElementById('export-btn');
  const downloadBtn     = document.getElementById('download-btn');
  const exportWrap      = document.getElementById('export-progress-wrap');
  const exportBar       = document.getElementById('export-bar');
  const exportMsg       = document.getElementById('export-msg');
  const overlayInput    = document.getElementById('overlay-text-input');
  const overlaySaved    = document.getElementById('overlay-text-saved');
  const overlayError    = document.getElementById('overlay-text-error');
  const replaceInput    = document.getElementById('replace-input');
  const searchPanel     = document.getElementById('search-panel');
  const panelClose      = document.getElementById('panel-close');
  const panelBackdrop   = document.getElementById('panel-backdrop');
  const panelQuery      = document.getElementById('panel-query');
  const panelSpinner    = document.getElementById('panel-spinner');
  const panelGrid       = document.getElementById('panel-grid');
  const panelGridInner  = document.getElementById('panel-grid-inner');
  const panelSentinel   = document.getElementById('panel-sentinel');
  const panelLoadMore   = document.getElementById('panel-load-more');
  const panelSearchInput = document.getElementById('panel-search-input');
  const panelSearchBtn   = document.getElementById('panel-search-btn');
  const panelSearchHistory = document.getElementById('panel-search-history');

  // -- Search history (localStorage) -----------------------
  const HISTORY_KEY = 'arcanator_search_history';
  function getSearchHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  }
  function addToSearchHistory(q) {
    if (!q) return;
    let h = getSearchHistory().filter(s => s !== q);
    h.unshift(q);
    h = h.slice(0, 10);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  }
  function renderSearchHistory() {
    const h = getSearchHistory();
    panelSearchHistory.innerHTML = '';
    if (!h.length) { panelSearchHistory.classList.add('hidden'); return; }
    h.forEach(q => {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer';
      li.innerHTML = `<span class="text-gray-500 text-xs">🕐</span><span class="flex-1 truncate">${q}</span>`;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // avoid blur before click
        panelSearchInput.value = q;
        panelSearchHistory.classList.add('hidden');
        panelSearchBtn.click();
      });
      panelSearchHistory.appendChild(li);
    });
    panelSearchHistory.classList.remove('hidden');
  }
  panelSearchInput.addEventListener('focus', () => { if (getSearchHistory().length) renderSearchHistory(); });
  panelSearchInput.addEventListener('blur', () => { setTimeout(() => panelSearchHistory.classList.add('hidden'), 150); });
  panelSearchInput.addEventListener('input', () => {
    const val = panelSearchInput.value.trim();
    if (!val) { renderSearchHistory(); return; }
    const filtered = getSearchHistory().filter(s => s.toLowerCase().includes(val.toLowerCase()));
    panelSearchHistory.innerHTML = '';
    if (!filtered.length) { panelSearchHistory.classList.add('hidden'); return; }
    filtered.forEach(q => {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer';
      li.innerHTML = `<span class="text-gray-500 text-xs">🕐</span><span class="flex-1 truncate">${q}</span>`;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        panelSearchInput.value = q;
        panelSearchHistory.classList.add('hidden');
        panelSearchBtn.click();
      });
      panelSearchHistory.appendChild(li);
    });
    panelSearchHistory.classList.remove('hidden');
  });
  const lightbox         = document.getElementById('lightbox');
  const lightboxImg      = document.getElementById('lightbox-img');
  const lightboxClose    = document.getElementById('lightbox-close');

  // -- Constants -------------------------------------------
  let   PX_PER_SEC      = 30;  // pixels per second for column widths (mutable via zoom slider)
  const MIN_SLOT_DUR    = 2;   // minimum slot duration in seconds
  const DEFAULT_COL_DUR = 5;   // default duration for new columns (seconds)

  // -- State ------------------------------------------------
  let slots            = [];
  let audioDuration    = 0;
  let activeIndex      = -1;
  let ws               = null;
  let replacingIdx     = null;
  let panelSlotIdx     = null;
  let panelCurrentQuery = '';
  let panelOffset      = 0;
  let panelLoadingMore = false;
  let panelHasMore     = true;
  let panelObserver    = null;
  let wavesurferReady  = false;

  // -- Bootstrap: load job data -----------------------------
  async function init() {
    let job;
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error('Job no encontrado');
      job = await res.json();
    } catch (err) {
      timelineLoading.textContent = `Error: ${err.message}`;
      return;
    }

    slots = job.slots || [];
    // Restore overlay text if already saved
    if (job.overlay_text) overlayInput.value = job.overlay_text;
    buildTimeline(slots);

    ws = WaveSurfer.create({
      container:     '#waveform',
      waveColor:     '#6d28d9',
      progressColor: '#a78bfa',
      cursorColor:   '#f0abfc',
      height:        80,
      barWidth:      2,
      barGap:        1,
      barRadius:     2,
      normalize:     true,
      fillParent:    false,  // canvas width = audioDuration * zoom; fits exactly in #waveform-row
      autoScroll:    false,  // scroll driven by #timeline-scroll
      url:           job.audio_url,
    });

    ws.on('ready', (dur) => {
      audioDuration = dur;
      wavesurferReady = true;
      totalTimeEl.textContent = formatTime(dur);
      exportBtn.disabled = false;
      // Set waveform container width = total columns width so both scroll together
      _setWaveformWidth();
      syncZoom();
    });
    ws.on('timeupdate', (t) => {
      currentTimeEl.textContent = formatTime(t);
      syncTimeline(t);
    });
    ws.on('play',  () => { playBtn.textContent = '⏸'; });
    ws.on('pause', () => { playBtn.textContent = '▶'; });
    ws.on('finish',() => { playBtn.textContent = '▶'; });
    ws.on('error', (err) => console.error('[WaveSurfer]', err));
  }

  // -- Timeline builder ------------------------------------
  function buildTimeline(slotsArr) {
    columnsRow.innerHTML = '';
    slotsArr.forEach((slot, i) => columnsRow.appendChild(createCard(slot, i)));
    timelineLoading.classList.add('hidden');
    timelineScroll.style.display = 'flex';
    timelineScroll.classList.remove('hidden');
    if (wavesurferReady && audioDuration > 0) syncZoom();
  }

  function createCard(slot, i) {
    const duration  = Math.max(slot.end - slot.start, MIN_SLOT_DUR);
    const cardWidth = Math.round(duration * PX_PER_SEC);

    // ---- Wrapper (holds card + resize handle) ----
    const wrapper = document.createElement('div');
    wrapper.id        = `wrapper-${i}`;
    wrapper.className = 'slot-wrapper';
    wrapper.style.width = `${cardWidth}px`;

    // ---- Card ----
    const card = document.createElement('div');
    card.id        = `card-${i}`;
    card.className = 'slot-card h-full flex flex-col overflow-hidden border-0 bg-gray-900 select-none';

    // ---- Header: timestamp + text ----
    const header = document.createElement('div');
    header.className = 'px-3 pt-2 pb-1 cursor-pointer';
    header.addEventListener('click', () => {
      if (ws) ws.seekTo(audioDuration > 0 ? slot.start / audioDuration : 0);
    });

    const badge = document.createElement('div');
    badge.className = 'slot-badge text-xs text-gray-500 font-mono tabular-nums mb-1';
    badge.textContent = `${formatTime(slot.start)} – ${formatTime(slot.end)}`;

    const textEl = document.createElement('p');
    textEl.id        = `text-${i}`;
    textEl.className = 'text-xs text-gray-300 leading-snug line-clamp-3';
    textEl.style.minHeight = '3.5em';
    textEl.textContent = slot.text || '(sin texto)';
    textEl.title = slot.text || '';

    header.appendChild(badge);
    header.appendChild(textEl);
    card.appendChild(header);

    // ---- Divider ----
    const divider = document.createElement('div');
    divider.className = 'border-t border-gray-800 mx-2';
    card.appendChild(divider);

    // ---- Image column ----
    const imgCol = document.createElement('div');
    imgCol.id        = `imgcol-${i}`;
    imgCol.className = 'flex flex-col gap-1 p-2 flex-1';
    renderCandidates(imgCol, slot, i);
    card.appendChild(imgCol);

    // ---- Footer buttons ----
    const footer = document.createElement('div');
    footer.className = 'flex gap-1 px-2 pb-2 flex-wrap';

    const searchBtn = document.createElement('button');
    searchBtn.className = 'flex-1 py-1 text-xs text-gray-400 border border-gray-700 rounded-lg hover:border-violet-500 hover:text-violet-400 transition-colors';
    searchBtn.textContent = '🔍 Buscar';
    searchBtn.addEventListener('click', (e) => { e.stopPropagation(); openSearchPanel(i); });

    const localBtn = document.createElement('button');
    localBtn.className = 'flex-1 py-1 text-xs text-gray-400 border border-gray-700 rounded-lg hover:border-fuchsia-500 hover:text-fuchsia-400 transition-colors';
    localBtn.textContent = '📁 Local';
    localBtn.addEventListener('click', (e) => { e.stopPropagation(); openReplace(i); });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'py-1 px-2 text-xs text-gray-600 border border-gray-700 rounded-lg hover:border-red-500 hover:text-red-400 transition-colors';
    deleteBtn.title = 'Eliminar columna';
    deleteBtn.textContent = '🗑';
    deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteColumn(i); });

    footer.appendChild(searchBtn);
    footer.appendChild(localBtn);
    footer.appendChild(deleteBtn);
    card.appendChild(footer);

    // ---- Drag-and-drop target ----
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-active'); });
    card.addEventListener('dragleave', () => card.classList.remove('drop-active'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop-active');
      const url = e.dataTransfer.getData('text/plain');
      if (url) useExternalUrl(i, url);
    });

    wrapper.appendChild(card);

    // ---- Resize handle (right edge) ----
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    handle.title = 'Arrastrar para cambiar duración';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handle.classList.add('dragging');

      const startX       = e.clientX;
      const origDuration = slots[i].end - slots[i].start;
      const origEnd      = slots[i].end;
      const isLast       = i === slots.length - 1;
      const nextOrigEnd  = !isLast ? slots[i + 1].end : null;

      document.body.style.cursor    = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMouseMove(ev) {
        const dx = ev.clientX - startX;
        let newDur = origDuration + dx / PX_PER_SEC;
        newDur = Math.max(newDur, MIN_SLOT_DUR);

        if (isLast) {
          // Cap: end can't exceed audio duration
          if (audioDuration > 0) newDur = Math.min(newDur, audioDuration - slots[i].start);
        } else {
          // Cap: next slot can't shrink below minimum
          const maxEnd = nextOrigEnd - MIN_SLOT_DUR;
          newDur = Math.min(newDur, maxEnd - slots[i].start);
        }

        const newEnd = slots[i].start + newDur;
        slots[i].end = newEnd;
        if (!isLast) slots[i + 1].start = newEnd;

        // Update wrapper widths live
        wrapper.style.width = `${Math.round(newDur * PX_PER_SEC)}px`;
        const wBadge = wrapper.querySelector('.slot-badge');
        if (wBadge) wBadge.textContent = `${formatTime(slots[i].start)} – ${formatTime(slots[i].end)}`;

        if (!isLast) {
          const nextWrapper = document.getElementById(`wrapper-${i + 1}`);
          if (nextWrapper) {
            const nd = slots[i + 1].end - slots[i + 1].start;
            nextWrapper.style.width = `${Math.round(nd * PX_PER_SEC)}px`;
            const nb = nextWrapper.querySelector('.slot-badge');
            if (nb) nb.textContent = `${formatTime(slots[i + 1].start)} – ${formatTime(slots[i + 1].end)}`;
          }
        }
      }

      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor    = '';
        document.body.style.userSelect = '';
        handle.classList.remove('dragging');
        saveSlots();
        syncZoom();  // re-sync waveform after resize
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
    wrapper.appendChild(handle);

    return wrapper;
  }

  function renderCandidates(container, slot, slotIdx) {
    container.innerHTML = '';
    const candidates = slot.candidates || [];

    if (candidates.length === 0 && !slot.image_url) {
      // Empty placeholder
      const ph = document.createElement('div');
      ph.className = 'slot-empty-placeholder';
      ph.innerHTML = '<span style="font-size:1.5rem">🖼️</span><span>Sin imagen<br>Usa 🔍 Buscar o 📁 Local</span>';
      container.appendChild(ph);
      return;
    }

    if (candidates.length === 0) {
      // Single image (legacy or no candidates)
      appendCandidateImg(container, slot.image_url, 0, slotIdx, true);
      return;
    }

    candidates.slice(0, 3).forEach((cand, ci) => {
      appendCandidateImg(container, cand.image_url, ci, slotIdx, ci === 0, cand.page_url || '');
    });
  }

  function appendCandidateImg(container, imgUrl, candidateIdx, slotIdx, isSelected, pageUrl) {
    pageUrl = pageUrl || '';
    const wrapper = document.createElement('div');
    wrapper.className = 'relative cursor-pointer candidate-wrapper' + (isSelected ? ' candidate-selected' : '');
    wrapper.style.height = '124px';

    const img = document.createElement('img');
    img.src       = imgUrl || '';
    img.className = 'w-full h-full object-cover rounded-md candidate-img';
    img.loading   = 'lazy';
    img.draggable = false;

    // img goes in first so overlays stack on top reliably
    wrapper.appendChild(img);

    if (isSelected) {
      const check = document.createElement('div');
      check.className = 'candidate-check';
      check.textContent = '\u2713';
      wrapper.appendChild(check);
    }

    if (pageUrl) {
      const link = document.createElement('a');
      link.href      = pageUrl;
      link.target    = '_blank';
      link.rel       = 'noopener noreferrer';
      link.title     = 'Ver fuente';
      link.className = 'candidate-source-link';
      link.textContent = '\uD83D\uDD17';
      link.addEventListener('click', (e) => e.stopPropagation());
      wrapper.appendChild(link);
    }

    // Make draggable so it can be dropped onto another slot column
    wrapper.draggable = true;
    wrapper.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', imgUrl);
      e.dataTransfer.effectAllowed = 'copy';
      wrapper.style.opacity = '0.5';
    });
    wrapper.addEventListener('dragend', () => { wrapper.style.opacity = '1'; });

    wrapper.addEventListener('click', () => {
      if (candidateIdx === 0) { openLightbox(imgUrl); return; }
      selectCandidate(slotIdx, candidateIdx);
    });

    container.appendChild(wrapper);
  }

  // -- Select candidate via API ----------------------------
  async function selectCandidate(slotIdx, candidateIdx) {
    try {
      const res = await fetch(`/api/jobs/${jobId}/slots/${slotIdx}/select-candidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate_index: candidateIdx }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      slots[slotIdx].candidates = data.candidates;
      slots[slotIdx].image_url  = data.image_url;
      const container = document.getElementById(`imgcol-${slotIdx}`);
      if (container) renderCandidates(container, slots[slotIdx], slotIdx);
    } catch (err) {
      console.error('selectCandidate error:', err);
    }
  }

  // -- Use external URL (from search panel or drag) --------
  async function useExternalUrl(slotIdx, url, pageUrl) {
    const wasEmpty = !slots[slotIdx]?.image_url && !(slots[slotIdx]?.candidates?.length);
    const card = document.getElementById(`card-${slotIdx}`);
    if (card) card.style.opacity = '0.6';
    try {
      const res = await fetch(`/api/jobs/${jobId}/slots/${slotIdx}/use-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, page_url: pageUrl || '' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      slots[slotIdx].candidates = data.candidates;
      slots[slotIdx].image_url  = data.image_url;
      const container = document.getElementById(`imgcol-${slotIdx}`);
      if (container) renderCandidates(container, slots[slotIdx], slotIdx);
      closePanelIfSameSlot(slotIdx);
      // If the slot was empty and is the last one, add a new column automatically
      if (wasEmpty && slotIdx === slots.length - 1) addColumn();
      // Resume playback after selecting an image
      if (ws) ws.play();
    } catch (err) {
      alert(`Error al usar la imagen: ${err.message}`);
    } finally {
      if (card) card.style.opacity = '1';
    }
  }

  // -- Search panel ----------------------------------------
  async function openSearchPanel(slotIdx) {
    panelSlotIdx = slotIdx;
    const autoQuery = slots[slotIdx]?.prompt || slots[slotIdx]?.text || '';
    panelSearchInput.value = autoQuery;

    // Pause playback while browsing images
    if (ws && ws.isPlaying()) ws.pause();

    // Show panel
    searchPanel.style.transform = 'translateX(0)';
    panelBackdrop.classList.remove('hidden');

    await loadPanelResults(autoQuery, true);
  }

  async function loadPanelResults(query, reset) {
    if (panelLoadingMore) return;
    if (!reset && !panelHasMore) return;

    panelLoadingMore = true;
    query = query.trim();
    if (!query) { panelLoadingMore = false; return; }

    if (reset) {
      panelCurrentQuery = query;
      panelOffset = 0;
      panelHasMore = true;
      panelGridInner.innerHTML = '';
      panelQuery.textContent = query;
      panelSpinner.classList.remove('hidden');
      panelGrid.style.display = 'none';
    } else {
      panelLoadMore.classList.remove('hidden');
    }

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&offset=${panelOffset}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const entries = data.entries || (data.urls || []).map(u => ({ url: u, page_url: '' }));

      entries.forEach(({ url, page_url: pageUrl }) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'relative rounded-md overflow-hidden cursor-pointer panel-img-wrapper';
        wrapper.style.height = '160px';
        wrapper.draggable = true;

        const img = document.createElement('img');
        img.src       = url;
        img.className = 'w-full h-full object-cover';
        img.loading   = 'lazy';
        img.onerror   = () => { wrapper.style.display = 'none'; };

        wrapper.appendChild(img);

        if (pageUrl) {
          const link = document.createElement('a');
          link.href      = pageUrl;
          link.target    = '_blank';
          link.rel       = 'noopener noreferrer';
          link.title     = 'Ver fuente';
          link.className = 'candidate-source-link';
          link.textContent = '\uD83D\uDD17';
          link.addEventListener('click', (e) => e.stopPropagation());
          wrapper.appendChild(link);
        }

        wrapper.addEventListener('click', () => {
          if (panelSlotIdx !== null) useExternalUrl(panelSlotIdx, url, pageUrl);
        });
        wrapper.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', url);
          e.dataTransfer.effectAllowed = 'copy';
        });

        panelGridInner.appendChild(wrapper);
      });

      panelOffset += entries.length;
      panelHasMore = entries.length >= 20; // if fewer returned, assume no more
    } catch (err) {
      panelQuery.textContent = `Error: ${err.message}`;
    } finally {
      panelLoadingMore = false;
      panelLoadMore.classList.add('hidden');
      if (reset) {
        panelSpinner.classList.add('hidden');
        panelGrid.style.display = '';
        panelGrid.classList.remove('hidden');
      }
    }
  }

  // Infinite scroll observer
  panelObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && panelCurrentQuery) {
      loadPanelResults(panelCurrentQuery, false);
    }
  }, { root: panelGrid, threshold: 0.1 });
  panelObserver.observe(panelSentinel);

  // Custom search button + Enter key
  panelSearchBtn.addEventListener('click', () => {
    const q = panelSearchInput.value.trim();
    if (q) {
      addToSearchHistory(q);
      panelSearchHistory.classList.add('hidden');
      loadPanelResults(q, true);
    }
  });
  panelSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panelSearchBtn.click();
    if (e.key === 'Escape') panelSearchHistory.classList.add('hidden');
  });

  function closePanelIfSameSlot(slotIdx) {
    if (panelSlotIdx === slotIdx) closePanel();
  }

  function closePanel() {
    searchPanel.style.transform = 'translateX(100%)';
    panelBackdrop.classList.add('hidden');
    panelSlotIdx = null;
  }

  panelClose.addEventListener('click', closePanel);
  panelBackdrop.addEventListener('click', closePanel);

  // -- Timeline sync with playhead --------------------------
  // Width helper: waveform-row and #waveform must equal total columns width
  function _setWaveformWidth() {
    if (!audioDuration) return;
    const w = Math.ceil(audioDuration * PX_PER_SEC);
    const wfRow = document.getElementById('waveform-row');
    const wfEl  = document.getElementById('waveform');
    if (wfRow) wfRow.style.width = w + 'px';
    if (wfEl)  wfEl.style.width  = w + 'px';
  }

  // Scroll timeline-scroll so playhead is centred in the viewport
  function _scrollToTime(t) {
    const half = timelineScroll.clientWidth / 2;
    timelineScroll.scrollLeft = Math.max(0, t * PX_PER_SEC - half);
  }

  function syncTimeline(currentTime) {
    // Update active card highlight
    const idx = slots.findIndex((s) => currentTime >= s.start && currentTime < s.end);
    if (idx !== activeIndex) {
      if (activeIndex >= 0) {
        const prev = document.getElementById(`card-${activeIndex}`);
        if (prev) prev.classList.remove('card-active');
      }
      if (idx >= 0) {
        const card = document.getElementById(`card-${idx}`);
        if (card) card.classList.add('card-active');
      }
      activeIndex = idx;
    }
    _scrollToTime(currentTime);
  }

  // -- Zoom: keep waveform + column widths in sync ---------
  let _scrollSyncBound = false;  // kept to avoid removing too much; scroll sync no longer needed
  function syncZoom() {
    if (ws && audioDuration > 0) ws.zoom(PX_PER_SEC);
    if (wfZoomLabel) wfZoomLabel.textContent = `${PX_PER_SEC}px`;
    _setWaveformWidth();
  }

  // -- Lightbox ---------------------------------------------
  function openLightbox(url) {
    lightboxImg.src = url;
    lightbox.classList.remove('hidden');
  }
  function closeLightbox() {
    lightbox.classList.add('hidden');
    lightboxImg.src = '';
  }
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target === lightboxClose) closeLightbox();
  });

  // -- Local image replacement via file picker -------------
  function openReplace(idx) {
    replacingIdx = idx;
    replaceInput.value = '';
    replaceInput.click();
  }

  replaceInput.addEventListener('change', async () => {
    const file = replaceInput.files[0];
    if (!file || replacingIdx === null) return;
    const idx = replacingIdx;
    replacingIdx = null;

    const card = document.getElementById(`card-${idx}`);
    if (card) card.style.opacity = '0.6';

    const fd = new FormData();
    fd.append('image', file);

    try {
      const res = await fetch(`/api/jobs/${jobId}/slots/${idx}`, { method: 'PATCH', body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      slots[idx].candidates = data.candidates;
      slots[idx].image_url  = data.image_url;
      const container = document.getElementById(`imgcol-${idx}`);
      if (container) renderCandidates(container, slots[idx], idx);

      if (card) {
        card.classList.add('card-replaced');
        setTimeout(() => card.classList.remove('card-replaced'), 1200);
      }
    } catch (err) {
      alert(`Error al reemplazar imagen: ${err.message}`);
    } finally {
      if (card) card.style.opacity = '1';
    }
  });

  // -- Play / Pause ----------------------------------------
  playBtn.addEventListener('click', () => ws && ws.playPause());

  const stopBtn = document.getElementById('stop-btn');
  stopBtn.addEventListener('click', () => {
    if (!ws) return;
    ws.pause();
    ws.seekTo(0);
    _scrollToTime(0);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) {
      closeLightbox(); return;
    }
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      ws && ws.playPause();
    }
  });
  // Zoom slider → update PX_PER_SEC + rescale all columns + sync waveform
  wfZoom.addEventListener('input', () => {
    PX_PER_SEC = Number(wfZoom.value);
    // Rescale all existing wrappers
    slots.forEach((slot, i) => {
      const wrapper = document.getElementById(`wrapper-${i}`);
      if (wrapper) {
        const dur = Math.max(slot.end - slot.start, MIN_SLOT_DUR);
        wrapper.style.width = `${Math.round(dur * PX_PER_SEC)}px`;
      }
    });
    syncZoom();
    _setWaveformWidth();
    // Re-center scroll on current playhead after zoom
    if (ws) _scrollToTime(ws.getCurrentTime ? ws.getCurrentTime() : 0);
  });
  volumeSlider.addEventListener('input', () => { if (ws) ws.setVolume(Number(volumeSlider.value)); });

  // -- Slots persistence ------------------------------------
  let _saveSlotsTimer = null;
  function saveSlots() {
    clearTimeout(_saveSlotsTimer);
    _saveSlotsTimer = setTimeout(async () => {
      try {
        await fetch(`/api/jobs/${jobId}/slots`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slots }),
        });
      } catch (_) {}
    }, 500);
  }

  // -- Add column -------------------------------------------
  function addColumn() {
    const capDuration = audioDuration > 0 ? audioDuration : 3600;
    const lastSlot = slots[slots.length - 1];
    const newStart = lastSlot ? Math.round(lastSlot.end * 100) / 100 : 0;
    const newEnd   = Math.min(newStart + DEFAULT_COL_DUR, capDuration);
    if (newEnd - newStart < MIN_SLOT_DUR) {
      // No room left: try to squeeze a minimum-duration column
      const minEnd = Math.min(newStart + MIN_SLOT_DUR, capDuration);
      if (minEnd <= newStart) {
        alert('No hay espacio en el audio para añadir otra columna.');
        return;
      }
    }
    const newSlot = {
      index: slots.length,
      start: newStart,
      end: Math.min(newStart + DEFAULT_COL_DUR, capDuration),
      text: '',
      prompt: '',
      image_url: null,
      image_path: null,
      candidates: [],
    };
    slots.push(newSlot);
    const wrapper = createCard(newSlot, slots.length - 1);
    columnsRow.appendChild(wrapper);
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
    saveSlots();
    syncZoom();  // update waveform width + zoom
  }

  // -- Delete column ----------------------------------------
  function deleteColumn(idx) {
    if (slots.length <= 1) {
      alert('Debe haber al menos una columna.');
      return;
    }
    slots.splice(idx, 1);
    slots.forEach((s, i) => { s.index = i; });
    buildTimeline(slots);
    saveSlots();
  }

  addColumnBtn.addEventListener('click', addColumn);

  // -- Overlay text: autosave with debounce ----------------
  let _overlayDebounce = null;
  overlayInput.addEventListener('input', () => {
    overlayError.classList.add('hidden');
    overlaySaved.classList.add('hidden');
    clearTimeout(_overlayDebounce);
    _overlayDebounce = setTimeout(async () => {
      const text = overlayInput.value.trim();
      if (!text) return;
      try {
        await fetch(`/api/jobs/${jobId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overlay_text: text }),
        });
        overlaySaved.classList.remove('hidden');
        setTimeout(() => overlaySaved.classList.add('hidden'), 2000);
      } catch (_) {}
    }, 800);
  });

  // -- Export ----------------------------------------------
  exportBtn.addEventListener('click', async () => {
    // Validate overlay text
    const overlayText = overlayInput.value.trim();
    if (!overlayText) {
      overlayError.classList.remove('hidden');
      overlayInput.focus();
      overlayInput.classList.add('border-red-500');
      setTimeout(() => overlayInput.classList.remove('border-red-500'), 2000);
      return;
    }
    overlayError.classList.add('hidden');

    // Save overlay text before exporting (in case debounce hasn't fired yet)
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overlay_text: overlayText }),
      });
    } catch (_) {}

    exportBtn.disabled = true;
    exportBtn.textContent = 'Exportando...';
    exportWrap.classList.remove('hidden');
    setExportProgress(0, 'Iniciando exportacion...');

    try {
      const res = await fetch(`/api/jobs/${jobId}/export`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Exportar Video';
      setExportProgress(0, `Error: ${err.message}`);
      return;
    }

    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    es.addEventListener('export_progress', (e) => {
      const d = JSON.parse(e.data);
      setExportProgress(d.percent, d.message);
    });
    es.addEventListener('export_done', (e) => {
      es.close();
      const d = JSON.parse(e.data);
      setExportProgress(100, '🎥 ¡Video listo!');
      downloadBtn.href = d.download_url;
      downloadBtn.classList.remove('hidden');
      exportBtn.classList.add('hidden');
    });
    es.addEventListener('export_error', (e) => {
      es.close();
      const d = JSON.parse(e.data);
      setExportProgress(0, `Error: ${d.message}`);
      exportBtn.disabled = false;
      exportBtn.textContent = 'Exportar Video';
    });
    es.onerror = () => { es.close(); pollExport(); };
  });

  async function pollExport() {
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const job = await res.json();
        setExportProgress(job.progress_percent || 0, job.progress_message || '');
        if (job.status === 'done' && job.download_url) {
          clearInterval(id);
          setExportProgress(100, 'Video listo!');
          downloadBtn.href = job.download_url;
          downloadBtn.classList.remove('hidden');
          exportBtn.classList.add('hidden');
        }
        if (job.status === 'error') {
          clearInterval(id);
          setExportProgress(0, `Error: ${job.error}`);
          exportBtn.disabled = false;
          exportBtn.textContent = 'Exportar Video';
        }
      } catch (_) {}
    }, 2000);
  }

  function setExportProgress(percent, message) {
    exportBar.style.width = `${Math.min(100, percent)}%`;
    exportMsg.textContent = message;
  }

  // -- Helpers ---------------------------------------------
  function formatTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // -- Start -----------------------------------------------
  init();
})();
