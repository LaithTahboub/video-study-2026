/* Pairwise video study: two-alternative forced choice, side by side; a main question (which video to tour with) and side questions per trial.
   No build step. Reads config.js (window.STUDY_CONFIG) and data/study.json (forms, clips, inputs).
   URL options: f=<form> pins a form; reset=1 clears this browser's saved session;
   test only: autotest=1 answers by itself, rate=<x> plays faster, ext=webm loads the VP9 test copies.
   config.js min_width (px, 0 = off): a narrower window gets a page asking for a laptop or desktop instead of the study;
   nothing starts (no form is taken from the counter) until the window is wide enough, and a window that narrows later
   is covered again and both videos pause.
   2026-11-07 (tour-v5), study.json options:
     fixed_form       every rater gets this form (no counter, f= ignored);
     drop_uids        trials of that form that are not shown;
     order            {shuffle, keep_first, repeat_min_gap}: the other trials are shuffled once per rater (the first
                      keep_first stay first; a trial and its repeat, the same two clips with the sides swapped, keep
                      more than repeat_min_gap trials between them); the order is saved, so a reload resumes it, and
                      sent with the answers (order, and each trial's position i);
     near             per trial uid, [[t seconds, j], ...]: the closest-photo panel shows input j (0 = the starting
                      photo, j = photos[j - 1]) from time t of the clips (pipeline/nearest.py, from cameras only).
     order.pairs      [[uid, its repeat uid]]: kept more than repeat_min_gap apart like same-clip pairs;
     order.spread     [{uids, min_between}]: more than min_between trials between any two of these (the attention
                      checks); a saved order that breaks a rule is drawn again;
     scene_names      per trial uid, shown only in preview mode.
   Clicking a photo pauses both videos; closing it resumes them unless they were already paused.
   preview=1 (for the author's own testing): answers and Next unlock at once (no need to watch the videos to the end)
   and the scene name, path and trial id are shown above the photos; such a session is marked meta.preview and left
   out of the analysis. */
(function () {
  'use strict';

  var CFG = Object.assign({ endpoint: '', contact: 'the person who sent you this link', data: 'data/study.json' },
    window.STUDY_CONFIG || {});
  var Q = new URLSearchParams(location.search);
  var AUTOTEST = Q.get('autotest') === '1';
  var RATE = parseFloat(Q.get('rate') || '1') || 1;
  // preview only (config.js no_wait: true): answers and Next unlock at once, without watching both videos to the end
  var PREVIEW = Q.get('preview') === '1';
  var NO_WAIT = CFG.no_wait === true || PREVIEW;
  var MIN_WIDTH = Math.max(0, parseInt(CFG.min_width, 10) || 0);   // 2026-11-05: small-screen gate, 0 = off
  var EXT = Q.get('ext');
  var LS_KEY = 'vts_state_v1';
  var SEND_EVERY = 1;   // 2026-11-05: after every trial, so a rater who stops early loses nothing
  var PAGE = '2026-11-08 one form, shuffled order, closest photo, pause on zoom, guided tour, Same option';

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
      type: type, study_id: S.study_id, session: st.session, form: st.form, form_how: st.form_how, page: PAGE,
      order: st.order || null,
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
    if (typeof S.fixed_form === 'number') return Promise.resolve({ form: S.fixed_form, how: 'fixed' });
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

  // ---------- one form, shuffled per rater (tour-v5) ----------
  function randInt(n) {
    var a = new Uint32Array(1);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return a[0] % n;
  }
  // the ordering rules as [uid a, uid b, more than this many trials between them]
  function orderRules(trials) {
    var o = S.order || {}, rules = [], uids = trials.map(function (t) { return t.uid; });
    trials.forEach(function (a) {
      trials.forEach(function (b) {
        if (a.uid < b.uid && a.L === b.R && a.R === b.L) rules.push([a.uid, b.uid, o.repeat_min_gap || 0]);
      });
    });
    (o.pairs || []).forEach(function (pr) {         // a trial and its repeat named in study.json (a cut repeat has new clips)
      if (uids.indexOf(pr[0]) >= 0 && uids.indexOf(pr[1]) >= 0) rules.push([pr[0], pr[1], o.repeat_min_gap || 0]);
    });
    (o.spread || []).forEach(function (g) {
      var u = g.uids.filter(function (x) { return uids.indexOf(x) >= 0; });
      for (var i = 0; i < u.length; i++) for (var j = i + 1; j < u.length; j++) rules.push([u[i], u[j], g.min_between || 0]);
    });
    return rules;
  }
  function obeys(order, rules) {
    var pos = {};
    order.forEach(function (u, i) { pos[u] = i; });
    return rules.every(function (r) { return Math.abs(pos[r[0]] - pos[r[1]]) > r[2]; });
  }
  function shuffledUids(trials) {
    var k = (S.order || {}).keep_first || 0, rules = orderRules(trials);
    var head = trials.slice(0, k).map(function (t) { return t.uid; });
    var rest = trials.slice(k).map(function (t) { return t.uid; });
    for (var tries = 0; tries < 5000; tries++) {
      var r = rest.slice();
      for (var i = r.length - 1; i > 0; i--) { var j = randInt(i + 1), x = r[i]; r[i] = r[j]; r[j] = x; }
      if (obeys(head.concat(r), rules)) return head.concat(r);
    }
    return trials.map(function (t) { return t.uid; });
  }
  // the trials this rater sees, in the order they see them (st.order, saved with the session)
  function arrange(f) {
    var drop = S.drop_uids || [], byUid = {};
    var kept = f.trials.filter(function (t) { return drop.indexOf(t.uid) < 0; });
    kept.forEach(function (t) { byUid[t.uid] = t; });
    var valid = st.order && st.order.length === kept.length && st.order.every(function (u) { return byUid[u]; }) &&
      (!(S.order && S.order.shuffle) || obeys(st.order, orderRules(kept)));
    if (!valid) st.order = (S.order && S.order.shuffle) ? shuffledUids(kept) : kept.map(function (t) { return t.uid; });
    return { form: f.form, trials: st.order.map(function (u) { return byUid[u]; }) };
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
    ['L', 'T', 'R'].forEach(function (side) {   // 2026-11-08: a Same option between Left and Right (answer 'T')
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'ans-' + q.id + '-' + side;
      b.textContent = side === 'L' ? 'Left' : side === 'T' ? 'Same' : 'Right';
      if (side === 'T') b.className = 'same';
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', (side === 'L' ? 'Left' : side === 'T' ? 'About the same' : 'Right') + ': ' + q.text);
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

  // closest-photo panel: follows the left video's clock (the right one is kept on it by syncR)
  var near = null;   // {seg, cell, shown}
  function setNear(t) {
    var seg = (S.near && S.near[t.uid]) || null;
    near = seg ? { seg: seg, cell: S.cells[t.cell], shown: -1 } : null;
    $('near-fig').hidden = !near;
    $('img-f0').classList.remove('is-near');
    updateNear();
  }
  function updateNear() {
    if (!near || !cur) return;
    var tt = $('vid-L').currentTime || 0, j = near.seg[0][1];
    for (var k = 0; k < near.seg.length && near.seg[k][0] <= tt + 1e-3; k++) j = near.seg[k][1];
    if (j === near.shown) return;
    near.shown = j;
    $('img-near').src = j === 0 ? near.cell.f0 : near.cell.photos[j - 1];
    $('near-label').textContent = j === 0 ? 'Starting photo' : 'Other photo ' + j;
    $('img-f0').classList.toggle('is-near', j === 0);
    var th = $('img-others').children;
    for (var m = 0; m < th.length; m++) th[m].classList.toggle('is-near', m === j - 1);
    cur.rec.near_changes += 1;
  }

  // ---------- guided tour on the practice trial (2026-11-08) ----------
  // Each step darkens the page around one part of the screen and explains it; the videos wait until the tour ends.
  var TOUR = [
    { el: '.videos', title: 'Two videos to compare',
      text: 'Both videos start at the starting photo and follow the same camera path. They play together and repeat by themselves. The questions unlock after one full play.' },
    { el: 'figure.f0', title: 'Starting photo', important: true,
      text: 'This is the appearance reference. A good video keeps its lighting, colors, weather, and time of day from start to finish.' },
    { el: '#near-fig', title: 'Closest photo', important: true,
      text: 'While the videos play, this shows the photo taken nearest to what the videos show at that moment. Use it to check the buildings, their shapes, and their details.' },
    { el: '.inputs .others', title: 'All photos of the place',
      text: 'Taken at other times, so their lighting can differ. The closest photo is outlined in yellow. Click any photo to enlarge it; the videos pause while it is open.' },
    { el: '.controls', title: 'Playback',
      text: 'Start both videos over or pause them here. Feel free to watch them as many times as you like.' },
    { el: '#questions', title: 'The questions',
      text: 'Pick Left or Right for each question, or Same if you really cannot tell them apart.' },
    { el: '.nextrow', title: 'Next trial',
      text: 'Then continue. This practice trial does not count. Press Start to play the videos.' }
  ];
  var tour = null;   // {k, t0}
  function startTour() {
    tour = { k: 0, t0: now() };
    cur.paused = true;
    cur.inTour = true;
    $('vid-L').pause(); $('vid-R').pause();
    ['tour-block', 'tour-spot', 'tour-pop'].forEach(function (id) { $(id).hidden = false; });
    $('tour-skip').hidden = !PREVIEW;
    showStep(0);
  }
  function showStep(k) {
    tour.k = k;
    var s = TOUR[k], el = document.querySelector(s.el);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    $('tour-title').innerHTML = (s.important ? '<span class="important">Important:</span> ' : '') + s.title;
    $('tour-text').textContent = s.text;
    $('tour-step').textContent = (k + 1) + ' of ' + TOUR.length;
    $('tour-back').disabled = k === 0;
    $('tour-next').textContent = k === TOUR.length - 1 ? 'Start' : 'Next';
    placeTour();
    $('tour-next').focus();
  }
  function placeTour() {
    if (!tour) return;
    var el = document.querySelector(TOUR[tour.k].el);
    if (!el) return;
    var r = el.getBoundingClientRect(), pad = 6, vw = window.innerWidth, vh = window.innerHeight;
    var sp = $('tour-spot');
    sp.style.left = (r.left - pad) + 'px'; sp.style.top = (r.top - pad) + 'px';
    sp.style.width = (r.width + 2 * pad) + 'px'; sp.style.height = (r.height + 2 * pad) + 'px';
    var pop = $('tour-pop'), pw = pop.offsetWidth, ph = pop.offsetHeight;
    var below = r.bottom + pad + 14 + ph <= vh || r.top - pad - 14 - ph < 0;
    var top = below ? r.bottom + pad + 14 : r.top - pad - 14 - ph;
    top = Math.max(8, Math.min(top, vh - ph - 8));
    var cx = r.left + r.width / 2, left = Math.max(16, Math.min(cx - pw / 2, vw - pw - 16));
    pop.style.top = top + 'px'; pop.style.left = left + 'px';
    pop.classList.toggle('below', below); pop.classList.toggle('above', !below);
    $('tour-arrow').style.left = Math.max(14, Math.min(cx - left - 7, pw - 28)) + 'px';
  }
  function endTour() {
    if (!tour) return;
    if (cur) {
      cur.rec.tour_ms = now() - tour.t0;
      cur.rec.tour_steps = tour.k + 1;
      cur.inTour = false;
      cur.paused = false;
      var v = $('vid-L');
      if (v.readyState >= 2) startBoth();          // otherwise the videos start when they are ready
    }
    tour = null;
    ['tour-block', 'tour-spot', 'tour-pop'].forEach(function (id) { $(id).hidden = true; });
  }
  window.__vtsDebug = function () {    // test hook (read only): the running trial's player state
    return cur ? { paused: cur.paused, manual: !!cur.manual, inTour: !!cur.inTour, zoomPaused: !!cur.zoomPaused,
      endedL: cur.endedL, endedR: cur.endedR, unlocked: cur.unlocked, tour: !!tour } : null;
  };
  window.addEventListener('resize', placeTour);
  window.addEventListener('scroll', placeTour, true);

  // enlarged photo: both videos pause while it is open and resume when it closes, unless they were paused already
  function openZoom(src) {
    $('zoom-img').src = src;
    $('zoom').hidden = false;
    if (!cur) return;
    cur.rec.zooms += 1;
    if (!cur.inTour && !cur.manual) {                 // paused by the rater with Pause: stays paused after the photo
      cur.paused = true;
      cur.zoomPaused = true;
      $('vid-L').pause(); $('vid-R').pause();
      $('btn-pause').textContent = 'Resume';
    }
  }
  function closeZoom() {
    if ($('zoom').hidden) return;
    $('zoom').hidden = true;
    if (cur && cur.zoomPaused) {
      cur.zoomPaused = false;
      cur.paused = false;
      var vL = $('vid-L'), vR = $('vid-R');
      if (vL.ended || vR.ended || cur.endedL || cur.endedR) startBoth();   // opened between two plays
      else { vL.play(); vR.play(); }
      $('btn-pause').textContent = 'Pause';
    }
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
    ['L', 'T', 'R'].forEach(function (s) { $('ans-' + qid + '-' + s).setAttribute('aria-pressed', String(s === side)); });
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
  setInterval(function () { syncR(); updateNear(); }, 50);

  function runTrial(i) {
    var t = form.trials[i];
    var token = {};
    cur = {
      token: token, t0: now(), unlocked: NO_WAIT, paused: false, endedL: false, endedR: false,
      rec: {
        uid: t.uid, i: i, cell: t.cell, L: t.L, R: t.R, ans: {}, t_ans: {}, n_changes: 0, loops: 0,
        restarts: 0, pauses: 0, zooms: 0, near_changes: 0, t_ready: null, t_unlock: null, t_next: null, err: null,
        vw: window.innerWidth, vh: window.innerHeight
      }
    };
    var n = form.trials.length;
    $('trial-label').textContent = 'Trial ' + (i + 1) + ' of ' + n;
    $('practice-tag').hidden = !t.practice;
    $('scene-tag').hidden = !PREVIEW;
    if (PREVIEW) $('scene-tag').textContent = 'Preview: ' + ((S.scene_names || {})[t.uid] || t.cell + ', trial ' + t.uid);
    $('progress-fill').style.width = (100 * i / n) + '%';
    $('btn-next').textContent = i === n - 1 ? 'Finish' : 'Next trial';
    setInputs(t.cell);
    setNear(t);
    buildQuestions();
    lockQuestions(!NO_WAIT);
    updateNext();
    $('play-status').textContent = '';
    var vL = $('vid-L'), vR = $('vid-R');
    vL.removeAttribute('src'); vR.removeAttribute('src'); vL.load(); vR.load();
    $('msg-L').textContent = $('msg-R').textContent = 'Loading video...';
    show('screen-trial');
    if (t.practice && !AUTOTEST) setTimeout(function () { if (cur && cur.token === token) startTour(); }, 60);

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
          if (cur.paused) { vL.pause(); vR.pause(); $('btn-pause').textContent = 'Resume'; }   // a photo is open
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
      cur.rec.restarts += 1; cur.paused = false; cur.manual = false; startBoth();
    });
    $('btn-pause').addEventListener('click', function () {
      if (!cur) return;
      var vL = $('vid-L'), vR = $('vid-R');
      if (cur.paused) { cur.paused = false; cur.manual = false; vL.play(); vR.play(); this.textContent = 'Pause'; }
      else { cur.paused = true; cur.manual = true; cur.rec.pauses += 1; vL.pause(); vR.pause(); this.textContent = 'Resume'; }
    });
    $('btn-next').addEventListener('click', nextTrial);
    $('tour-next').addEventListener('click', function () { if (tour) { if (tour.k < TOUR.length - 1) showStep(tour.k + 1); else endTour(); } });
    $('tour-back').addEventListener('click', function () { if (tour && tour.k > 0) showStep(tour.k - 1); });
    $('tour-skip').addEventListener('click', endTour);
    $('vid-L').addEventListener('ended', function () { onEnded('L'); });
    $('vid-R').addEventListener('ended', function () { onEnded('R'); });
    $('vid-L').addEventListener('timeupdate', setStatus);
    ['vid-L', 'vid-R'].forEach(function (id) {
      $(id).addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-zoom')) openZoom(t.src);
      else if (!$('zoom').hidden && $('zoom').contains(t)) closeZoom();
    });
    document.addEventListener('keydown', function (e) {
      if (tour && e.key === 'Enter') { e.preventDefault(); $('tour-next').click(); return; }
      if (e.key === 'Escape') closeZoom();
      if (e.key === 'Enter' && e.target && e.target.hasAttribute && e.target.hasAttribute('data-zoom')) openZoom(e.target.src);
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
        if (PREVIEW) st.meta.preview = true;     // sticky: a session that ever ran in preview mode is not a rater's
        form = arrange(S.forms[st.form]);
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

  // ---------- small-screen gate ----------
  var started = false;
  function tooNarrow() { return MIN_WIDTH > 0 && window.innerWidth < MIN_WIDTH; }
  function gate() {
    var on = tooNarrow();
    $('gate').hidden = !on;
    if (on && cur && !cur.paused) {          // narrowed during a trial: hold both videos until the rater resumes
      cur.paused = true;
      $('vid-L').pause(); $('vid-R').pause();
      $('btn-pause').textContent = 'Resume';
    }
    if (!on && !started) { started = true; init(); }
  }
  window.addEventListener('resize', gate);
  gate();
})();
