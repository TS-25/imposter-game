// server.js — Imposter game backend (Express + Socket.IO, in-memory state).
// Run: npm install socket.io express && node server.js
const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.get('/', (_, r) => r.sendFile(__dirname + '/index.html'));

// ---- Data & helpers --------------------------------------------------------
const PACKS = { // [real word, decoy word]
  Food: [['pizza', 'pasta'], ['coffee', 'tea'], ['burger', 'sandwich'], ['sushi', 'sashimi'], ['apple', 'pear']],
  Animals: [['lion', 'tiger'], ['dolphin', 'shark'], ['eagle', 'hawk'], ['frog', 'toad'], ['horse', 'donkey']],
  Places: [['beach', 'lake'], ['school', 'library'], ['hospital', 'clinic'], ['airport', 'train station'], ['castle', 'palace']],
  Things: [['guitar', 'violin'], ['sofa', 'armchair'], ['backpack', 'suitcase'], ['umbrella', 'raincoat'], ['bicycle', 'scooter']],
};
const BAD = /fuck|shit|bitch|asshole/gi;                 // tiny profanity filter
const clean = s => String(s || '').replace(BAD, '***');
const rooms = {}, rnd = n => Math.floor(Math.random() * n);
const uid = () => Math.random().toString(36).slice(2, 10);
const shuffle = a => { for (let i = a.length; i > 1;) { const j = rnd(i--); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const newCode = () => { let c; do c = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[rnd(32)]).join(''); while (rooms[c]); return c; };
const live = r => Object.values(r.players).filter(p => p.on);
const sys = (r, text) => io.to(r.code).emit('chat', { sys: 1, text });

// ---- Per-player view: each client only ever receives its OWN word ----------
function view(r, p) {
  const g = r.g || {}, H = r.host === p.id;
  const v = {
    code: r.code, phase: r.phase, host: r.host, me: p.id, cats: Object.keys(PACKS),
    set: { ...r.set, customText: H ? r.set.customText : '' },
    players: Object.values(r.players).map(q => ({ id: q.id, name: q.name, color: q.color, ready: q.ready, on: q.on, score: q.score })),
    clues: g.clues || [], round: g.round, turn: g.order && g.order[g.i], left: r.end ? r.end - Date.now() : 0,
  };
  if (r.phase !== 'lobby' && g.imp) {
    v.imp = g.imp.includes(p.id);
    v.word = v.imp ? (r.set.mode === 'blind' ? null : g.decoy) : g.word;
    v.sab = v.imp && !p.sab; v.myVote = g.votes[p.id];
  }
  if (r.phase === 'reveal') v.result = g.result;
  return v;
}
const push = r => live(r).forEach(p => io.to(p.sid).emit('state', view(r, p)));
const timer = (r, sec, fn) => { clearTimeout(r.t); r.end = sec ? Date.now() + sec * 1000 : 0; if (sec) r.t = setTimeout(fn, sec * 1000); };

// ---- Game state machine: lobby → clue → talk → vote → reveal → lobby ------
function start(r) {
  const ps = live(r), list = r.custom.length ? r.custom : PACKS[r.set.category];
  const [word, decoy] = list[rnd(list.length)];
  const k = Math.min(r.set.imposters, Math.max(1, Math.floor((ps.length - 1) / 2)));
  r.g = { word, decoy, imp: shuffle(ps.map(p => p.id)).slice(0, k), order: shuffle(ps.map(p => p.id)), i: -1, round: 1, clues: [], votes: {} };
  Object.values(r.players).forEach(p => p.sab = 0);
  r.phase = 'clue'; timer(r, 0); sys(r, 'Game started — give one-word clues in turn.'); adv(r);
}
function adv(r) { // move to the next connected player's turn / next round / discussion
  const g = r.g;
  do g.i++; while (g.i < g.order.length && !r.players[g.order[g.i]]?.on);
  if (g.i >= g.order.length) {
    if (g.round < r.set.rounds) { g.round++; g.i = -1; return adv(r); }
    return talk(r);
  }
  push(r);
}
function talk(r) { r.phase = 'talk'; timer(r, r.set.timer, () => voting(r)); sys(r, 'Discussion time!'); push(r); }
function voting(r) { r.phase = 'vote'; timer(r, 45, () => reveal(r)); sys(r, 'Vote for the imposter!'); push(r); }
function reveal(r) {
  if (r.phase !== 'vote') return;
  const g = r.g, tally = {};
  Object.values(g.votes).forEach(t => tally[t] = (tally[t] || 0) + 1);
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const caught = !!top.length && (top.length < 2 || top[0][1] > top[1][1]) && g.imp.includes(top[0][0]);
  for (const [v, t] of Object.entries(g.votes)) if (g.imp.includes(t) && r.players[v]) r.players[v].score++;   // correct vote +1
  if (!caught) g.imp.forEach(i => r.players[i] && (r.players[i].score += 2));                                // imposter survives +2
  g.result = {
    word: g.word, decoy: g.decoy, caught, imp: g.imp.map(i => r.players[i]?.name || '?'),
    tally: Object.fromEntries(top.map(([k, n]) => [r.players[k]?.name || '?', n])),
  };
  r.phase = 'reveal'; timer(r, 0); sys(r, caught ? 'The imposter was caught!' : 'The imposters got away!'); push(r);
}
function gone(r, p, del) { // player disconnected / left / kicked
  p.on = false; r.voice?.delete(p.id); io.to(r.code).emit('voice-leave', p.id);
  if (del) delete r.players[p.id];
  const L = live(r);
  if (!L.length) { r.gc = setTimeout(() => delete rooms[r.code], 5 * 60 * 1000); return; }   // cleanup after 5 min
  if (r.host === p.id) { r.host = L[0].id; sys(r, L[0].name + ' is now host.'); }
  const g = r.g;
  if (r.phase === 'clue' && g.order[g.i] === p.id) adv(r);
  else if (r.phase === 'vote' && L.every(q => g.votes[q.id])) reveal(r);
  else push(r);
}

// ---- Sockets ---------------------------------------------------------------
io.on('connection', s => {
  const R = () => rooms[s.data.c], P = () => R()?.players[s.data.t], err = m => s.emit('err', m);
  const bind = (r, p) => { p.sid = s.id; p.on = true; s.data = { c: r.code, t: p.id }; s.join(r.code); clearTimeout(r.gc); s.emit('joined', { code: r.code, token: p.id }); };
  const mk = (name, color) => ({ id: uid(), name: clean(String(name || 'Player').trim().slice(0, 14)) || 'Player', color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#ff4fd8', ready: false, on: true, score: 0, sab: 0 });

  s.on('create', ({ name, color, pass } = {}) => {
    const r = rooms[newCode()] = { code: null, pass: String(pass || '').slice(0, 20), players: {}, phase: 'lobby', custom: [], voice: new Set(),
      set: { imposters: 1, timer: 120, rounds: 2, category: 'Food', mode: 'classic', voice: true, customText: '' } };
    r.code = Object.keys(rooms).find(k => rooms[k] === r);
    const p = mk(name, color); r.players[p.id] = p; r.host = p.id; bind(r, p); push(r);
  });
  s.on('join', ({ code, name, color, pass } = {}) => {
    const r = rooms[String(code || '').toUpperCase()];
    if (!r) return err('Room not found.');
    if (r.pass && r.pass !== pass) return err('Wrong password.');
    if (r.phase !== 'lobby') return err('Game already in progress.');
    if (Object.keys(r.players).length >= 12) return err('Room is full (12 max).');
    const p = mk(name, color); r.players[p.id] = p; bind(r, p); sys(r, p.name + ' joined.'); push(r);
  });
  s.on('resume', ({ code, token } = {}) => {            // reconnect after refresh
    const r = rooms[code], p = r?.players[token];
    if (!p) return s.emit('noresume');
    bind(r, p); push(r);
  });
  s.on('leave', () => { const r = R(), p = P(); if (!p) return; s.leave(r.code); s.data = {}; gone(r, p, true); });
  s.on('disconnect', () => { const r = R(), p = P(); if (p && p.sid === s.id) gone(r, p, false); });

  s.on('ready', () => { const r = R(), p = P(); if (p && r.phase === 'lobby') { p.ready = !p.ready; push(r); } });
  s.on('set', d => {
    const r = R(), p = P(); if (!p || r.host !== p.id || r.phase !== 'lobby') return;
    const c = (v, a, b) => Math.min(b, Math.max(a, +v || a));
    Object.assign(r.set, { imposters: c(d.imposters, 1, 3), timer: c(d.timer, 60, 300), rounds: c(d.rounds, 1, 3),
      category: PACKS[d.category] ? d.category : 'Food', mode: d.mode === 'blind' ? 'blind' : 'classic', voice: !!d.voice,
      customText: String(d.customText || '').slice(0, 2000) });
    r.custom = r.set.customText.split('\n').map(l => l.split(',').map(x => clean(x.trim()).slice(0, 30))).filter(a => a[0] && a[1]);
    push(r);
  });
  s.on('start', () => {
    const r = R(), p = P(); if (!p || r.host !== p.id || r.phase !== 'lobby') return;
    if (live(r).length < 3) return err('Need at least 3 players.');
    start(r);
  });
  s.on('again', () => { const r = R(), p = P(); if (!p || r.host !== p.id || r.phase !== 'reveal') return; r.phase = 'lobby'; r.g = null; Object.values(r.players).forEach(q => q.ready = false); push(r); });
  s.on('skip', () => {
    const r = R(), p = P(); if (!p || r.host !== p.id) return;
    if (r.phase === 'clue') talk(r); else if (r.phase === 'talk') voting(r); else if (r.phase === 'vote') reveal(r);
  });
  s.on('kick', id => {
    const r = R(), p = P(), t = r?.players[id]; if (!p || r.host !== p.id || !t || t === p) return;
    io.to(t.sid).emit('kicked'); io.sockets.sockets.get(t.sid)?.leave(r.code); sys(r, t.name + ' was kicked.'); gone(r, t, true);
  });

  s.on('clue', text => {
    const r = R(), p = P(); if (!p || r.phase !== 'clue' || r.g.order[r.g.i] !== p.id) return;
    const t = clean(String(text || '').trim().split(/\s+/)[0]).slice(0, 20); if (!t) return;
    r.g.clues.push({ name: p.name, color: p.color, text: t, round: r.g.round }); adv(r);
  });
  s.on('sab', () => { // imposter trick: once per game, skip the current player's turn
    const r = R(), p = P(); if (!p || r.phase !== 'clue' || !r.g.imp.includes(p.id) || p.sab) return;
    p.sab = 1; sys(r, '⏱ Sabotage! A turn was skipped.'); adv(r);
  });
  s.on('vote', id => {
    const r = R(), p = P(); if (!p || r.phase !== 'vote' || id === p.id || !r.players[id]) return;
    r.g.votes[p.id] = id;
    if (live(r).every(q => r.g.votes[q.id])) reveal(r); else push(r);
  });
  s.on('chat', ({ text, anon } = {}) => {   // anon = anonymous accusation / hint
    const p = P(), r = R(); const t = clean(String(text || '').trim().slice(0, 200)); if (!p || !t) return;
    io.to(r.code).emit('chat', { name: anon ? 'Anonymous' : p.name, color: anon ? '#888888' : p.color, text: t });
  });

  // ---- WebRTC signaling (mesh): relay by player id ----
  const relay = type => s.on('voice-' + type, ({ to, data } = {}) => { const r = R(), p = P(), t = r?.players[to]; if (t?.on) io.to(t.sid).emit('voice-' + type, { from: p.id, data }); });
  ['offer', 'answer', 'ice'].forEach(relay);
  s.on('voice-join', () => { const r = R(), p = P(); if (!p) return; s.emit('voice-peers', [...r.voice].filter(i => i !== p.id)); r.voice.add(p.id); });
  s.on('voice-leave', () => { const r = R(), p = P(); if (!p) return; r.voice.delete(p.id); s.to(r.code).emit('voice-leave', p.id); });
});

srv.listen(process.env.PORT || 3000, () => console.log('Imposter running on port', process.env.PORT || 3000));
