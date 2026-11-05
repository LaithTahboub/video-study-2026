/* Pairwise video study: two-alternative forced choice, side by side; a main question (which video to tour with) and side questions per trial.
   No build step. Reads config.js (window.STUDY_CONFIG) and data/study.json (forms, clips, inputs).
   URL options: f=<form> pins a form; reset=1 clears this browser's saved session;
   test only: autotest=1 answers by itself, rate=<x> plays faster, ext=webm loads the VP9 test copies. */
(function () {
  'use strict';

  var CFG = Object.assign({ endpoint: '', contact: 'the person who sent you this link', data: 'data/study.json' },
    window.STUDY_CONFIG || {});
  var Q = new URLSearchParams(location.search);
  var AUTOTEST = Q.get('autotest') === '1';
  var RATE = parseFloat(Q.get('rate') || '1') || 1;
  // preview only (config.js no_wait: true): answers and Next unlock at once, without watching both videos to the end
  var NO_WAIT = CFG.no_wait === true;
  var EXT = Q.get('ext');
  var LS_KEY = 'vts_state_v1';
  var SEND_EVERY = 1;   // 2026-11-05: after every trial, so a rater who stops early loses nothing

  var S = null;      // study data
  var st = null;     // session state, saved in localStorage
  var form = null;   // this session's form
  var blobs = {};    // clip id -> Promise of an object URL

  function $(id) { return document.getElementById(id); }
  function now() { return Math.round(performance.now()); }
  function show(id) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    window.scrollTo(0, 0);
  }
  function fail(msg) { $('error-text').textContent = msg; show('screen-error'); }

  // ---------- storage ----------
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } }
  function load() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; } }
  function clearSaved() { try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ } }

  function randomId(n) {
    var a = new Uint8Array(n), s = '', abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < n; i++) s += abc[a[i] % abc.length];
    return s;
  }
  // small seeded generator for the self-test answers
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // ---------- network ----------
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]);
  }
  function endpointUrl(params) {
    var sep = CFG.endpoint.indexOf('?') >= 0 ? '&' : '?';
    return CFG.endpoint + sep + params;
  }
  function payload(type) {
    return {
      type: type, study_id: S.study_id, session: st.session, form: st.form, form_how: st.form_how,
      started: st.started, sent_at: new Date().toISOString(), meta: st.meta, n_trials: form.trials.length,
      done: st.idx >= form.trials.length, trials: st.trials
    };
  }
  // returns 'ok' (server answered), 'sent' (sent, answer not readable), 'fail' or 'none' (no endpoint)
  function send(type) {
    if (!CFG.endpoint) return Promise.resolve('none');
    var body = JSON.stringify(payload(type));
    var opts = { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain;charset=utf-8' } };
    return withTimeout(fetch(CFG.endpoint, opts), 15000).then(function (r) {
      return r.ok ? 'ok' : Promise.reject(new Error('status ' + r.status));
    }).catch(function () {
      opts.mode = 'no-cors';
      return withTimeout(fetch(CFG.endpoint, opts), 15000).then(function () { return 'sent'; })
        .catch(function () { return 'fail'; });
    });
  }
  function beacon() {
    if (!CFG.endpoint || !st || !form || !navigator.sendBeacon) return;
    try { navigator.sendBeacon(CFG.endpoint, new Blob([JSON.stringify(payload('beacon'))], { type: 'text/plain' })); }
    catch (e) { /* ignore */ }
  }

  function pickForm() {
    var n = S.n_forms;
    if (Q.has('f')) {
      var k = parseInt(Q.get('f'), 10) || 0;
      return Promise.resolve({ form: ((k % n) + n) % n, how: 'link' });
    }
    var random = { form: Math.floor(Math.random() * n), how: 'random' };
    if (!CFG.endpoint) return Promise.resolve(random);
    return withTimeout(fetch(endpointUrl('action=next&study=' + encodeURIComponent(S.study_id))), 6000)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        return (typeof j.form === 'number' && isFinite(j.form)) ? { form: ((j.form % n) + n) % n, how: 'counter' } : random;
      })
      .catch(function () { return random; });
  }

  // ---------- clips ----------
  function clipUrl(id) {
    var u = S.clips[id];
    return EXT ? u.replace(/\.mp4$/, '.' + EXT) : u;
  }
  function prefetch(id) {
    if (!blobs[id]) {
      blobs[id] = fetch(clipUrl(id)).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (b) { return URL.createObjectURL(b); })
        .catch(function () { return clipUrl(id); });   // fall back to streaming the file directly
    }
    return blobs[id];
  }
  function prefetchTrial(i) {
    if (form && i < form.trials.length) { prefetch(form.trials[i].L); prefetch(form.trials[i].R); }
  }
  function releaseUnused(fromIdx) {
    var keep = {};
    for (var i = fromIdx; i < form.trials.length; i++) { keep[form.trials[i].L] = 1; keep[form.trials[i].R] = 1; }
    Object.keys(blobs).forEach(function (id) {
      if (!keep[id]) {
        blobs[id].then(function (u) { if (u.indexOf('blob:') === 0) URL.revokeObjectURL(u); });
        delete blobs[id];
      }
    });
  }

  // ---------- trial ----------
  var cur = null;   // the running trial's record and player state

  // the first question is the main one (full width, accented); the others sit side by side under it
  function questionRow(q, qi, main) {
    var row = document.createElement('div');
    row.className = 'q locked' + (main ? ' main' : '');
    row.dataset.q = q.id;
    var txt = document.createElement('div');
    txt.className = 'qtext';
    var num = document.createElement('b');
    num.textContent = String(qi + 1);
    txt.appendChild(num);
    txt.appendChild(document.createTextNode(q.text));
    var ch = document.createElement('div');
    ch.className = 'choices';
    ['L', 'R'].forEach(function (side) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'ans-' + q.id + '-' + side;
      b.textContent = side === 'L' ? 'Left' : 'Right';
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', (side === 'L' ? 'Left' : 'Right') + ': ' + q.text);
      b.disabled = true;
      b.addEventListener('click', function () { answer(q.id, side); });
      ch.appendChild(b);
    });
    row.appendChild(txt);
    row.appendChild(ch);
    return row;
  }

  function buildQuestions() {
    var box = $('questions');
    box.innerHTML = '';
    box.appendChild(questionRow(S.questions[0], 0, true));
    if (S.questions.length > 1) {
      var side = document.createElement('div');
      side.className = 'side';
      S.questions.slice(1).forEach(function (q, k) { side.appendChild(questionRow(q, k + 1, false)); });
      box.appendChild(side);
    }
  }

  function setInputs(cell) {
    var c = S.cells[cell];
    $('img-f0').src = c.f0;
    var box = $('img-others');
    box.innerHTML = '';
    box.classList.toggle('many', c.photos.length > 6);     // dense orbit sets have up to 18 photos: two rows
    c.photos.forEach(function (p, i) {
      var im = document.createElement('img');
      im.src = p;
      im.alt = 'Other photo ' + (i + 1);
      im.setAttribute('data-zoom', '');
      im.tabIndex = 0;
      box.appendChild(im);
    });
  }

  function lockQuestions(locked) {
    document.querySelectorAll('.q').forEach(function (row) {
      row.classList.toggle('locked', locked);
      row.querySelectorAll('button').forEach(function (b) { b.disabled = locked; });
    });
  }

  function updateNext() {
    var all = S.questions.every(function (q) { return cur.rec.ans[q.id]; });
    $('btn-next').disabled = !(cur.unlocked && all);
    $('next-hint').textContent = !cur.unlocked ? 'Watch both videos to the end to unlock the questions.'
      : all ? '' : 'Answer all the questions to continue.';
  }

  function answer(qid, side) {
    if (!cur || !cur.unlocked) return;
    cur.rec.ans[qid] = side;
    cur.rec.t_ans[qid] = now() - cur.t0;
    cur.rec.n_changes += 1;
    ['L', 'R'].forEach(function (s) { $('ans-' + qid + '-' + s).setAttribute('aria-pressed', String(s === side)); });
    save();
    updateNext();
    if (AUTOTEST) autoNext();
  }

  function setStatus() {
    if (!cur) return;
    var vL = $('vid-L');
    var d = isFinite(vL.duration) ? vL.duration : 0;
    var t = Math.min(vL.currentTime || 0, d);
    $('play-status').textContent = d ? (cur.unlocked ? 'Playing again (' : 'Playing (') + Math.floor(t) + ' s of ' + Math.round(d) + ' s)' : '';
  }

  function startBoth() {
    var vL = $('vid-L'), vR = $('vid-R');
    cur.endedL = cur.endedR = false;
    vL.currentTime = 0; vR.currentTime = 0;
    vL.playbackRate = RATE; vR.playbackRate = RATE;
    var p = [vL.play(), vR.play()];
    Promise.all(p.map(function (x) { return x && x.catch ? x : Promise.resolve(); })).catch(function () {
      $('play-status').textContent = 'Click "Play both from the start" to begin.';
    });
    $('btn-pause').textContent = 'Pause';
  }

  function onEnded(side) {
    if (!cur) return;
    if (side === 'L') cur.endedL = true; else cur.endedR = true;
    if (cur.endedL && cur.endedR) {
      cur.rec.loops += 1;
      if (!cur.unlocked) {
        cur.unlocked = true;
        cur.rec.t_unlock = now() - cur.t0;
        lockQuestions(false);
        updateNext();
        if (AUTOTEST) autoAnswer();
      }
      var token = cur.token;
      setTimeout(function () { if (cur && cur.token === token && !cur.paused) startBoth(); }, 800);
    }
  }

  // keep the right video on the left one's clock: small gaps are closed by nudging its speed (no stall), a big gap
  // (after a stall or a tab switch) by a seek
  function syncR() {
    var vL = $('vid-L'), vR = $('vid-R');
    if (!cur || vL.paused || vR.paused || vR.ended || vL.ended) { vR.playbackRate = RATE; return; }
    var d = vL.currentTime - vR.currentTime;
    if (Math.abs(d) > 0.5 * RATE) { vR.currentTime = vL.currentTime; vR.playbackRate = RATE; }
    else if (Math.abs(d) > 0.03) { vR.playbackRate = RATE * (1 + Math.max(-0.3, Math.min(0.3, 3 * d / RATE))); }
    else if (vR.playbackRate !== RATE) { vR.playbackRate = RATE; }
  }
  setInterval(syncR, 50);

  function runTrial(i) {
    var t = form.trials[i];
    var token = {};
    cur = {
      token: token, t0: now(), unlocked: NO_WAIT, paused: false, endedL: false, endedR: false,
      rec: {
        uid: t.uid, i: i, cell: t.cell, L: t.L, R: t.R, ans: {}, t_ans: {}, n_changes: 0, loops: 0,
        restarts: 0, pauses: 0, t_ready: null, t_unlock: null, t_next: null, err: null,
        vw: window.innerWidth, vh: window.innerHeight
      }
    };
    var n = form.trials.length;
    $('trial-label').textContent = 'Trial ' + (i + 1) + ' of ' + n;
    $('practice-tag').hidden = !t.practice;
    $('progress-fill').style.width = (100 * i / n) + '%';
    $('btn-next').textContent = i === n - 1 ? 'Finish' : 'Next trial';
    setInputs(t.cell);
    buildQuestions();
    lockQuestions(!NO_WAIT);
    updateNext();
    $('play-status').textContent = '';
    var vL = $('vid-L'), vR = $('vid-R');
    vL.removeAttribute('src'); vR.removeAttribute('src'); vL.load(); vR.load();
    $('msg-L').textContent = $('msg-R').textContent = 'Loading video...';
    show('screen-trial');

    Promise.all([prefetch(t.L), prefetch(t.R)]).then(function (urls) {
      if (!cur || cur.token !== token) return;
      var ready = 0, seen = [false, false];
      function onReadyFor(k) {
        return function () {
          if (seen[k]) return;
          seen[k] = true;
          onReady();
        };
      }
      function onReady() {
        ready += 1;
        if (ready === 2 && cur && cur.token === token) {
          $('msg-L').textContent = $('msg-R').textContent = '';
          cur.rec.t_ready = now() - cur.t0;
          startBoth();
          prefetchTrial(i + 1);
        }
      }
      [vL, vR].forEach(function (v, k) {
        // the clip is already in memory (blob), so 'canplay' and 'canplaythrough' come together; take the first
        v.addEventListener('canplay', onReadyFor(k), { once: true });
        v.addEventListener('canplaythrough', onReadyFor(k), { once: true });
        v.onerror = function () {
          if (!cur || cur.token !== token) return;
          cur.rec.err = 'video ' + (k ? 'R' : 'L') + ' failed to load';
          $(k ? 'msg-R' : 'msg-L').textContent = 'This video did not load. Reload the page to try again.';
          if (AUTOTEST) { setTimeout(function () { onEnded('L'); onEnded('R'); }, 300); }
        };
        v.src = urls[k];
        v.load();
      });
    });
  }

  function nextTrial() {
    if (!cur || $('btn-next').disabled) return;
    cur.rec.t_next = now() - cur.t0;
    st.trials.push(cur.rec);
    st.idx += 1;
    cur = null;
    $('vid-L').pause(); $('vid-R').pause();
    save();
    releaseUnused(st.idx);
    if (st.idx >= form.trials.length) { finish(); return; }
    if (st.idx % SEND_EVERY === 0) send('progress');
    runTrial(st.idx);
  }

  // ---------- self-test (autotest=1) ----------
  var autoRng = null;
  function autoAnswer() {
    setTimeout(function () {
      if (!cur) return;
      S.questions.forEach(function (q) { answer(q.id, autoRng() < 0.5 ? 'L' : 'R'); });
    }, 150);
  }
  function autoNext() {
    var all = S.questions.every(function (q) { return cur && cur.rec.ans[q.id]; });
    if (all) setTimeout(function () { nextTrial(); }, 150);
  }

  // ---------- finish ----------
  function finish() {
    st.finished = new Date().toISOString();
    save();
    $('done-code').textContent = st.session;
    $('done-contact').textContent = CFG.contact;
    show('screen-done');
    send('final').then(function (r) {
      st.final_status = r;
      save();
      var msg = {
        ok: 'Your answers were received. You can close this page.',
        sent: 'Your answers were sent. You can close this page.',
        fail: 'We could not send your answers. Please download them below and send the file.',
        none: 'This page has no answer server set up. Please download your answers below and send the file.'
      }[r];
      $('done-status').textContent = msg;
      if (AUTOTEST) document.title = 'AUTOTEST DONE ' + r;
    });
  }
  function answersText() { return JSON.stringify(payload('download'), null, 1); }

  // ---------- start ----------
  function begin() {
    show('screen-howto');
  }

  function wire() {
    $('consent').addEventListener('change', function () { $('btn-intro').disabled = !this.checked; });
    $('btn-intro').addEventListener('click', function () {
      st.meta.experience = $('experience').value;
      st.meta.consent = new Date().toISOString();
      save();
      begin();
    });
    $('btn-howto').addEventListener('click', function () { st.idx = 0; save(); runTrial(0); });
    $('btn-restart').addEventListener('click', function () {
      if (!cur) return;
      cur.rec.restarts += 1; cur.paused = false; startBoth();
    });
    $('btn-pause').addEventListener('click', function () {
      if (!cur) return;
      var vL = $('vid-L'), vR = $('vid-R');
      if (cur.paused) { cur.paused = false; vL.play(); vR.play(); this.textContent = 'Pause'; }
      else { cur.paused = true; cur.rec.pauses += 1; vL.pause(); vR.pause(); this.textContent = 'Resume'; }
    });
    $('btn-next').addEventListener('click', nextTrial);
    $('vid-L').addEventListener('ended', function () { onEnded('L'); });
    $('vid-R').addEventListener('ended', function () { onEnded('R'); });
    $('vid-L').addEventListener('timeupdate', setStatus);
    ['vid-L', 'vid-R'].forEach(function (id) {
      $(id).addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-zoom')) { $('zoom-img').src = t.src; $('zoom').hidden = false; }
      else if (!$('zoom').hidden && $('zoom').contains(t)) { $('zoom').hidden = true; }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') $('zoom').hidden = true;
      if (e.key === 'Enter' && e.target && e.target.hasAttribute && e.target.hasAttribute('data-zoom')) {
        $('zoom-img').src = e.target.src; $('zoom').hidden = false;
      }
    });
    $('btn-download').addEventListener('click', function () {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([answersText()], { type: 'application/json' }));
      a.download = 'answers_' + st.session + '.json';
      document.body.appendChild(a); a.click(); a.remove();
    });
    $('btn-copy').addEventListener('click', function () {
      var done = function (ok) { $('copy-status').textContent = ok ? 'Copied.' : 'Copy failed; use Download.'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(answersText()).then(function () { done(true); }, function () { done(false); });
      else done(false);
    });
    window.addEventListener('pagehide', function () { if (st && st.idx > 0 && !st.finished) beacon(); });
    var small = function () { $('small-screen').hidden = window.innerWidth >= 1000; };
    window.addEventListener('resize', small); small();
  }

  function init() {
    if (Q.get('reset') === '1') clearSaved();
    fetch(CFG.data, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      S = data;
      var saved = load();
      var resume = saved && saved.study_id === S.study_id && saved.session && !(Q.has('f') && String(saved.form_param) !== Q.get('f'));
      var ready = resume ? Promise.resolve(saved) : pickForm().then(function (pf) {
        return {
          study_id: S.study_id, session: randomId(10), form: pf.form, form_how: pf.how, form_param: Q.get('f'),
          started: new Date().toISOString(), idx: -1, trials: [],
          meta: { vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio || 1, autotest: AUTOTEST, rate: RATE }
        };
      });
      return ready.then(function (s) {
        st = s;
        form = S.forms[st.form];
        save();
        autoRng = mulberry(parseInt(st.session.replace(/[^a-z0-9]/g, '').slice(0, 6), 36) || 1);
        var nTrials = form.trials.length;
        $('intro-count').textContent = String(nTrials);
        var secs = form.trials.reduce(function (a, t) { return a + (S.durations[t.L] || 15) + 9; }, 120);
        $('intro-minutes').textContent = String(Math.round(secs / 60));
        var ol = $('howto-questions');
        S.questions.forEach(function (q) { var li = document.createElement('li'); li.textContent = q.text; ol.appendChild(li); });
        wire();
        if (st.finished) {
          $('done-code').textContent = st.session;
          $('done-contact').textContent = CFG.contact;
          $('done-status').textContent = 'You have already finished this study in this browser. Thank you.';
          show('screen-done');
        } else if (st.idx >= 0 && st.idx < nTrials) {
          runTrial(st.idx);   // resume where this browser left off; the interrupted trial starts over
        } else {
          show('screen-intro');
          prefetchTrial(0);
          if (AUTOTEST) {
            $('consent').checked = true; $('btn-intro').disabled = false;
            setTimeout(function () { $('btn-intro').click(); setTimeout(function () { $('btn-howto').click(); }, 200); }, 300);
          }
        }
      });
    }).catch(function (e) { fail('The study data could not be loaded (' + e.message + ').'); });
  }

  init();
})();
