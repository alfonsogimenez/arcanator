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
  const exportShortBtn  = document.getElementById('export-short-btn');
  const downloadBtn     = document.getElementById('download-btn');
  const downloadShortBtn = document.getElementById('download-short-btn');
  const exportWrap      = document.getElementById('export-progress-wrap');
  const exportBar       = document.getElementById('export-bar');
  const exportMsg       = document.getElementById('export-msg');
  const overlayInput    = document.getElementById('overlay-text-input');
  const overlaySizeDown = document.getElementById('overlay-size-down');
  const overlaySizeUp   = document.getElementById('overlay-size-up');
  const overlaySizeLabel = document.getElementById('overlay-size-label');
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
  const DEFAULT_COL_DUR = 7;   // default duration for new empty columns (seconds)
  const TIME_EPSILON    = 0.001;
  const OVERLAY_FONT_DEFAULT = 64;
  const OVERLAY_FONT_MIN = 36;
  const OVERLAY_FONT_MAX = 112;
  const OVERLAY_FONT_STEP = 4;

  // -- State ------------------------------------------------
  let slots            = [];
  let audioDuration    = 0;
  let overlayFontSize  = OVERLAY_FONT_DEFAULT;
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

    audioDuration = Number(job.audio_duration) || 0;
    slots = job.slots || [];
    const repairedOnLoad = normalizeSlotsToAudio();
    // Restore overlay text if already saved
    overlayFontSize = clampOverlayFontSize(job.overlay_font_size);
    if (job.overlay_text) overlayInput.value = job.overlay_text;
    buildTimeline(slots);
    updateOverlayControls();
    if (repairedOnLoad) saveSlots();

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
      audioDuration = Number(dur) || audioDuration;
      wavesurferReady = true;
      totalTimeEl.textContent = formatTime(audioDuration);
      exportBtn.disabled = false;
      exportShortBtn.disabled = false;
      const repaired = normalizeSlotsToAudio();
      if (repaired) {
        buildTimeline(slots);
        saveSlots();
      } else {
        syncZoom();
      }
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

  function roundTime(value) {
    return Math.round(Math.max(0, value) * 1000) / 1000;
  }

  function makeEmptySlot(start, end, index = slots.length) {
    return {
      index,
      start: roundTime(start),
      end: roundTime(end),
      text: '',
      prompt: '',
      image_url: null,
      image_path: null,
      candidates: [],
    };
  }

  function makeEmptySlotsForDuration(duration) {
    const result = [];
    const endTime = roundTime(duration);
    if (!endTime || endTime <= 0) {
      return [makeEmptySlot(0, DEFAULT_COL_DUR, 0)];
    }

    let t = 0;
    let index = 0;
    while (t < endTime - TIME_EPSILON) {
      const next = Math.min(t + DEFAULT_COL_DUR, endTime);
      result.push(makeEmptySlot(t, next, index));
      t = next;
      index += 1;
    }
    return result;
  }

  function isImageEmptySlot(slot) {
    return !slot?.image_url
      && !slot?.image_path
      && !(Array.isArray(slot?.candidates) && slot.candidates.length);
  }

  function isSingleEmptyTimelineSeed() {
    if (slots.length !== 1 || !audioDuration || audioDuration <= 0) return false;
    const slot = slots[0];
    const start = Number(slot.start) || 0;
    const end = Number(slot.end) || 0;
    return isImageEmptySlot(slot)
      && start <= TIME_EPSILON
      && audioDuration > DEFAULT_COL_DUR + TIME_EPSILON
      && end <= audioDuration + TIME_EPSILON;
  }

  function normalizeSlotsToAudio() {
    if (!Array.isArray(slots)) slots = [];
    if (!audioDuration || audioDuration <= 0) {
      slots.forEach((slot, i) => { slot.index = i; });
      return false;
    }

    let changed = false;
    if (!slots.length || isSingleEmptyTimelineSeed()) {
      slots = makeEmptySlotsForDuration(audioDuration);
      return true;
    }

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const fallbackStart = i > 0 ? Number(slots[i - 1].end) || 0 : 0;
      let start = Number(slot.start);
      let end = Number(slot.end);

      if (!Number.isFinite(start)) { start = fallbackStart; changed = true; }
      if (!Number.isFinite(end) || end <= start) {
        end = start + Math.min(DEFAULT_COL_DUR, Math.max(MIN_SLOT_DUR, audioDuration - start));
        changed = true;
      }

      if (i === 0 && Math.abs(start) > TIME_EPSILON) {
        start = 0;
        changed = true;
      }

      slot.start = roundTime(start);
      slot.end = roundTime(end);
    }

    for (let i = 1; i < slots.length; i++) {
      const prev = slots[i - 1];
      const slot = slots[i];
      const prevEnd = Number(prev.end) || 0;
      let start = Number(slot.start) || prevEnd;

      if (start > prevEnd + TIME_EPSILON) {
        prev.end = roundTime(start);
        changed = true;
      } else if (start < prevEnd - TIME_EPSILON) {
        start = prevEnd;
        slot.start = roundTime(start);
        changed = true;
      }

      if ((Number(slot.end) || 0) <= start + TIME_EPSILON) {
        slot.end = roundTime(start + Math.min(DEFAULT_COL_DUR, Math.max(MIN_SLOT_DUR, audioDuration - start)));
        changed = true;
      }
    }

    for (let i = 0; i < slots.length; i++) {
      if (slots[i].start >= audioDuration - TIME_EPSILON) {
        slots.splice(i);
        changed = true;
        break;
      }
      if (slots[i].end > audioDuration + TIME_EPSILON) {
        slots[i].end = roundTime(audioDuration);
        if (i < slots.length - 1) slots.splice(i + 1);
        changed = true;
        break;
      }
    }

    if (!slots.length) {
      slots.push(makeEmptySlot(0, audioDuration));
      changed = true;
    }

    const last = slots[slots.length - 1];
    if (last.end < audioDuration - TIME_EPSILON) {
      last.end = roundTime(audioDuration);
      changed = true;
    }

    slots.forEach((slot, i) => { slot.index = i; });
    return changed;
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

    if (slotIdx === 0 && candidateIdx === 0) {
      const overlayPreview = document.createElement('div');
      overlayPreview.className = 'overlay-preview-text';
      overlayPreview.textContent = overlayInput.value.trim();
      overlayPreview.style.position = 'absolute';
      overlayPreview.style.top = '12%';
      overlayPreview.style.left = '50%';
      overlayPreview.style.width = '90%';
      overlayPreview.style.transform = 'translateX(-50%)';
      overlayPreview.style.color = '#fff';
      overlayPreview.style.fontWeight = '800';
      overlayPreview.style.lineHeight = '1.08';
      overlayPreview.style.textAlign = 'center';
      overlayPreview.style.overflowWrap = 'anywhere';
      overlayPreview.style.textShadow = '0 0 2px #000, 0 1px 2px #000, 0 2px 4px rgba(0,0,0,0.9)';
      overlayPreview.style.zIndex = '3';
      overlayPreview.style.pointerEvents = 'none';
      overlayPreview.style.fontSize = `${getOverlayPreviewFontSize()}px`;
      overlayPreview.style.display = overlayPreview.textContent ? '' : 'none';
      wrapper.appendChild(overlayPreview);
    }

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
    if (normalizeSlotsToAudio()) buildTimeline(slots);

    const capDuration = audioDuration > 0 ? audioDuration : 3600;
    const lastSlot = slots[slots.length - 1];
    const newStart = lastSlot ? roundTime(lastSlot.end) : 0;
    const newEnd = Math.min(newStart + DEFAULT_COL_DUR, capDuration);

    if (newEnd - newStart < MIN_SLOT_DUR) {
      if (!splitLastColumn()) {
        alert('No hay espacio suficiente para añadir otra columna.');
        return;
      }
      buildTimeline(slots);
      const wrapper = document.getElementById(`wrapper-${slots.length - 1}`);
      if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
      saveSlots();
      syncZoom();
      return;
    }

    const newSlot = makeEmptySlot(newStart, newEnd);
    slots.push(newSlot);
    const wrapper = createCard(newSlot, slots.length - 1);
    columnsRow.appendChild(wrapper);
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
    saveSlots();
    syncZoom();  // update waveform width + zoom
  }

  function splitLastColumn() {
    const last = slots[slots.length - 1];
    if (!last) return false;

    const lastDuration = Number(last.end) - Number(last.start);
    if (!Number.isFinite(lastDuration) || lastDuration < MIN_SLOT_DUR * 2) return false;

    const newDuration = Math.min(DEFAULT_COL_DUR, Math.max(MIN_SLOT_DUR, lastDuration / 2));
    const splitDuration = Math.min(newDuration, lastDuration - MIN_SLOT_DUR);
    const splitStart = roundTime(Number(last.end) - splitDuration);
    const newSlot = makeEmptySlot(splitStart, last.end);

    last.end = splitStart;
    slots.push(newSlot);
    slots.forEach((slot, i) => { slot.index = i; });
    return true;
  }

  // -- Delete column ----------------------------------------
  function deleteColumn(idx) {
    if (slots.length <= 1) {
      alert('Debe haber al menos una columna.');
      return;
    }

    // Get duration of column to delete
    const deletedDuration = slots[idx].end - slots[idx].start;

    // If not the first column, expand the previous column by the deleted duration
    if (idx > 0) {
      slots[idx - 1].end += deletedDuration;
    } else if (idx < slots.length - 1) {
      // If deleting the first column, expand the next column backwards
      slots[idx + 1].start -= deletedDuration;
    }

    // Remove the column
    slots.splice(idx, 1);
    
    // Update all indices
    slots.forEach((s, i) => { s.index = i; });
    
    // Rebuild and save
    buildTimeline(slots);
    saveSlots();
    syncZoom();
  }

  addColumnBtn.addEventListener('click', addColumn);

  // -- Overlay text: autosave with debounce ----------------
  let _overlayDebounce = null;
  function clampOverlayFontSize(value) {
    const parsed = Number(value);
    const safeValue = Number.isFinite(parsed) ? parsed : OVERLAY_FONT_DEFAULT;
    const stepped = Math.round(safeValue / OVERLAY_FONT_STEP) * OVERLAY_FONT_STEP;
    return Math.max(OVERLAY_FONT_MIN, Math.min(OVERLAY_FONT_MAX, stepped));
  }

  function getOverlayPreviewFontSize() {
    return Math.max(12, Math.min(28, Math.round(overlayFontSize / 4)));
  }

  function renderOverlayPreview() {
    const text = overlayInput.value.trim();
    document.querySelectorAll('.overlay-preview-text').forEach((el) => {
      el.textContent = text;
      el.style.fontSize = `${getOverlayPreviewFontSize()}px`;
      el.style.display = text ? '' : 'none';
    });
  }

  function updateOverlayControls() {
    overlayFontSize = clampOverlayFontSize(overlayFontSize);
    if (overlaySizeLabel) overlaySizeLabel.textContent = `${overlayFontSize}px`;
    if (overlaySizeDown) overlaySizeDown.disabled = overlayFontSize <= OVERLAY_FONT_MIN;
    if (overlaySizeUp) overlaySizeUp.disabled = overlayFontSize >= OVERLAY_FONT_MAX;
    renderOverlayPreview();
  }

  async function saveOverlaySettings() {
    await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        overlay_text: overlayInput.value.trim(),
        overlay_font_size: overlayFontSize,
      }),
    });
  }

  function queueOverlaySave() {
    overlaySaved.classList.add('hidden');
    clearTimeout(_overlayDebounce);
    _overlayDebounce = setTimeout(async () => {
      try {
        await saveOverlaySettings();
        overlaySaved.classList.remove('hidden');
        setTimeout(() => overlaySaved.classList.add('hidden'), 2000);
      } catch (_) {}
    }, 800);
  }

  overlayInput.addEventListener('input', () => {
    overlayError.classList.add('hidden');
    renderOverlayPreview();
    queueOverlaySave();
  });

  overlaySizeDown.addEventListener('click', () => {
    overlayFontSize = clampOverlayFontSize(overlayFontSize - OVERLAY_FONT_STEP);
    updateOverlayControls();
    queueOverlaySave();
  });

  overlaySizeUp.addEventListener('click', () => {
    overlayFontSize = clampOverlayFontSize(overlayFontSize + OVERLAY_FONT_STEP);
    updateOverlayControls();
    queueOverlaySave();
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
      await saveOverlaySettings();
    } catch (_) {}

    exportBtn.disabled = true;
    exportShortBtn.disabled = true;
    exportBtn.textContent = 'Exportando...';
    exportWrap.classList.remove('hidden');
    setExportProgress(0, 'Iniciando exportacion...');

    try {
      const res = await fetch(`/api/jobs/${jobId}/export`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      exportBtn.disabled = false;
      exportShortBtn.disabled = false;
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
      exportShortBtn.disabled = false;
    });
    es.addEventListener('export_error', (e) => {
      es.close();
      const d = JSON.parse(e.data);
      setExportProgress(0, `Error: ${d.message}`);
      exportBtn.disabled = false;
      exportShortBtn.disabled = false;
      exportBtn.textContent = 'Exportar Video';
    });
    es.onerror = () => { es.close(); pollExport(); };
  });

  exportShortBtn.addEventListener('click', async () => {
    const overlayText = overlayInput.value.trim();
    if (!overlayText) {
      overlayError.classList.remove('hidden');
      overlayInput.focus();
      overlayInput.classList.add('border-red-500');
      setTimeout(() => overlayInput.classList.remove('border-red-500'), 2000);
      return;
    }
    overlayError.classList.add('hidden');

    try {
      await saveOverlaySettings();
    } catch (_) {}

    exportBtn.disabled = true;
    exportShortBtn.disabled = true;
    exportShortBtn.textContent = 'Exportando...';
    exportWrap.classList.remove('hidden');
    setExportProgress(0, 'Iniciando exportacion del short...');

    try {
      const res = await fetch(`/api/jobs/${jobId}/export-short`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      exportBtn.disabled = false;
      exportShortBtn.disabled = false;
      exportShortBtn.textContent = 'Exportar Short';
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
      setExportProgress(100, 'Short listo!');
      downloadShortBtn.href = d.download_url;
      downloadShortBtn.classList.remove('hidden');
      exportShortBtn.classList.add('hidden');
      exportBtn.disabled = false;
    });
    es.addEventListener('export_error', (e) => {
      es.close();
      const d = JSON.parse(e.data);
      setExportProgress(0, `Error: ${d.message}`);
      exportBtn.disabled = false;
      exportShortBtn.disabled = false;
      exportShortBtn.textContent = 'Exportar Short';
    });
    es.onerror = () => {
      es.close();
      pollExport('short_download_url', downloadShortBtn, exportShortBtn, 'Exportar Short');
    };
  });

  async function pollExport(
    downloadField = 'download_url',
    downloadLink = downloadBtn,
    button = exportBtn,
    idleText = 'Exportar Video',
  ) {
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const job = await res.json();
        setExportProgress(job.progress_percent || 0, job.progress_message || '');
        if (job.status === 'done' && job[downloadField]) {
          clearInterval(id);
          setExportProgress(100, downloadField === 'short_download_url' ? 'Short listo!' : 'Video listo!');
          downloadLink.href = job[downloadField];
          downloadLink.classList.remove('hidden');
          button.classList.add('hidden');
          exportBtn.disabled = false;
          exportShortBtn.disabled = false;
        }
        if (job.status === 'error') {
          clearInterval(id);
          setExportProgress(0, `Error: ${job.error}`);
          exportBtn.disabled = false;
          exportShortBtn.disabled = false;
          button.textContent = idleText;
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
