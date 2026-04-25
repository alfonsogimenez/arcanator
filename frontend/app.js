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
  const submitYtBtn   = document.getElementById('submit-yt-btn');
  const form          = document.getElementById('upload-form');
  const uploadSection = document.getElementById('upload-section');
  const progressSec   = document.getElementById('progress-section');
  const progressBar   = document.getElementById('progress-bar');
  const progressMsg   = document.getElementById('progress-msg');
  const previewGrid   = document.getElementById('preview-grid');
  const errorMsg      = document.getElementById('error-msg');
  const authBar       = document.getElementById('auth-bar');

  let selectedFile  = null;
  let currentUser   = null;
  let autoPublishYT = false;

  // ── Auth: check login state on load ──────────────────────
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
           class="flex items-center gap-2 px-4 py-2 bg-white text-gray-900 rounded-full text-sm font-semibold hover:bg-gray-100 transition-colors shadow">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" class="w-5 h-5">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.5 1.2 8.9 3.2l6.6-6.6C35.4 2.5 30 0 24 0 14.7 0 6.7 5.5 2.9 13.5l7.7 6C12.5 13.4 17.8 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.4c-.5 2.8-2.2 5.2-4.7 6.8l7.3 5.7c4.3-4 6.8-9.9 6.8-16.5z"/>
            <path fill="#FBBC05" d="M10.6 28.5c-.6-1.7-.9-3.5-.9-5.5s.3-3.8.9-5.5l-7.7-6C1 14.5 0 19.1 0 24s1 9.5 2.9 13.5l7.7-6z"/>
            <path fill="#34A853" d="M24 48c6 0 11-2 14.7-5.3l-7.3-5.7c-2 1.4-4.6 2.2-7.4 2.2-6.2 0-11.5-3.9-13.4-9.5l-7.7 6C6.7 42.5 14.7 48 24 48z"/>
          </svg>
          Iniciar sesión con Google
        </a>`;
      submitYtBtn.classList.add('hidden');
    } else {
      authBar.innerHTML = `
        <img src="${currentUser.picture}" class="w-8 h-8 rounded-full border border-gray-600" alt="avatar" />
        <span class="text-sm text-gray-300 hidden sm:inline">${currentUser.name}</span>
        <form method="post" action="/api/auth/logout" class="inline">
          <button type="submit" class="text-xs text-gray-500 hover:text-gray-300 underline">Salir</button>
        </form>`;
      // Show YouTube button if a file is already selected
      if (selectedFile) submitYtBtn.classList.remove('hidden');
    }
  }

  checkAuth();

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
    if (currentUser) {
      submitYtBtn.disabled = false;
      submitYtBtn.classList.remove('hidden');
    }
  }

  // ── YouTube button ────────────────────────────────────────
  submitYtBtn.addEventListener('click', () => {
    autoPublishYT = true;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });

  // ── Form submit ───────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedFile) return;

    submitBtn.disabled = true;
    submitYtBtn.disabled = true;
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
    listenToJob(jobId, autoPublishYT);
    autoPublishYT = false;
  });

  // ── SSE listener ─────────────────────────────────────────
  function listenToJob(jobId, publishToYT) {
    const es = new EventSource(`/api/jobs/${jobId}/stream`);

    es.addEventListener('state', (e) => {
      const data = JSON.parse(e.data);
      setProgress(data.progress_percent || 0, data.progress_message || '');
      // If already finished (page reload scenario)
      if (data.status === 'ready' || data.status === 'done') {
        es.close();
        goToEditor(jobId, publishToYT);
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
      setTimeout(() => goToEditor(jobId, publishToYT), 800);
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
      pollJob(jobId, publishToYT);
    };
  }

  // ── Polling fallback ─────────────────────────────────────
  async function pollJob(jobId, publishToYT) {
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
          setTimeout(() => goToEditor(jobId, publishToYT), 600);
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

  function goToEditor(jobId, publishToYT) {
    const url = publishToYT
      ? `/editor.html?job=${jobId}&yt=1`
      : `/editor.html?job=${jobId}`;
    window.location.href = url;
  }
})();
