/* Reproductor con seguimiento — Portilla Law Cumplimiento
 * Cuenta sólo los segundos vistos en reproducción normal (adelantar no cuenta),
 * pausa si el empleado cambia de pestaña y pregunta "¿Sigues ahí?" periódicamente. */
(function () {
  'use strict';
  var root = document.getElementById('player-root');
  if (!root) return;
  var cfg = JSON.parse(root.getAttribute('data-config'));
  var state = { time: cfg.lastPosition || 0, duration: cfg.duration || 0, playing: false };
  var adapter = null;
  var intervals = cfg.intervals || [];   // confirmados por el servidor
  var pending = [];                      // vistos y aún no enviados
  var last = null, playedSinceCheck = 0, presence = cfg.presence || 0, waitingPresence = false, completed = cfg.completed;
  var $ = function (id) { return document.getElementById(id); };

  function merge(list) {
    var s = list.filter(function (x) { return x[1] > x[0]; }).map(function (x) { return [x[0], x[1]]; }).sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    s.forEach(function (x) { var l = out[out.length - 1]; if (l && x[0] <= l[1] + 1) l[1] = Math.max(l[1], x[1]); else out.push(x); });
    return out;
  }
  function watchedPct() {
    if (!state.duration) return 0;
    var m = merge(intervals.concat(pending)), s = 0;
    m.forEach(function (x) { s += x[1] - x[0]; });
    return Math.min(100, Math.floor(s / state.duration * 100));
  }
  function furthest() { // hasta dónde ha visto de forma continua desde el inicio
    var m = merge(intervals.concat(pending));
    return m.length && m[0][0] <= 1 ? m[0][1] : 0;
  }
  function render(pct) {
    pct = pct == null ? watchedPct() : pct;
    $('vp-bar').style.width = pct + '%';
    $('vp-bar').style.background = pct >= cfg.minPct ? '#1b7f4b' : '#0b3d63';
    $('vp-pct').textContent = pct + '%';
    if (pct >= cfg.minPct && !completed) { /* se confirma con la respuesta del servidor */ }
  }
  function showDone() {
    completed = true;
    $('vp-done').hidden = false;
  }

  // --- Envío de progreso ---
  var sending = false;
  function send(final) {
    if (sending || (!pending.length && !final) || !state.duration) return;
    sending = true;
    var batch = pending; pending = [];
    fetch(cfg.endpoint, {
      method: 'POST', credentials: 'same-origin', keepalive: !!final,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: state.duration, intervals: batch, position: state.time, presence: presence }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      sending = false;
      if (!j.ok) { $('vp-msg').textContent = j.error || 'No se pudo guardar el progreso.'; return; }
      intervals = j.intervals || intervals;
      render(j.pct);
      if (j.completed) showDone();
    }).catch(function () { sending = false; pending = batch.concat(pending); $('vp-msg').textContent = 'Sin conexión: el progreso se guardará al reconectar.'; });
  }

  // --- Bucle de seguimiento (cada medio segundo) ---
  // Sólo se acredita el avance natural entre dos lecturas (máx. ~2x de velocidad).
  function sample() {
    if (!adapter || waitingPresence) return;
    adapter.poll && adapter.poll();
    if (!state.playing || document.hidden) { last = null; return; }
    var t = state.time;
    if (last !== null) {
      var d = t - last;
      if (d > 0 && d <= 1.6) { pending.push([last, t]); pending = merge(pending); playedSinceCheck += d; }
    }
    last = t;
    render();
    if (cfg.presenceMin > 0 && playedSinceCheck >= cfg.presenceMin * 60) askPresence();
  }
  setInterval(sample, 500);
  setInterval(function () { send(false); }, 15000);
  window.addEventListener('pagehide', function () { send(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && adapter && state.playing) { adapter.pause(); $('vp-msg').textContent = 'El video se pausó porque cambiaste de pestaña. Debe estar visible para que cuente.'; }
    if (document.hidden) send(true);
  });

  function askPresence() {
    waitingPresence = true; playedSinceCheck = 0;
    adapter.pause();
    $('vp-presence').hidden = false;
  }
  $('vp-presence-btn').addEventListener('click', function () {
    presence++; waitingPresence = false; $('vp-presence').hidden = true; last = null;
    send(false); adapter.play();
  });

  function onEnded() {
    // acreditar el último tramo hasta el final del video
    if (last !== null && state.duration && state.duration - last > 0 && state.duration - last <= 1.6) { pending.push([last, state.duration]); pending = merge(pending); }
    state.playing = false; last = null; render(); send(false);
  }

  // --- Adaptadores por plataforma ---
  function loadScript(src, cb) { var s = document.createElement('script'); s.src = src; s.onload = cb; document.head.appendChild(s); }

  function fileAdapter() {
    var v = document.createElement('video');
    v.src = cfg.src.url; v.controls = true; v.playsInline = true; v.preload = 'metadata';
    v.setAttribute('controlsList', 'nodownload noplaybackrate'); v.style.width = '100%';
    $('player').appendChild(v);
    v.addEventListener('loadedmetadata', function () { state.duration = v.duration; if (cfg.lastPosition) v.currentTime = Math.min(cfg.lastPosition, furthest()); render(); });
    v.addEventListener('timeupdate', function () { state.time = v.currentTime; });
    v.addEventListener('playing', function () { state.time = v.currentTime; state.playing = true; last = v.currentTime; });
    v.addEventListener('pause', function () { state.playing = false; send(false); });
    v.addEventListener('ended', onEnded);
    v.addEventListener('ratechange', function () { if (v.playbackRate > 2) v.playbackRate = 2; });
    v.addEventListener('seeking', function () { // no permitir adelantar más allá de lo visto
      var max = Math.max(furthest(), last || 0);
      if (v.currentTime > max + 1) { v.currentTime = max; $('vp-msg').textContent = 'No es posible adelantar partes que aún no has visto.'; }
      last = null;
    });
    v.addEventListener('seeked', function () { state.time = v.currentTime; if (!v.paused) last = v.currentTime; });
    return { pause: function () { v.pause(); }, play: function () { v.play(); } };
  }

  function youtubeAdapter(cb) {
    var div = document.createElement('div'); div.id = 'yt-frame'; $('player').appendChild(div);
    window.onYouTubeIframeAPIReady = function () {
      var p = new YT.Player('yt-frame', {
        videoId: cfg.src.id, width: '100%', height: '100%',
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1, start: Math.floor(cfg.lastPosition || 0) },
        events: {
          onReady: function () { state.duration = p.getDuration(); render(); },
          onStateChange: function (e) {
            state.playing = e.data === YT.PlayerState.PLAYING;
            if (e.data === YT.PlayerState.PAUSED) send(false);
            if (e.data === YT.PlayerState.ENDED) onEnded();
          },
        },
      });
      cb({
        poll: function () { if (p.getCurrentTime) { state.time = p.getCurrentTime(); state.duration = p.getDuration() || state.duration; } },
        pause: function () { p.pauseVideo(); }, play: function () { p.playVideo(); },
      });
    };
    loadScript('https://www.youtube.com/iframe_api');
  }

  function vimeoAdapter(cb) {
    loadScript('https://player.vimeo.com/api/player.js', function () {
      var opts = cfg.src.hash ? { url: 'https://vimeo.com/' + cfg.src.id + '/' + cfg.src.hash } : { id: Number(cfg.src.id) };
      opts.responsive = true;
      var p = new Vimeo.Player($('player'), opts);
      p.getDuration().then(function (d) { state.duration = d; render(); if (cfg.lastPosition) p.setCurrentTime(cfg.lastPosition).catch(function () {}); });
      p.on('timeupdate', function (d) { state.time = d.seconds; state.duration = d.duration || state.duration; });
      p.on('play', function () { state.playing = true; });
      p.on('pause', function () { state.playing = false; send(false); });
      p.on('ended', onEnded);
      p.on('playbackratechange', function (d) { if (d.playbackRate > 2) p.setPlaybackRate(2).catch(function () {}); });
      cb({ pause: function () { p.pause(); }, play: function () { p.play(); } });
    });
  }

  render(cfg.pct);
  if (completed) showDone();
  if (cfg.src.provider === 'file') adapter = fileAdapter();
  else if (cfg.src.provider === 'youtube') youtubeAdapter(function (a) { adapter = a; });
  else if (cfg.src.provider === 'vimeo') vimeoAdapter(function (a) { adapter = a; });
})();
