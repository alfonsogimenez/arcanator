/* =========================================================
   app.js  –  Upload page logic for Arcanator
   ========================================================= */

(() => {
  // ── DOM refs ──────────────────────────────────────────────
  const dropZone      = document.getElementById('drop-zone');
  const audioInput    = document.getElementById('audio-input');
  const dropLabel     = document.getElementById('drop-label');
  const dropIcon      = document.getElementById('drop-icon');
  const intervalSlider = document.getElementById('interval');
  const intervalValue = document.getElementById('interval-value');
  const submitBtn     = document.getElementById('submit-btn');
  const form          = document.getElementById('upload-form');
  const uploadSection = document.getElementById('upload-section');
  const progressSec   = document.getElementById('progress-section');
  const progressBar   = document.getElementById('progress-bar');
  const progressMsg   = document.getElementById('progress-msg');
  const previewGrid   = document.getElementById('preview-grid');
  const errorMsg      = document.getElementById('error-msg');

  let selectedFile = null;

  // ── Interval slider ───────────────────────────────────────
  intervalSlider.addEventListener('input', () => {
    intervalValue.textContent = `${intervalSlider.value} s`;
  });

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
    fd.append('interval', intervalSlider.value);

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
      submitBtn.textContent = 'Generar Video';
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
})();
