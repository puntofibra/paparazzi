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
// los resultados ya no tienen contador: se sigue cuando todos pulsan CONTINUAR (o el anfitrión fuerza)
const T_OFF = 25000;        // sin noticias en 25 s = desconectado
const T_INACT = 15 * 60000; // sala o partida sin uso 15 min = se cierra sola

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
      // personajes con código
      case 'pjCodigo': return pjCodigo_(d);
      case 'pjVarios': return pjVarios_(d);
      // panel admin (llave NFC)
      case 'admLlave': return admLlave_(d);
      case 'admLista': return admLista_(d);
      case 'admGuardar': return conLock_(() => admGuardar_(d));
      case 'admBorrar': return conLock_(() => admBorrar_(d));
      case 'admPose': return admPose_(d);
      case 'admPoses': return conLock_(() => admPoses_(d));
      case 'pjImg': return pjImg_(d);
      case 'precio': return { ok: true, precio: precio_() };
      case 'admPrecio': return admPrecio_(d);
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
function get_(code) {
  const k = 'sala_' + String(code || '').toUpperCase(), c = CacheService.getScriptCache(), s = c.get(k);
  if (!s) return null;
  const st = JSON.parse(s);
  // sin ninguna acción en 15 min (nadie juega, vota ni toca nada) → la sala se cierra
  if (Date.now() - (st.uso || st.creada || 0) > T_INACT) { c.remove(k); return null; }
  return st;
}
// la caché también caduca sola a los 15 min si nadie la abre
function put_(st) { st.v = (st.v || 0) + 1; CacheService.getScriptCache().put('sala_' + st.code, JSON.stringify(st), 900); }
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
    code, v: 0, uso: Date.now(), fase: 'lobby', host: 1, sig: 2,
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
  st.uso = now;
  if (!st.jug.some(j => j.id === st.host && now - (j.on || 0) < T_OFF)) st.host = me.id;
  avanzar_(st, now);
  put_(st);
  return { ok: true, tok: me.t, st: pub_(st, me) };
}
function ver_(d) {
  let st = get_(d.code);
  if (!st) return { ok: false, error: 'La partida ya no existe (se cierra sola tras 15 min de inactividad)' };
  const now = Date.now();
  const me = yo_(st, d.tok);
  // durante la ronda de fotos o la votación la partida está en uso aunque no se pulse nada
  if (st.fase === 'captura' || st.fase === 'voto') st.uso = Math.max(st.uso || 0, now - 1);
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
  if (st.fase === 'resultado') {
    const L = st.listo || [];
    return !!st.forzar || (act.length > 0 && act.every(id => L.indexOf(id) >= 0));
  }
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
  // solo se guarda lo de la ronda actual (el historial va en hist y gal)
  st.fotos = {}; st.votos = {}; st.tomas = {};
  st.fotos[st.ronda] = {}; st.votos[st.ronda] = {}; st.tomas[st.ronda] = {};
  st.listo = []; st.forzar = 0;
}
// cámara de una foto (validada)
function camOk_(c) {
  c = c || {}; const n = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
  return { ax: Math.round(n(c.ax, 0, 1600)), ay: Math.round(n(c.ay, 0, 900)), zm: n(c.zm || 1.3, 1, 3.2), pf: n(c.pf, -1, 2), pe: n(c.pe, -1, 1), mx: Math.round(n(c.mx, -150, 150)), my: Math.round(n(c.my, -150, 150)) };
}
function guardaTomas_(st, me, d) {
  const sh = (Array.isArray(d.sh) ? d.sh : []).slice(0, 3).map(x => ({ t: Math.round(Number(x && x.t) || 0), q: Math.max(0, Math.min(100, Math.round(Number(x && x.q) || 0))), cam: camOk_(x && x.cam) }))
    .filter(x => x.t >= 0 && x.t <= st.cfg.dur * 1000 + 50);
  st.tomas = st.tomas || {}; st.tomas[st.ronda] = st.tomas[st.ronda] || {};
  if (sh.length) st.tomas[st.ronda][me.id] = sh;
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
  st.gal = st.gal || []; st.gal[st.ronda - 1] = (st.tomas && st.tomas[st.ronda]) || {};
  st.fase = 'resultado';
  st.listo = []; st.forzar = 0;
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
  st.uso = now;
  if (a === 'cfg' && me.id === st.host && st.fase === 'lobby') {
    const r = parseInt(d.rondas, 10), du = parseInt(d.dur, 10);
    if ([3, 5, 7, 10].indexOf(r) >= 0) st.cfg.rondas = r;
    if ([10, 15, 20].indexOf(du) >= 0) st.cfg.dur = du;
    // Jorge siempre; otro personaje solo si el anfitrión tiene su código
    if (d.pj === 'jorge') { st.cfg.pj = 'jorge'; delete st.pjDef; }
    else if (d.pj && d.pjCode) { const P = pjPorCodigo_(d.pjCode); if (P && P.id === String(d.pj)) { st.cfg.pj = P.id; st.pjDef = pjPub_(P); } }
  } else if (a === 'empezar' && me.id === st.host && (st.fase === 'lobby' || st.fase === 'final')) {
    if (st.fase === 'final') st.jug = activos_(st, now);
    st.jug.forEach(j => j.pts = 0);
    st.ronda = 0; st.R = []; st.fotos = {}; st.votos = {}; st.hist = []; st.nof = {}; st.gal = []; st.tomas = {};
    st.esc = (Array.isArray(d.esc) ? d.esc : []).map(Number).filter(x => x >= 0 && x < 200).slice(0, 20);
    empezarRonda_(st, now);
  } else if (a === 'lobby' && me.id === st.host && st.fase === 'final') {
    st.fase = 'lobby'; st.jug = activos_(st, now); st.jug.forEach(j => j.pts = 0);
  } else if (a === 'foto' && st.fase === 'captura' && Number(d.ronda) === st.ronda) {
    const t = Number(d.t);
    const cam = camOk_(d.cam);
    guardaTomas_(st, me, d);
    if (t >= 0 && t <= st.cfg.dur * 1000 + 50) st.fotos[st.ronda][me.id] = { t: Math.round(t), q: Math.max(0, Math.min(100, Math.round(Number(d.q) || 0))), enc: !!d.enc, cam };
  } else if (a === 'nofoto' && st.fase === 'captura' && Number(d.ronda) === st.ronda) {
    guardaTomas_(st, me, d);
    st.nof = st.nof || {}; st.nof[st.ronda] = st.nof[st.ronda] || []; if (st.nof[st.ronda].indexOf(me.id) < 0) st.nof[st.ronda].push(me.id);
  } else if (a === 'votos' && st.fase === 'voto' && Number(d.ronda) === st.ronda) {
    const e = {}, r = {};
    Object.keys(d.e || {}).forEach(k => { if (Number(k) !== me.id) { const x = parseInt(d.e[k], 10); if (x >= 1 && x <= 5) e[k] = x; } });
    Object.keys(d.r || {}).forEach(k => { if (Number(k) !== me.id) r[k] = String(d.r[k]).slice(0, 4); });
    st.votos[st.ronda][me.id] = { e, r };
  } else if (a === 'listo' && st.fase === 'resultado' && Number(d.ronda) === st.ronda) {
    st.listo = st.listo || []; if (st.listo.indexOf(me.id) < 0) st.listo.push(me.id);
  } else if (a === 'forzar' && me.id === st.host && st.fase === 'resultado' && Number(d.ronda) === st.ronda) {
    st.forzar = 1;
  } else if (a === 'salir') {
    st.jug = st.jug.filter(j => j.id !== me.id);
    if (st.host === me.id && st.jug[0]) st.host = st.jug[0].id;
  }
  avanzar_(st, now);
  put_(st);
  return { ok: true, st: pub_(st, a === 'salir' ? null : me) };
}

function autorizar() { SpreadsheetApp.getActiveSpreadsheet(); }


/* =========================================================
   PERSONAJES CON CÓDIGO (hoja "Personajes")
   id | nombre | codigo | icono | poses (JSON) | activo | creado
   Las imágenes van en el repo: personajes/<id>/<archivo>.png
   ========================================================= */
const PJ_COLS = ['id', 'nombre', 'codigo', 'icono', 'poses', 'activo', 'creado'];
function hojaPj_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Personajes');
  if (!sh) { sh = ss.insertSheet('Personajes'); sh.appendRow(PJ_COLS); sh.setFrozenRows(1); }
  return sh;
}
function pjTodos_() {
  const c = CacheService.getScriptCache(), k = 'pj_todos', s = c.get(k);
  if (s) return JSON.parse(s);
  const v = hojaPj_().getDataRange().getValues(), out = [];
  for (let i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    let poses = []; try { poses = JSON.parse(v[i][4] || '[]'); } catch (e) {}
    out.push({ fila: i + 1, id: String(v[i][0]), n: String(v[i][1]), code: String(v[i][2]).toUpperCase(), icon: String(v[i][3] || ''), poses, activo: v[i][5] !== false && String(v[i][5]).toUpperCase() !== 'NO' && String(v[i][5]).toUpperCase() !== 'FALSE' });
  }
  c.put(k, JSON.stringify(out), 300);
  return out;
}
function pjLimpiaCache_() { CacheService.getScriptCache().remove('pj_todos'); }
const limpiaCod_ = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
function pjPorCodigo_(code) {
  code = limpiaCod_(code); if (code.length !== 4) return null;
  return pjTodos_().find(p => p.code === code && p.activo && p.poses.length) || null;
}
function pjPub_(P) {
  const base = 'personajes/' + P.id + '/';
  const fx = f => /^https?:|^gd:|\//.test(f) ? f : base + f;
  return { id: P.id, n: P.n, icon: fx(P.icon || (P.poses[0] && P.poses[0].f) || ''), poses: P.poses.map(x => Object.assign({}, x, { f: fx(x.f) })) };
}
function freno_(clave, max, seg) {
  const c = CacheService.getScriptCache(), k = 'fr_' + clave, n = Number(c.get(k) || 0);
  if (n >= max) throw new Error('Demasiados intentos. Espera unos minutos.');
  c.put(k, String(n + 1), seg);
}
function pjCodigo_(d) {
  freno_('pjcod', 120, 600);
  const P = pjPorCodigo_(d.code);
  if (!P) return { ok: false, error: 'Ese código no existe' };
  return { ok: true, code: P.code, pj: pjPub_(P) };
}
function pjVarios_(d) {
  const codes = (Array.isArray(d.codes) ? d.codes : []).slice(0, 30).map(limpiaCod_);
  const res = [];
  codes.forEach(c => { const P = pjPorCodigo_(c); if (P) res.push({ code: P.code, pj: pjPub_(P) }); });
  return { ok: true, pjs: res };
}

/* ---------- admin con llave NFC ---------- */
function sha_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join(''); }
function llaves_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('llaves') || '[]'); } catch (e) { return []; } }
function admLlave_(d) {
  freno_('admllave', 10, 600);
  const llave = String(d.llave || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (llave.length < 6) return { ok: false, error: 'Llave no válida' };
  const list = llaves_(), h = sha_('paparazzi|' + llave);
  let nueva = false;
  if (list.indexOf(h) < 0) {
    // la primera llave que se pasa queda registrada como la del admin; después solo valen las registradas
    if (list.length) return { ok: false, error: 'Esta llave no está autorizada' };
    list.push(h); PropertiesService.getScriptProperties().setProperty('llaves', JSON.stringify(list)); nueva = true;
  }
  const t = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('adm_' + t, '1', 14400);
  return { ok: true, adm: t, nueva };
}
function esAdm_(d) { if (!d.adm || CacheService.getScriptCache().get('adm_' + d.adm) !== '1') throw new Error('Sesión de admin caducada: vuelve a pasar la llave'); }
function admLista_(d) {
  esAdm_(d); pjLimpiaCache_();
  return { ok: true, pjs: pjTodos_().map(P => ({ id: P.id, n: P.n, code: P.code, activo: P.activo, nPoses: P.poses.length, icon: pjPub_(P).icon })) };
}
function codigoNuevo_() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', usados = pjTodos_().map(p => p.code);
  for (let k = 0; k < 200; k++) { let c = ''; for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)]; if (usados.indexOf(c) < 0) return c; }
  throw new Error('No hay códigos libres');
}
function admGuardar_(d) {
  esAdm_(d); pjLimpiaCache_();
  const sh = hojaPj_(), todos = pjTodos_();
  const n = String(d.n || '').replace(/[<>"'`]/g, '').trim().slice(0, 20);
  let code = d.code === 'NUEVO' ? codigoNuevo_() : limpiaCod_(d.code);
  if (d.code && d.code !== 'NUEVO' && code.length !== 4) return { ok: false, error: 'El código debe tener 4 letras o números' };
  const P = d.id ? todos.find(x => x.id === String(d.id)) : null;
  if (code && todos.some(x => x.code === code && (!P || x.id !== P.id))) return { ok: false, error: 'Ese código ya lo tiene otro personaje' };
  if (P) {
    if (n) sh.getRange(P.fila, 2).setValue(n);
    if (code) sh.getRange(P.fila, 3).setValue(code);
    if (d.activo != null) sh.getRange(P.fila, 6).setValue(d.activo ? 'SI' : 'NO');
  } else {
    if (!n) return { ok: false, error: 'Ponle un nombre' };
    const id = n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '') || ('pj' + Date.now());
    if (id === 'jorge' || todos.some(x => x.id === id)) return { ok: false, error: 'Ya hay un personaje con ese nombre' };
    sh.appendRow([id, n, code || codigoNuevo_(), '', '[]', 'SI', new Date()]);
  }
  pjLimpiaCache_();
  return admLista_(d);
}
function admBorrar_(d) {
  esAdm_(d); pjLimpiaCache_();
  const P = pjTodos_().find(x => x.id === String(d.id));
  if (P) hojaPj_().deleteRow(P.fila);
  pjLimpiaCache_();
  return admLista_(d);
}

/* ---------- poses subidas desde el panel admin (el móvil las recorta y aquí se guardan en Drive) ----------
   En la hoja la pose queda como f:"gd:<idDelArchivo>" y el juego la pide con la acción pjImg. */
const POSE_DEF = [
  { k: 'base', g: 1, tag: ['sonrie'] },
  { k: 'selfie', g: 1, tag: ['sonrie'] },
  { k: 'baile', g: 1, tag: ['sonrie'] },
  { k: 'salto', g: 1, tag: ['sonrie', 'accion'], air: 1 },
  { k: 'gafas', g: 1, tag: ['gafas'] },
  { k: 'perfil', g: .85, tag: ['perfil'] },
  { k: 'corre', g: .8, tag: ['accion'], run: 1 },
  { k: 'drama', g: .7, tag: ['drama'], h: .95 },
  { k: 'aburrido', g: .65, tag: ['drama'] },
  { k: 'espalda', g: .6, tag: ['espalda'] }
];
function carpetaPj_(id) {
  const props = PropertiesService.getScriptProperties(), rid = props.getProperty('carpetaPj');
  let raiz = null;
  try { if (rid) raiz = DriveApp.getFolderById(rid); } catch (e) {}
  if (!raiz) { raiz = DriveApp.createFolder('PAPARAZZI personajes'); props.setProperty('carpetaPj', raiz.getId()); }
  const it = raiz.getFoldersByName(id);
  return it.hasNext() ? it.next() : raiz.createFolder(id);
}
function admPose_(d) {
  esAdm_(d);
  const P = pjTodos_().find(x => x.id === String(d.id));
  if (!P) return { ok: false, error: 'Personaje no encontrado' };
  const k = String(d.k || '').replace(/[^a-z0-9]/g, '').slice(0, 12) || 'pose';
  const b64 = String(d.b64 || '').replace(/^data:image\/png;base64,/, '');
  if (b64.length < 100 || b64.length > 6000000) return { ok: false, error: 'Imagen no válida' };
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/png', P.id + '_' + k + '_' + Date.now() + '.png');
  const f = carpetaPj_(P.id).createFile(blob);
  return { ok: true, f: 'gd:' + f.getId() };
}
function admPoses_(d) {
  esAdm_(d); pjLimpiaCache_();
  const P = pjTodos_().find(x => x.id === String(d.id));
  if (!P) return { ok: false, error: 'Personaje no encontrado' };
  const poses = [];
  (Array.isArray(d.poses) ? d.poses : []).slice(0, 15).forEach(x => {
    const f = String(x && x.f || ''), k = String(x && x.k || '').replace(/[^a-z0-9]/g, '').slice(0, 12);
    if (!/^gd:[\w-]{10,}$/.test(f)) return;
    const def = POSE_DEF.find(p => p.k === k) || { k: k || 'pose', g: .85, tag: [] };
    poses.push(Object.assign({}, def, { f }));
  });
  if (!poses.length) return { ok: false, error: 'No hay poses para guardar' };
  // las imágenes antiguas de Drive que ya no se usan van a la papelera
  const nuevas = poses.map(p => p.f);
  P.poses.forEach(p => { if (/^gd:/.test(p.f) && nuevas.indexOf(p.f) < 0) { try { DriveApp.getFileById(p.f.slice(3)).setTrashed(true); } catch (e) {} } });
  const icon = (poses.find(p => p.k === 'selfie') || poses[0]).f;
  hojaPj_().getRange(P.fila, 4, 1, 2).setValues([[icon, JSON.stringify(poses)]]);
  pjLimpiaCache_();
  return admLista_(d);
}
function pjImg_(d) {
  const id = String(d.id || '').replace(/[^\w-]/g, ''), f = 'gd:' + id;
  // solo se sirven imágenes que sean poses de algún personaje
  if (!id || !pjTodos_().some(P => P.icon === f || P.poses.some(p => p.f === f))) return { ok: false, error: 'Imagen no encontrada' };
  return { ok: true, b64: Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes()) };
}
function autorizarDrive() { DriveApp.getRootFolder(); }

/* ---------- precio del personaje propio (se cambia desde el panel admin) ---------- */
function precio_() { const v = Number(PropertiesService.getScriptProperties().getProperty('precio')); return v > 0 ? v : 9.95; }
function admPrecio_(d) {
  esAdm_(d);
  const n = Math.round(Number(d.precio) * 100) / 100;
  if (!(n >= 0.5 && n <= 999)) return { ok: false, error: 'Precio no válido' };
  PropertiesService.getScriptProperties().setProperty('precio', String(n));
  return { ok: true, precio: n };
}
