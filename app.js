(() => {
  'use strict';

  const MAX_SECONDS = 60;
  const BAR = 3;
  const GAP = 2;

  // ---------- Audio context ----------
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  function getCtx() {
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Safari < 14.1 only supports the callback form of decodeAudioData.
  function decode(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const p = getCtx().decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  function reverseBuffer(buf) {
    const out = getCtx().createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0, j = src.length - 1; i < src.length; i++, j--) dst[i] = src[j];
    }
    return out;
  }

  // Cut leading/trailing silence so reversed playback starts right away.
  function trimSilence(buf, threshold = 0.015, padSeconds = 0.08) {
    const data = buf.getChannelData(0);
    let start = 0;
    let end = data.length - 1;
    while (start < end && Math.abs(data[start]) < threshold) start++;
    while (end > start && Math.abs(data[end]) < threshold) end--;
    const pad = Math.floor(padSeconds * buf.sampleRate);
    start = Math.max(0, start - pad);
    end = Math.min(data.length - 1, end + pad);
    const length = end - start + 1;
    if (length >= data.length * 0.98 || length < buf.sampleRate * 0.2) return buf;
    const out = getCtx().createBuffer(buf.numberOfChannels, length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      out.getChannelData(c).set(buf.getChannelData(c).subarray(start, end + 1));
    }
    return out;
  }

  function encodeWav(buf) {
    const channels = Math.min(2, buf.numberOfChannels);
    const rate = buf.sampleRate;
    const frames = buf.length;
    const dataSize = frames * channels * 2;
    const view = new DataView(new ArrayBuffer(44 + dataSize));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, dataSize, true);
    const chData = [];
    for (let c = 0; c < channels; c++) chData.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const s = Math.max(-1, Math.min(1, chData[c][i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---------- Waveform ----------
  class Waveform {
    constructor(canvas) {
      this.canvas = canvas;
      this.g = canvas.getContext('2d');
      this.buffer = null;
      this.peaks = null;
      this.levels = null;
      this.progress = 0;
      this.fromEnd = false;
      if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(canvas);
      else window.addEventListener('resize', () => this.resize());
      this.resize();
    }
    resize() {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (!w || !h) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = w;
      this.h = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.peaks = null;
      this.draw();
    }
    count() { return Math.max(8, Math.floor((this.w - 16 + GAP) / (BAR + GAP))); }
    setBuffer(buf) { this.buffer = buf; this.levels = null; this.peaks = null; this.progress = 0; this.draw(); }
    setLevels(levels) { this.levels = levels; this.draw(); }
    setProgress(p, fromEnd) { this.progress = p; this.fromEnd = fromEnd; this.draw(); }
    computePeaks() {
      const n = this.count();
      const data = this.buffer.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / n));
      const stride = Math.max(1, Math.floor(step / 256));
      const peaks = new Array(n).fill(0);
      let max = 0;
      for (let i = 0; i < n; i++) {
        let m = 0;
        const end = Math.min(data.length, (i + 1) * step);
        for (let j = i * step; j < end; j += stride) {
          const v = Math.abs(data[j]);
          if (v > m) m = v;
        }
        peaks[i] = m;
        if (m > max) max = m;
      }
      this.peaks = peaks.map((v) => (max ? v / max : 0));
    }
    draw() {
      if (!this.w) return;
      const { g, w, h } = this;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const n = this.count();
      let values;
      if (this.levels) {
        const recent = this.levels.slice(-n);
        values = new Array(n - recent.length).fill(0).concat(recent.map((v) => Math.min(1, v * 5)));
      } else if (this.buffer) {
        if (!this.peaks || this.peaks.length !== n) this.computePeaks();
        values = this.peaks;
      } else {
        return;
      }
      const total = n * (BAR + GAP) - GAP;
      const x0 = (w - total) / 2;
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#6cc6f5');
      grad.addColorStop(1, '#8b8df6');
      const dim = this.buffer && !this.levels ? 'rgba(160,175,255,0.35)' : grad;
      const maxH = h - 16;
      for (let i = 0; i < n; i++) {
        const bh = Math.max(2, values[i] * maxH);
        const x = x0 + i * (BAR + GAP);
        const y = (h - bh) / 2;
        const frac = (i + 0.5) / n;
        const played = this.progress > 0 && (this.fromEnd ? frac >= 1 - this.progress : frac <= this.progress);
        g.fillStyle = this.levels ? '#ff4d6a' : played ? grad : dim;
        if (g.roundRect) { g.beginPath(); g.roundRect(x, y, BAR, bh, 1.5); g.fill(); }
        else g.fillRect(x, y, BAR, bh);
      }
    }
  }

  // ---------- Slots (one per recording area) ----------
  const slots = {};
  document.querySelectorAll('.stage[data-slot], .mini-stage[data-slot]').forEach((stage) => {
    const name = stage.dataset.slot;
    const section = stage.closest('.tool, .section');
    slots[name] = {
      name,
      stage,
      timer: stage.querySelector('.timer'),
      wave: new Waveform(stage.querySelector('canvas')),
      speed: name === 'attempt' ? null : section.querySelector('[data-speed]'),
      original: null,
      reversed: null,
    };
  });

  const errorEl = document.querySelector('[data-error]');
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function buttonsFor(name) {
    return document.querySelectorAll(`[data-slot="${name}"]:not(.rec-btn)`);
  }

  function setSlotAudio(name, buf) {
    const s = slots[name];
    s.original = buf;
    s.reversed = reverseBuffer(buf);
    s.wave.setBuffer(buf);
    s.stage.classList.add('has-audio');
    s.timer.textContent = fmt(buf.duration);
    buttonsFor(name).forEach((b) => { b.disabled = false; });
    if (name === 'main') {
      document.querySelector('[data-playback="main"]').hidden = false;
      const nudge = document.getElementById('app-nudge');
      if (nudge.hidden) setTimeout(() => { nudge.hidden = false; }, 1200);
    }
    const compare = document.querySelector('[data-action="compare"]');
    compare.disabled = !(slots.original.original && slots.attempt.original);
  }

  // ---------- Playback ----------
  const player = {
    node: null,
    raf: 0,
    key: null,
    onStop: null,
    stop() {
      if (this.node) {
        this.node.onended = null;
        try { this.node.stop(); } catch (e) { /* already stopped */ }
        this.node.disconnect();
        this.node = null;
      }
      cancelAnimationFrame(this.raf);
      const cb = this.onStop;
      this.onStop = null;
      this.key = null;
      if (cb) cb();
    },
    play(key, buffer, rate, onProgress, onEnd) {
      this.stop();
      const c = getCtx();
      const node = c.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = rate;
      node.connect(c.destination);
      const start = c.currentTime;
      const dur = buffer.duration / rate;
      node.onended = () => {
        this.node = null;
        this.key = null;
        this.onStop = null;
        cancelAnimationFrame(this.raf);
        onEnd();
      };
      node.start();
      this.node = node;
      this.key = key;
      this.onStop = onEnd;
      const tick = () => {
        const p = Math.min(1, (c.currentTime - start) / dur);
        onProgress(p);
        if (p < 1) this.raf = requestAnimationFrame(tick);
      };
      tick();
    },
  };

  function rateFor(s) {
    return s.speed ? parseFloat(s.speed.value) : 1;
  }

  function playBuffer(name, reversed, onEnd) {
    const s = slots[name];
    player.play(
      `${name}:${reversed}`,
      reversed ? s.reversed : s.original,
      reversed ? rateFor(s) : 1,
      (p) => s.wave.setProgress(p, reversed),
      () => {
        s.wave.setProgress(0, false);
        onEnd();
      },
    );
  }

  function playSlot(btn, name, reversed) {
    compare.active = false;
    if (player.key === `${name}:${reversed}`) { player.stop(); return; }
    const labelEl = btn.querySelector('span') || btn;
    const label = labelEl.textContent;
    playBuffer(name, reversed, () => {
      btn.classList.remove('is-playing');
      labelEl.textContent = label;
    });
    btn.classList.add('is-playing');
    labelEl.textContent = 'Stop';
  }

  // Plays the original, then the reversed attempt.
  const compare = { active: false };
  function stopPlayback() {
    compare.active = false;
    player.stop();
  }
  function playCompare(btn) {
    if (compare.active) { compare.active = false; player.stop(); return; }
    const label = btn.textContent;
    const finish = () => {
      compare.active = false;
      btn.classList.remove('is-playing');
      btn.textContent = label;
    };
    compare.active = true;
    btn.classList.add('is-playing');
    btn.textContent = 'Stop';
    playBuffer('original', false, () => {
      if (!compare.active) { finish(); return; }
      setTimeout(() => {
        if (!compare.active) { finish(); return; }
        playBuffer('attempt', true, finish);
      }, 400);
    });
  }

  // ---------- Recording ----------
  const rec = { name: null, mr: null, stream: null, source: null, raf: 0, timeout: 0 };

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
      .find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRecording(name, btn) {
    showError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      showError("Recording isn't supported in this browser. Try uploading an audio file instead, or use the latest Chrome, Safari or Firefox.");
      return;
    }
    stopPlayback();
    const c = getCtx();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      showError(err && err.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in your browser settings and try again.'
        : 'No microphone found. Plug one in or upload an audio file instead.');
      if (name !== 'main') document.getElementById('tool').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const s = slots[name];
    const source = c.createMediaStreamSource(stream);
    const analyser = c.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const levels = [];

    const mime = pickMime();
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      source.disconnect();
      s.stage.classList.remove('is-recording');
      s.wave.levels = null;
      try {
        const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
        const buf = await decode(await blob.arrayBuffer());
        if (buf.duration < 0.2) throw new Error('too short');
        setSlotAudio(name, trimSilence(buf));
      } catch (e) {
        s.wave.draw();
        showError('That recording was too short or could not be read. Please try again.');
      }
    };

    Object.assign(rec, { name, mr, stream, source });
    mr.start();
    s.stage.classList.add('is-recording');
    btn.classList.add('recording');
    btn.querySelector('.rec-label').textContent = 'Stop';

    const t0 = performance.now();
    const loop = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      levels.push(Math.sqrt(sum / samples.length));
      s.wave.setLevels(levels);
      s.timer.textContent = fmt((performance.now() - t0) / 1000);
      rec.raf = requestAnimationFrame(loop);
    };
    loop();
    rec.timeout = setTimeout(() => stopRecording(), MAX_SECONDS * 1000);
  }

  function stopRecording() {
    if (!rec.mr) return;
    cancelAnimationFrame(rec.raf);
    clearTimeout(rec.timeout);
    const btn = document.querySelector(`.rec-btn[data-slot="${rec.name}"]`);
    btn.classList.remove('recording');
    btn.querySelector('.rec-label').textContent = 'Record again';
    if (rec.mr.state !== 'inactive') rec.mr.stop();
    rec.mr = null;
    rec.name = null;
  }

  // ---------- Upload ----------
  document.querySelector('[data-upload="main"]').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    showError('');
    if (rec.mr) stopRecording();
    stopPlayback();
    if (file.size > 150 * 1024 * 1024) {
      showError('That file is too big. Please choose a file under 150 MB.');
      return;
    }
    try {
      setSlotAudio('main', await decode(await file.arrayBuffer()));
      document.querySelector('.rec-btn[data-slot="main"] .rec-label').textContent = 'Record';
    } catch (err) {
      showError("Couldn't read that file. Try an MP3, WAV, M4A or OGG file.");
    }
  });

  // ---------- Share / download ----------
  function fileNameFor(name) {
    return name === 'attempt' ? 'reverse-singing-result.wav' : 'reversed-audio.wav';
  }

  function download(name) {
    const url = URL.createObjectURL(encodeWav(slots[name].reversed));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameFor(name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const canShareFiles = (() => {
    try {
      return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.wav', { type: 'audio/wav' })] }));
    } catch (e) { return false; }
  })();
  if (canShareFiles) document.querySelector('[data-action="share"]').hidden = false;

  async function share(name) {
    const file = new File([encodeWav(slots[name].reversed)], fileNameFor(name), { type: 'audio/wav' });
    try {
      await navigator.share({ files: [file], title: 'My reversed voice', text: 'Made with voicereverser.com' });
    } catch (e) { /* cancelled */ }
  }

  // ---------- Click handling ----------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const name = btn.dataset.slot;
    switch (btn.dataset.action) {
      case 'record':
        if (rec.name === name) stopRecording();
        else {
          if (rec.mr) stopRecording();
          startRecording(name, btn);
        }
        break;
      case 'play-reversed':
        playSlot(btn, name, true);
        break;
      case 'play-original':
        playSlot(btn, name, false);
        break;
      case 'compare':
        playCompare(btn);
        break;
      case 'download':
        download(name);
        break;
      case 'share':
        share(name);
        break;
    }
  });

  document.querySelectorAll('[data-speed]').forEach((input) => {
    const out = input.parentElement.querySelector('[data-speed-out]');
    input.addEventListener('input', () => {
      out.textContent = `${parseFloat(input.value).toFixed(2)}×`;
      if (player.node && player.key.endsWith(':true')) player.node.playbackRate.value = parseFloat(input.value);
    });
  });

  // ---------- Text reverser ----------
  const seg = window.Intl && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const chars = (s) => (seg ? Array.from(seg.segment(s), (x) => x.segment) : Array.from(s));
  const FLIP = {
    a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ',
    n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ', s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z',
    A: '∀', B: 'ᗺ', C: 'Ɔ', D: 'ᗡ', E: 'Ǝ', F: 'Ⅎ', G: '⅁', H: 'H', I: 'I', J: 'ſ', K: 'ʞ', L: '˥', M: 'W',
    N: 'N', O: 'O', P: 'Ԁ', Q: 'Ό', R: 'ᴚ', S: 'S', T: '⊥', U: '∩', V: 'Λ', W: 'M', X: 'X', Y: '⅄', Z: 'Z',
    1: 'Ɩ', 2: 'ᄅ', 3: 'Ɛ', 4: 'ㄣ', 5: 'ϛ', 6: '9', 7: 'ㄥ', 8: '8', 9: '6', 0: '0',
    '.': '˙', ',': "'", "'": ',', '"': '„', '!': '¡', '?': '¿', '(': ')', ')': '(', '[': ']', ']': '[',
    '{': '}', '}': '{', '<': '>', '>': '<', '&': '⅋', _: '‾',
  };
  const modes = {
    chars: (t) => chars(t).reverse().join(''),
    words: (t) => t.split('\n').map((l) => l.split(/(\s+)/).reverse().join('')).join('\n'),
    each: (t) => t.replace(/\S+/g, (w) => chars(w).reverse().join('')),
    flip: (t) => chars(t).reverse().map((ch) => FLIP[ch] || ch).join(''),
  };
  const textIn = document.getElementById('text-in');
  const textOut = document.getElementById('text-out');
  let mode = 'chars';
  const updateText = () => { textOut.value = modes[mode](textIn.value); };
  textIn.addEventListener('input', updateText);
  document.querySelectorAll('.chip[data-mode]').forEach((chip) => {
    chip.addEventListener('click', () => {
      mode = chip.dataset.mode;
      document.querySelectorAll('.chip[data-mode]').forEach((c) => c.setAttribute('aria-checked', String(c === chip)));
      updateText();
    });
  });
  document.getElementById('copy-text').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(textOut.value);
    } catch (err) {
      textOut.select();
      document.execCommand('copy');
    }
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
  });
  updateText();

  document.getElementById('year').textContent = new Date().getFullYear();
})();
