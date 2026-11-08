/**
 * PAPARAZZI — API de salas (GitHub Pages ⇄ Apps Script)
 * Salas en CacheService (hasta 8 jugadores). Hoja "Partidas" con el historial.
 * Peticiones: POST con JSON {accion, ...}
 */
const TZ = 'Europe/Madrid';
const MAX_JUG = 8;
const COLORES = ['#ff2d95', '#ffd60a', '#00e5ff', '#7cff4f', '#b388ff', '#ff8a3d', '#ff5252', '#40c4ff'];
const T_CUENTA = 5000;      // cuenta atrás antes de cada ronda
const T_ELEGIR = 12000;     // margen para elegir y enviar la foto
const T_SLOT = 7000;        // tiempo por foto en la pasarela de votos
const T_RES = 11000;        // pantalla de resultados de la ronda
const T_OFF = 25000;        // sin noticias en 25 s = desconectado

function doPost(e) {
  let d = {};
  try { d = JSON.parse(e.postData.contents || '{}'); } catch (err) {}
  return json_(rutear_(d));
}
function doGet(e) { return json_(rutear_((e && e.parameter) || {})); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function rutear_(d) {
  try {
    switch (d.accion) {
      case 'crear': return conLock_(() => crear_(d));
      case 'unir': return conLock_(() => unir_(d));
      case 'ver': return ver_(d);
      case 'acc': return conLock_(() => acc_(d));
      default: return { ok: true, juego: 'PAPARAZZI' };
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}
function conLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- utilidades ---------- */
const limpiaNombre_ = n => String(n || '').replace(/[<>"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
function get_(code) { const s = CacheService.getScriptCache().get('sala_' + String(code || '').toUpperCase()); return s ? JSON.parse(s) : null; }
function put_(st) { st.v = (st.v || 0) + 1; CacheService.getScriptCache().put('sala_' + st.code, JSON.stringify(st), 21600); }
function yo_(st, tok) { return st.jug.find(j => j.t && j.t === String(tok || '')) || null; }
function nuevoCodigo_() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let k = 0; k < 50; k++) {
    let c = ''; for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
    if (!get_(c)) return c;
  }
  throw new Error('No hay salas libres, inténtalo otra vez');
}
const activos_ = (st, now) => st.jug.filter(j => now - (j.on || 0) < T_OFF);
function pub_(st, me) {
  const now = Date.now();
  const o = JSON.parse(JSON.stringify(st));
  o.jug.forEach(j => { delete j.t; j.off = now - (j.on || 0) >= T_OFF; });
  o.now = now;
  if (me) o.yo = me.id;
  // durante la votación las fotos van sin autor (para no influir); se ve en resultados
  return o;
}

/* ---------- salas ---------- */
function crear_(d) {
  const n = limpiaNombre_(d.n) || 'Fotógrafo';
  const code = nuevoCodigo_(), tok = Utilities.getUuid();
  const st = {
    code, v: 0, fase: 'lobby', host: 1, sig: 2,
    jug: [{ id: 1, n, c: COLORES[0], t: tok, on: Date.now(), pts: 0 }],
    cfg: { rondas: 5, dur: 15, pj: 'jorge' }, nof: {}, ronda: 0, R: [], esc: [], fotos: {}, votos: {}, hist: [], creada: Date.now()
  };
  put_(st);
  return { ok: true, tok, st: pub_(st, st.jug[0]) };
}
function unir_(d) {
  const st = get_(d.code);
  if (!st) return { ok: false, error: 'No existe ninguna partida con ese código' };
  const now = Date.now();
  let me = yo_(st, d.tok);
  if (!me) {
    if (activos_(st, now).length >= MAX_JUG) return { ok: false, error: 'La partida está llena (máximo ' + MAX_JUG + ' fotógrafos)' };
    let n = limpiaNombre_(d.n) || 'Fotógrafo';
    const base = n; let i = 2;
    while (st.jug.some(j => j.n.toLowerCase() === n.toLowerCase() && now - (j.on || 0) < T_OFF)) n = base.slice(0, 12) + (i++);
    // reutiliza el hueco de un jugador desconectado del lobby
    if (st.fase === 'lobby') st.jug = st.jug.filter(j => now - (j.on || 0) < T_OFF);
    const usados = st.jug.map(j => j.c), c = COLORES.find(x => usados.indexOf(x) < 0) || COLORES[st.sig % COLORES.length];
    me = { id: st.sig++, n, c, t: Utilities.getUuid(), on: now, pts: 0 };
    st.jug.push(me);
  } else me.on = now;
  if (!st.jug.some(j => j.id === st.host && now - (j.on || 0) < T_OFF)) st.host = me.id;
  avanzar_(st, now);
  put_(st);
  return { ok: true, tok: me.t, st: pub_(st, me) };
}
function ver_(d) {
  let st = get_(d.code);
  if (!st) return { ok: false, error: 'La partida ya no existe' };
  const now = Date.now();
  const me = yo_(st, d.tok);
  // marcar presencia cada ~8 s y avanzar fases por tiempo (con candado solo cuando hace falta)
  const necesita = (me && now - (me.on || 0) > 8000) || debeAvanzar_(st, now) || (!st.jug.some(j => j.id === st.host && now - (j.on || 0) < T_OFF));
  if (necesita) {
    return conLock_(() => {
      st = get_(d.code); const me2 = yo_(st, d.tok);
      if (me2) me2.on = now;
      if (!st.jug.some(j => j.id === st.host && now - (j.on || 0) < T_OFF)) { const a = activos_(st, now)[0]; if (a) st.host = a.id; }
      avanzar_(st, now);
      put_(st);
      return { ok: true, st: pub_(st, me2) };
    });
  }
  return { ok: true, st: pub_(st, me) };
}

/* ---------- fases ---------- */
function debeAvanzar_(st, now) {
  const act = activos_(st, now).map(j => j.id);
  if (st.fase === 'captura') {
    const f = st.fotos[st.ronda] || {};
    const nf = (st.nof && st.nof[st.ronda]) || [];
    return now > st.tEnd + T_ELEGIR || (now > st.tEnd && act.every(id => f[id] || nf.indexOf(id) >= 0));
  }
  if (st.fase === 'voto') {
    const v = st.votos[st.ronda] || {};
    return now > st.vEnd || (now > st.vStart + 3000 && act.every(id => v[id]));
  }
  if (st.fase === 'resultado') return now > st.rEnd;
  return false;
}
function avanzar_(st, now) {
  for (let k = 0; k < 4 && debeAvanzar_(st, now); k++) {
    if (st.fase === 'captura') {
      const fotos = st.fotos[st.ronda] || {};
      const n = Object.keys(fotos).length;
      if (n >= 2) {
        st.fase = 'voto'; st.vStart = now + 2500;
        st.orden = barajar_(Object.keys(fotos).map(Number), st.R[st.ronda - 1].seed);
        st.vEnd = st.vStart + st.orden.length * T_SLOT + 1500;
      } else cerrarRonda_(st, now);
    } else if (st.fase === 'voto') cerrarRonda_(st, now);
    else if (st.fase === 'resultado') {
      if (st.ronda >= st.cfg.rondas) finalizar_(st);
      else empezarRonda_(st, now);
    }
  }
}
function barajar_(a, seed) {
  let s = seed >>> 0;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function empezarRonda_(st, now) {
  st.ronda++;
  const esc = st.esc.length ? st.esc[(st.ronda - 1) % st.esc.length] : 0;
  st.R.push({ seed: Math.floor(Math.random() * 2147483647), esc });
  st.fase = 'captura';
  st.t0 = now + T_CUENTA;
  st.tEnd = st.t0 + st.cfg.dur * 1000;
  st.fotos[st.ronda] = {}; st.votos[st.ronda] = {};
}
function cerrarRonda_(st, now) {
  const fotos = st.fotos[st.ronda] || {}, votos = st.votos[st.ronda] || {};
  const res = [];
  Object.keys(fotos).forEach(k => {
    const id = Number(k), f = fotos[k];
    let suma = 0, nv = 0; const reac = {};
    Object.keys(votos).forEach(vk => {
      if (Number(vk) === id) return;
      const v = votos[vk] || {}, e = v.e && v.e[k] ? Number(v.e[k]) : 0;
      if (e >= 1 && e <= 5) { suma += e; nv++; }
      const r = v.r && v.r[k]; if (r) reac[r] = (reac[r] || 0) + 1;
    });
    const est = nv ? suma / nv : 0;
    const pEst = Math.round(est * 20), pQ = Math.round(Math.max(0, Math.min(100, Number(f.q) || 0)) / 2), pEnc = f.enc ? 25 : 0;
    const pts = pEst + pQ + pEnc;
    const j = st.jug.find(x => x.id === id); if (j) j.pts = (j.pts || 0) + pts;
    res.push({ id, t: f.t, cam: f.cam, q: f.q, enc: !!f.enc, est: Math.round(est * 10) / 10, nv, pEst, pQ, pEnc, pts, reac });
  });
  res.sort((a, b) => b.pts - a.pts);
  st.hist[st.ronda - 1] = res;
  st.fase = 'resultado';
  st.rEnd = now + T_RES + Math.min(6, res.length) * 900;
}
function finalizar_(st) {
  st.fase = 'final';
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName('Partidas');
    if (!sh) { sh = ss.insertSheet('Partidas'); sh.appendRow(['fecha', 'código', 'jugadores', 'rondas', 'ganador', 'puntos', 'clasificación']); sh.setFrozenRows(1); }
    const cl = st.jug.slice().sort((a, b) => b.pts - a.pts);
    sh.appendRow([new Date(), st.code, cl.length, st.cfg.rondas, cl[0] ? cl[0].n : '', cl[0] ? cl[0].pts : 0, cl.map(j => j.n + ' ' + j.pts).join(' · ')]);
  } catch (e) {}
}

/* ---------- acciones ---------- */
function acc_(d) {
  const st = get_(d.code);
  if (!st) return { ok: false, error: 'La partida ya no existe' };
  const me = yo_(st, d.tok);
  if (!me) return { ok: false, error: 'No estás en esta partida' };
  const now = Date.now(); me.on = now;
  const a = d.a;
  if (a === 'cfg' && me.id === st.host && st.fase === 'lobby') {
    const r = parseInt(d.rondas, 10), du = parseInt(d.dur, 10);
    if ([3, 5, 7, 10].indexOf(r) >= 0) st.cfg.rondas = r;
    if ([10, 15, 20].indexOf(du) >= 0) st.cfg.dur = du;
    if (d.pj) st.cfg.pj = String(d.pj).replace(/[^\w]/g, '').slice(0, 20);
  } else if (a === 'empezar' && me.id === st.host && (st.fase === 'lobby' || st.fase === 'final')) {
    if (st.fase === 'final') st.jug = activos_(st, now);
    st.jug.forEach(j => j.pts = 0);
    st.ronda = 0; st.R = []; st.fotos = {}; st.votos = {}; st.hist = []; st.nof = {};
    st.esc = (Array.isArray(d.esc) ? d.esc : []).map(Number).filter(x => x >= 0 && x < 200).slice(0, 20);
    empezarRonda_(st, now);
  } else if (a === 'lobby' && me.id === st.host && st.fase === 'final') {
    st.fase = 'lobby'; st.jug = activos_(st, now); st.jug.forEach(j => j.pts = 0);
  } else if (a === 'foto' && st.fase === 'captura' && Number(d.ronda) === st.ronda) {
    const t = Number(d.t);
    const c = d.cam || {}, n = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
    const cam = { dx: Math.round(n(c.dx, -700, 700)), dy: Math.round(n(c.dy, -300, 300)), zm: n(c.zm || 1, .6, 2), pf: n(c.pf, -1, 2), pe: n(c.pe, -1, 1) };
    if (t >= 0 && t <= st.cfg.dur * 1000 + 50) st.fotos[st.ronda][me.id] = { t: Math.round(t), q: Math.max(0, Math.min(100, Math.round(Number(d.q) || 0))), enc: !!d.enc, cam };
  } else if (a === 'nofoto' && st.fase === 'captura' && Number(d.ronda) === st.ronda) {
    st.nof = st.nof || {}; st.nof[st.ronda] = st.nof[st.ronda] || []; if (st.nof[st.ronda].indexOf(me.id) < 0) st.nof[st.ronda].push(me.id);
  } else if (a === 'votos' && st.fase === 'voto' && Number(d.ronda) === st.ronda) {
    const e = {}, r = {};
    Object.keys(d.e || {}).forEach(k => { if (Number(k) !== me.id) { const x = parseInt(d.e[k], 10); if (x >= 1 && x <= 5) e[k] = x; } });
    Object.keys(d.r || {}).forEach(k => { if (Number(k) !== me.id) r[k] = String(d.r[k]).slice(0, 4); });
    st.votos[st.ronda][me.id] = { e, r };
  } else if (a === 'salir') {
    st.jug = st.jug.filter(j => j.id !== me.id);
    if (st.host === me.id && st.jug[0]) st.host = st.jug[0].id;
  }
  avanzar_(st, now);
  put_(st);
  return { ok: true, st: pub_(st, a === 'salir' ? null : me) };
}

function autorizar() { SpreadsheetApp.getActiveSpreadsheet(); }
