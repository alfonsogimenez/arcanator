/* =========================================================
   app.js  –  Upload page logic for Arcanator
   ========================================================= */

(() => {
  // ── DOM refs ──────────────────────────────────────────────
  const dropZone      = document.getElementById('drop-zone');
  const audioInput    = document.getElementById('audio-input');
  const dropLabel     = document.getElementById('drop-label');
  const dropIcon      = document.getElementById('drop-icon');
  const submitBtn     = document.getElementById('submit-btn');
  const form          = document.getElementById('upload-form');
  const uploadSection = document.getElementById('upload-section');
  const progressSec   = document.getElementById('progress-section');
  const progressBar   = document.getElementById('progress-bar');
  const progressMsg   = document.getElementById('progress-msg');
  const previewGrid   = document.getElementById('preview-grid');
  const errorMsg      = document.getElementById('error-msg');

  let selectedFile  = null;

  // ── Drop zone: click to open file picker ─────────────────
  dropZone.addEventListener('click', () => audioInput.click());

  audioInput.addEventListener('change', () => {
    if (audioInput.files[0]) selectFile(audioInput.files[0]);
  });

  // ── Drag & drop ───────────────────────────────────────────
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('border-violet-400', 'bg-violet-950/30');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('border-violet-400', 'bg-violet-950/30');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-violet-400', 'bg-violet-950/30');
    const file = e.dataTransfer.files[0];
    if (file) selectFile(file);
  });

  function selectFile(file) {
    selectedFile = file;
    const name = file.name.length > 40 ? file.name.slice(0, 38) + '…' : file.name;
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    dropIcon.textContent = '✅';
    dropLabel.innerHTML = `<span class="text-green-400 font-semibold">${name}</span>
      <span class="text-gray-500 text-xs ml-2">${sizeMB} MB</span>`;
    submitBtn.disabled = false;
  }

  // ── Form submit ───────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedFile) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Subiendo…';
    errorMsg.classList.add('hidden');

    const fd = new FormData();
    fd.append('audio', selectedFile);
    fd.append('interval', '10');

    let jobId;
    try {
      const res = await fetch('/api/jobs', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || 'Error al crear el job.');
      }
      const data = await res.json();
      jobId = data.job_id;
    } catch (err) {
      showError(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Ir al editor →';
      return;
    }

    // Show progress UI
    uploadSection.classList.add('hidden');
    progressSec.classList.remove('hidden');
    listenToJob(jobId);
  });

  // ── SSE listener ─────────────────────────────────────────
  function listenToJob(jobId) {
    const es = new EventSource(`/api/jobs/${jobId}/stream`);

    es.addEventListener('state', (e) => {
      const data = JSON.parse(e.data);
      setProgress(data.progress_percent || 0, data.progress_message || '');
      // If already finished (page reload scenario)
      if (data.status === 'ready' || data.status === 'done') {
        es.close();
        goToEditor(jobId);
      }
    });

    es.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data);
      setProgress(data.percent, data.message);
    });

    es.addEventListener('slot_ready', (e) => {
      const data = JSON.parse(e.data);
      addPreviewThumb(data);
    });

    es.addEventListener('done', (e) => {
      es.close();
      setProgress(100, '¡Completado! Abriendo editor…');
      setTimeout(() => goToEditor(jobId), 800);
    });

    es.addEventListener('error', (e) => {
      es.close();
      let msg = 'Error desconocido';
      try { msg = JSON.parse(e.data).message; } catch (_) {}
      showError(msg);
    });

    es.onerror = () => {
      // SSE disconnected (can happen through IIS proxy) – fall back to polling
      es.close();
      pollJob(jobId);
    };
  }

  // ── Polling fallback ─────────────────────────────────────
  async function pollJob(jobId) {
    const intervalId = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        const job = await res.json();
        setProgress(job.progress_percent || 0, job.progress_message || '');

        // Rebuild preview grid from available slots
        previewGrid.innerHTML = '';
        (job.slots || []).forEach((s) => {
          if (s.image_url) addPreviewThumb(s);
        });

        if (job.status === 'ready' || job.status === 'done') {
          clearInterval(intervalId);
          setTimeout(() => goToEditor(jobId), 600);
        }
        if (job.status === 'error') {
          clearInterval(intervalId);
          showError(job.error || 'Error en el procesamiento');
        }
      } catch (_) { /* keep polling */ }
    }, 1500);
  }

  // ── Helpers ───────────────────────────────────────────────
  function setProgress(percent, message) {
    progressBar.style.width = `${Math.min(100, percent)}%`;
    progressMsg.textContent = message;
  }

  function addPreviewThumb(slot) {
    if (!slot.image_url) return;
    const existing = document.getElementById(`prev-${slot.index}`);
    if (existing) { existing.src = slot.image_url + '?t=' + Date.now(); return; }

    const img = document.createElement('img');
    img.id = `prev-${slot.index}`;
    img.src = slot.image_url;
    img.alt = slot.text || '';
    img.title = slot.text || '';
    img.className = 'w-full aspect-video object-cover rounded-lg border border-gray-800 fade-in';
    previewGrid.appendChild(img);
  }

  function showError(msg) {
    progressSec.classList.remove('hidden');
    uploadSection.classList.add('hidden');
    errorMsg.textContent = `❌ ${msg}`;
    errorMsg.classList.remove('hidden');
    progressMsg.textContent = 'Se produjo un error.';
  }

  function goToEditor(jobId) {
    window.location.href = `/editor.html?job=${jobId}`;
  }

  // ── Recent jobs ───────────────────────────────────────────
  const recentSection = document.getElementById('recent-section');
  const recentList    = document.getElementById('recent-list');

  const STATUS_LABEL = {
    queued:      { text: 'En cola',   cls: 'text-yellow-400' },
    transcribing:{ text: 'Analizando',cls: 'text-blue-400'   },
    ready:       { text: 'Listo',     cls: 'text-green-400'  },
    done:        { text: 'Exportado', cls: 'text-violet-400' },
    error:       { text: 'Error',     cls: 'text-red-400'    },
  };

  function formatRelative(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() / 1000) - ts);
    if (diff < 60)       return 'hace un momento';
    if (diff < 3600)     return `hace ${Math.floor(diff / 60)} min`;
    if (diff < 86400)    return `hace ${Math.floor(diff / 3600)} h`;
    return `hace ${Math.floor(diff / 86400)} d`;
  }

  async function loadRecentJobs() {
    try {
      const res = await fetch('/api/jobs?limit=8');
      if (!res.ok) return;
      const jobs = await res.json();
      if (!jobs.length) return;

      recentList.innerHTML = '';
      jobs.forEach(job => {
        const sl = STATUS_LABEL[job.status] || { text: job.status, cls: 'text-gray-400' };
        const name = (job.audio_filename || 'audio').replace(/\.[^.]+$/, '');
        const slots = job.slots_count;
        const when  = formatRelative(job.created_at);

        const li = document.createElement('li');
        li.id = `recent-${job.id}`;
        li.className = 'flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 hover:border-violet-600 transition-colors group';
        li.innerHTML = `
          <span class="text-2xl select-none cursor-pointer" data-open>🎙️</span>
          <div class="flex-1 min-w-0 cursor-pointer" data-open>
            <p class="text-sm font-medium text-gray-200 truncate">${name}</p>
            <p class="text-xs text-gray-500">${slots} columna${slots !== 1 ? 's' : ''} · ${when}</p>
          </div>
          <span class="text-xs font-semibold ${sl.cls} shrink-0 cursor-pointer" data-open>${sl.text}</span>
          <span class="text-gray-600 group-hover:text-violet-400 transition-colors text-lg cursor-pointer" data-open>→</span>
          <button data-del title="Eliminar proyecto"
            class="ml-1 text-gray-600 hover:text-red-400 transition-colors text-lg leading-none shrink-0 px-1"
          >🗑</button>
        `;
        // Open editor when clicking anywhere except the delete button
        li.querySelectorAll('[data-open]').forEach(el =>
          el.addEventListener('click', () => goToEditor(job.id))
        );
        // Delete button
        li.querySelector('[data-del]').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`¿Eliminar el proyecto "${name}"? Se borrarán todos sus archivos.`)) return;
          try {
            const r = await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
            if (!r.ok) throw new Error(await r.text());
            const el = document.getElementById(`recent-${job.id}`);
            if (el) el.remove();
            if (!recentList.children.length) recentSection.classList.add('hidden');
          } catch (err) {
            alert(`Error al eliminar: ${err.message}`);
          }
        });
        recentList.appendChild(li);
      });

      recentSection.classList.remove('hidden');
    } catch (_) {}
  }

  loadRecentJobs();
})();
