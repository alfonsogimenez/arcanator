/* =========================================================
   editor.js  -  Timeline editor logic for Arcanator
   ========================================================= */

(() => {
  // -- URL params -------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const jobId     = params.get('job');
  const autoYT    = params.get('yt') === '1';
  if (!jobId) { window.location.href = '/'; return; }

  // -- DOM refs ---------------------------------------------
  const playBtn         = document.getElementById('play-btn');
  const currentTimeEl   = document.getElementById('current-time');
  const totalTimeEl     = document.getElementById('total-time');
  const wfZoom          = document.getElementById('wf-zoom');
  const volumeSlider    = document.getElementById('volume');
  const timelineLoading = document.getElementById('timeline-loading');
  const timelineScroll  = document.getElementById('timeline-scroll');
  const exportBtn       = document.getElementById('export-btn');
  const downloadBtn     = document.getElementById('download-btn');
  const publishYtBtn    = document.getElementById('publish-yt-btn');
  const exportWrap      = document.getElementById('export-progress-wrap');
  const exportBar       = document.getElementById('export-bar');
  const exportMsg       = document.getElementById('export-msg');
  const authBar         = document.getElementById('auth-bar');
  // YouTube modal
  const ytModal         = document.getElementById('yt-modal');
  const ytTitle         = document.getElementById('yt-title');
  const ytDescription   = document.getElementById('yt-description');
  const ytProgressWrap  = document.getElementById('yt-progress-wrap');
  const ytBar           = document.getElementById('yt-bar');
  const ytMsg           = document.getElementById('yt-msg');
  const ytDoneWrap      = document.getElementById('yt-done-wrap');
  const ytLink          = document.getElementById('yt-link');
  const ytCancel        = document.getElementById('yt-cancel');
  const ytSubmit        = document.getElementById('yt-submit');
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
  const lightbox         = document.getElementById('lightbox');
  const lightboxImg      = document.getElementById('lightbox-img');
  const lightboxClose    = document.getElementById('lightbox-close');

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
  let timelineBuiltScrollWidth = 0;
  let wavesurferReady          = false;
  let waveformZoomApplied      = false;
  let currentUser              = null;  // auth state

  // -- Auth -------------------------------------------------
  async function checkAuth() {
    try {
      const res  = await fetch('/api/auth/me');
      const data = await res.json();
      currentUser = data.logged_in ? data : null;
    } catch (_) {
      currentUser = null;
    }
    renderAuthBar();
  }

  function renderAuthBar() {
    if (!currentUser) {
      authBar.innerHTML = `
        <a href="/api/auth/google"
           class="flex items-center gap-2 px-3 py-1.5 bg-white text-gray-900 rounded-full text-xs font-semibold hover:bg-gray-100 transition-colors shadow">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" class="w-4 h-4">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.5 1.2 8.9 3.2l6.6-6.6C35.4 2.5 30 0 24 0 14.7 0 6.7 5.5 2.9 13.5l7.7 6C12.5 13.4 17.8 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.4c-.5 2.8-2.2 5.2-4.7 6.8l7.3 5.7c4.3-4 6.8-9.9 6.8-16.5z"/>
            <path fill="#FBBC05" d="M10.6 28.5c-.6-1.7-.9-3.5-.9-5.5s.3-3.8.9-5.5l-7.7-6C1 14.5 0 19.1 0 24s1 9.5 2.9 13.5l7.7-6z"/>
            <path fill="#34A853" d="M24 48c6 0 11-2 14.7-5.3l-7.3-5.7c-2 1.4-4.6 2.2-7.4 2.2-6.2 0-11.5-3.9-13.4-9.5l-7.7 6C6.7 42.5 14.7 48 24 48z"/>
          </svg>
          Google
        </a>`;
    } else {
      authBar.innerHTML = `
        <img src="${currentUser.picture}" class="w-7 h-7 rounded-full border border-gray-600" alt="avatar" />
        <span class="text-xs text-gray-300 hidden sm:inline">${currentUser.name}</span>
        <form method="post" action="/api/auth/logout" class="inline">
          <button type="submit" class="text-xs text-gray-500 hover:text-gray-300 underline">Salir</button>
        </form>`;
    }
  }

  checkAuth();

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
      url:           job.audio_url,
    });

    ws.on('ready', (dur) => {
      audioDuration = dur;
      wavesurferReady = true;
      totalTimeEl.textContent = formatTime(dur);
      exportBtn.disabled = false;
      if (timelineBuiltScrollWidth > 0) applyWaveformZoom();
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
    timelineScroll.innerHTML = '';
    slotsArr.forEach((slot, i) => timelineScroll.appendChild(createCard(slot, i)));
    timelineLoading.classList.add('hidden');
    timelineScroll.style.display = 'flex';
    timelineScroll.classList.remove('hidden');
    requestAnimationFrame(() => {
      timelineBuiltScrollWidth = timelineScroll.scrollWidth;
      if (wavesurferReady && audioDuration > 0) applyWaveformZoom();
    });
  }

  function createCard(slot, i) {
    const card = document.createElement('div');
    card.id        = `card-${i}`;
    card.className = 'slot-card shrink-0 flex flex-col rounded-xl overflow-hidden border border-gray-800 bg-gray-900 select-none';
    card.style.width = '220px';

    // ---- Header: timestamp + text ----
    const header = document.createElement('div');
    header.className = 'px-3 pt-2 pb-1 cursor-pointer';
    header.addEventListener('click', () => {
      if (ws) ws.seekTo(audioDuration > 0 ? slot.start / audioDuration : 0);
    });

    const badge = document.createElement('div');
    badge.className = 'text-xs text-gray-500 font-mono tabular-nums mb-1';
    badge.textContent = `${formatTime(slot.start)} - ${formatTime(slot.end)}`;

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
    imgCol.className = 'flex flex-col gap-1 p-2';
    renderCandidates(imgCol, slot, i);
    card.appendChild(imgCol);

    // ---- Footer buttons ----
    const footer = document.createElement('div');
    footer.className = 'flex gap-1 px-2 pb-2';

    const searchBtn = document.createElement('button');
    searchBtn.className = 'flex-1 py-1 text-xs text-gray-400 border border-gray-700 rounded-lg hover:border-violet-500 hover:text-violet-400 transition-colors';
    searchBtn.textContent = '🔍 Ver b\u00fasqueda';
    searchBtn.addEventListener('click', (e) => { e.stopPropagation(); openSearchPanel(i); });

    const localBtn = document.createElement('button');
    localBtn.className = 'flex-1 py-1 text-xs text-gray-400 border border-gray-700 rounded-lg hover:border-fuchsia-500 hover:text-fuchsia-400 transition-colors';
    localBtn.textContent = '📁 Local';
    localBtn.addEventListener('click', (e) => { e.stopPropagation(); openReplace(i); });

    footer.appendChild(searchBtn);
    footer.appendChild(localBtn);
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

    return card;
  }

  function renderCandidates(container, slot, slotIdx) {
    container.innerHTML = '';
    const candidates = slot.candidates || [];

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
    if (q) loadPanelResults(q, true);
  });
  panelSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panelSearchBtn.click();
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
  function syncTimeline(currentTime) {
    const idx = slots.findIndex((s) => currentTime >= s.start && currentTime < s.end);
    if (idx === -1 || idx === activeIndex) return;
    if (activeIndex >= 0) {
      const prev = document.getElementById(`card-${activeIndex}`);
      if (prev) prev.classList.remove('card-active');
    }
    activeIndex = idx;
    const card = document.getElementById(`card-${idx}`);
    if (card) {
      card.classList.add('card-active');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  // -- Waveform zoom sync with timeline --------------------
  function applyWaveformZoom() {
    if (waveformZoomApplied) return;
    if (!ws || audioDuration <= 0 || timelineBuiltScrollWidth <= 0) return;
    waveformZoomApplied = true;
    const pxPerSec = timelineBuiltScrollWidth / audioDuration;
    ws.zoom(pxPerSec);
    // WaveSurfer 7 sets overflow-x:auto on getWrapper() when zoomed
    const wfScrollEl = ws.getWrapper ? ws.getWrapper() : document.querySelector('#waveform > div');
    if (!wfScrollEl) return;
    let syncing = false;
    timelineScroll.addEventListener('scroll', () => {
      if (syncing) return; syncing = true;
      wfScrollEl.scrollLeft = timelineScroll.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    }, { passive: true });
    wfScrollEl.addEventListener('scroll', () => {
      if (syncing) return; syncing = true;
      timelineScroll.scrollLeft = wfScrollEl.scrollLeft;
      requestAnimationFrame(() => { syncing = false; });
    }, { passive: true });
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) {
      closeLightbox(); return;
    }
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      ws && ws.playPause();
    }
  });
  wfZoom.addEventListener('input', () => { if (ws) ws.zoom(Number(wfZoom.value)); });
  volumeSlider.addEventListener('input', () => { if (ws) ws.setVolume(Number(volumeSlider.value)); });

  // -- Export ----------------------------------------------
  exportBtn.addEventListener('click', async () => {
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
      onExportDone();
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
          onExportDone();
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

  // -- Post-export: show YouTube button if logged in -------
  function onExportDone() {
    if (currentUser) {
      publishYtBtn.classList.remove('hidden');
    }
    if (autoYT && currentUser) {
      openYTModal();
    }
  }

  // -- YouTube modal ----------------------------------------
  function openYTModal(defaultTitle) {
    ytTitle.value       = defaultTitle || document.title.replace(' – Editor', '') || 'Vídeo Arcanator';
    ytDescription.value = 'Generado con Arcanator';
    ytProgressWrap.classList.add('hidden');
    ytDoneWrap.classList.add('hidden');
    ytSubmit.disabled = false;
    ytCancel.disabled = false;
    ytModal.classList.remove('hidden');
  }

  publishYtBtn.addEventListener('click', () => openYTModal());
  ytCancel.addEventListener('click', () => { ytModal.classList.add('hidden'); });

  ytSubmit.addEventListener('click', async () => {
    const title       = ytTitle.value.trim() || 'Vídeo Arcanator';
    const description = ytDescription.value.trim() || 'Generado con Arcanator';

    ytSubmit.disabled = true;
    ytCancel.disabled = true;
    ytProgressWrap.classList.remove('hidden');
    ytDoneWrap.classList.add('hidden');
    ytBar.style.width = '0%';
    ytMsg.textContent = 'Iniciando…';

    try {
      const res = await fetch(`/api/jobs/${jobId}/publish-youtube`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ title, description }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Error al iniciar la publicación.');
      }
    } catch (err) {
      ytMsg.textContent = `❌ ${err.message}`;
      ytSubmit.disabled = false;
      ytCancel.disabled = false;
      return;
    }

    // Listen for YouTube SSE events
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    es.addEventListener('youtube_progress', (e) => {
      const d = JSON.parse(e.data);
      ytBar.style.width = `${d.percent}%`;
      ytMsg.textContent = d.message;
    });
    es.addEventListener('youtube_done', (e) => {
      es.close();
      const d = JSON.parse(e.data);
      ytBar.style.width = '100%';
      ytMsg.textContent = '¡Publicado!';
      ytLink.href = d.youtube_url;
      ytDoneWrap.classList.remove('hidden');
      ytCancel.textContent = 'Cerrar';
      ytCancel.disabled = false;
      ytSubmit.classList.add('hidden');
    });
    es.addEventListener('youtube_error', (e) => {
      es.close();
      const d = JSON.parse(e.data);
      ytMsg.textContent = `❌ ${d.message}`;
      ytSubmit.disabled = false;
      ytCancel.disabled = false;
    });
    es.onerror = () => { es.close(); };
  });

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
