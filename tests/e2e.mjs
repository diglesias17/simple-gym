// Pruebas de punta a punta de SimpleGym.
//
// Levanta un servidor local con la app, abre Chrome (o Edge) sin ventana con pantalla de teléfono (390×844)
// y la maneja por el protocolo de DevTools. No necesita dependencias: solo Node 22 o más nuevo.
//
//   node tests/e2e.mjs              corre las pruebas
//   node tests/e2e.mjs --capturas   además guarda capturas de pantalla (la carpeta se indica al final)
//
// Variables opcionales: CHROME (ruta al navegador) y SIMPLEGYM_OUT (carpeta de trabajo y capturas).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SIMPLEGYM_OUT || path.join(os.tmpdir(), 'simplegym-e2e');
const CAPTURAS = process.argv.includes('--capturas');
const TIMEOUT_MS = 180_000;

const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('No encontré Chrome ni Edge. Indicá la ruta con la variable CHROME.'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (cond, msg) => { console.log((cond ? 'OK    ' : 'FALLA ') + msg); cond ? passed++ : failed++; };

/* ---------- Servidor y navegador ---------- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(d);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${server.address().port}/index.html`;

// Perfil nuevo en cada corrida: localStorage vacío, así la prueba de migración arranca de cero.
const PROFILE = path.join(OUT, 'perfil');
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=390,844', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch {} server.close(); };
const watchdog = setTimeout(() => { console.error(`\nTiempo agotado (${TIMEOUT_MS / 1000} s).`); cleanup(); process.exit(1); }, TIMEOUT_MS);

let port;
for (let i = 0; i < 100 && !port; i++) {
  try { port = fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); }
}
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch { await sleep(200); }
}
if (!target) { console.error('No pude conectarme al navegador.'); cleanup(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = {};
const errors = [];
const cmd = (method, params = {}) => new Promise(r => { const id = ++seq; pending[id] = r; ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description);
  // Acepta solo los confirm()/alert(): un diálogo abierto bloquearía la prueba.
  if (d.method === 'Page.javascriptDialogOpening') cmd('Page.handleJavaScriptDialog', { accept: true });
};
const ev = async expr => {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const reload = async () => { await ev('location.reload()').catch(() => {}); await sleep(1000); };
const type = (sel, val) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(val)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const click = async sel => { await ev(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(150); };
const go = async v => { await ev(`go(${JSON.stringify(v)})`); await sleep(250); };
const shot = async (name, height) => {
  if (!CAPTURAS) return;
  await sleep(300);
  const clip = height ? { clip: { x: 0, y: 0, width: 390, height, scale: 1 } } : {};
  const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...clip });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
};

try {
  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cmd('Page.navigate', { url: APP }); await sleep(800);

  /* ---------- 1. Migración desde la primera versión ---------- */
  const t0 = Date.now() - 86400000;
  const v1 = {
    sessions: [{ id: 'a', dayId: 'd1', start: t0, end: t0 + 3600000, warmup: [true, true], note: 'ok',
      ex: { 'sentadilla-copa': [{ w: '20', r: '10', done: true }, { w: '22', r: '8', done: true }], 'curl-biceps-manc': [{ w: '8', r: '10', done: true }] } }],
    current: { id: 'b', dayId: 'd2', start: Date.now(), warmup: [true], note: '',
      ex: { 'peso-muerto-rumano': [{ w: '40', r: '8', done: true }, { w: '40', r: '', done: false }] } },
  };
  await ev(`localStorage.setItem('simplegym:v1', ${JSON.stringify(JSON.stringify(v1))}); location.hash = ''`);
  await reload();
  ok(await ev('db.v') === 2, 'migración: formato de datos v2');
  ok(await ev('db.routines.length === 1 && db.activeId === "r1"'), 'migración: rutina inicial creada y en uso');
  ok(await ev('JSON.stringify(Object.keys(db.sessions[0].ex))') === '["sentadilla-copa","curl-biceps-mancuerna"]', 'migración: ejercicios identificados por nombre');
  ok(await ev('db.current.dayName === "Día 2" && db.current.plan.length === 6 && db.current.ex["peso-muerto-rumano-barra-o-manc"].length === 2'), 'migración: la sesión en curso se conserva');
  ok(await ev('JSON.stringify(db.routines[0].warmup.items[0]) + JSON.stringify(db.routines[0].warmup.items[2])')
    === '{"name":"Cadera frontal + isquios","sets":2,"reps":"10"}{"name":"Piramidal parado, pierna en cajón","sets":2,"reps":"30\\""}',
    'migración: entrada en calor separada en ejercicio, series (las 2 vueltas) y reps');
  ok(await ev(`!('rounds' in db.routines[0].warmup) && !('rounds' in db.current.phases.warmup)`), 'migración: ya no quedan vueltas');
  ok(await ev('db.sessions[0].phases.warmup.items[1].name === "Ranas a 1 pierna" && db.current.phases.warmup.items[1].reps === "10"'), 'migración: también en sesiones guardadas y en curso');
  ok(await ev('lastSets(exKey("Sentadilla Copa")).sets.length') === 2, 'historial vinculado por nombre, sin importar mayúsculas');
  await go('session');
  ok(await ev(`document.querySelector('[data-count=warmup]').textContent`) === '1/8', 'migración: la sesión en curso conserva lo marcado (1/8)');
  ok(await ev(`document.querySelectorAll('.phase .wu-row')[0].querySelectorAll('[data-act=phase]').length`) === 2, 'sesión: un check por serie en la entrada en calor');
  await shot('01-sesion-migrada', 900);
  await go('');
  await shot('02-inicio');

  /* ---------- 2. Crear una rutina con el editor ---------- */
  await go('routines');
  await click('[data-act=new-routine]');
  await type('[data-p="name"]', 'Rutina diciembre');
  await click('[data-act=ed-add-item][data-phase=warmup]');
  await type('[data-p="warmup.items.0.name"]', 'Ranas');
  await type('[data-p="warmup.items.0.reps"]', '10');
  await type('[data-p="days.0.ex.0.name"]', 'Sentadilla copa');
  await type('[data-p="days.0.ex.0.sets"]', '4');
  await type('[data-p="days.0.ex.0.reps"]', '6–8');
  await type('[data-p="days.0.ex.0.weight"]', '25');
  await click('[data-act=ed-add-ex][data-d="0"]');
  await type('[data-p="days.0.ex.1.name"]', 'Press banca');
  await type('[data-p="days.0.ex.1.rest"]', '120');
  await click('[data-act=ed-add-ex][data-d="0"]');                                  // queda vacío: se descarta al guardar
  await click('[data-act=ed-move][data-p="days.0.ex.1"][data-dir="-1"]');
  await click('[data-act=ed-add-day]');
  await type('[data-p="days.1.ex.0.name"]', 'Remo');
  await click('[data-act=ed-add-item][data-phase=cooldown]');
  await type('[data-p="cooldown.items.0.name"]', 'Isquios');
  await type('[data-p="cooldown.items.0.reps"]', '30"');
  ok(await ev('db.draft.days[0].ex[0].name') === 'Press banca', 'editor: subir un ejercicio');
  await reload();
  ok(await ev('db.draft?.name') === 'Rutina diciembre', 'editor: el borrador sobrevive a recargar la página');
  await go('edit');
  await shot('03-editor', 1100);

  // Autocompletar
  const options = id => `[...document.querySelectorAll('#${id} option')].map(x => x.value)`;
  ok(await ev(`(() => { const o = ${options('ex-names')}; return o.indexOf('Sentadilla copa') < 25 && o.indexOf('Burpees') >= 25 && o.length > 120; })()`),
    'autocompletar: primero los nombres propios, después la lista curada');
  ok(await ev(`(() => { const o = ${options('ex-names')}.map(exKey); return new Set(o).size === o.length && o.filter(k => k === 'sentadilla-zercher').length === 1; })()`),
    'autocompletar: sin repetidos entre propios y curados');
  ok(await ev(`(() => { const o = ${options('phase-items')}; const cur = o.indexOf('Elongación de isquios');
    return o.indexOf('Ranas a 1 pierna') < cur && o.indexOf('Sentadilla copa') < cur && o.includes('Press Pallof'); })()`),
    'autocompletar fases: propios primero (fases y ejercicios), después las dos listas curadas');
  ok(await ev(`(() => { const o = ${options('phase-items')}.map(exKey); return new Set(o).size === o.length && o.filter(k => k === 'plancha').length === 1; })()`),
    'autocompletar fases: sin repetidos (Plancha está en las dos listas)');
  ok(await ev(`document.querySelector('[data-p="days.0.ex.0.name"]').list?.id === 'ex-names' && document.querySelector('[data-p="warmup.items.0.name"]').list?.id === 'phase-items'`),
    'autocompletar: los campos usan sus listas');

  await click('.primary[data-act=ed-save]'); await sleep(300);
  ok(await ev('db.routines.length === 2 && db.activeId === db.routines[1].id && !db.draft'), 'guardar: rutina creada y en uso');
  ok(await ev('db.routines[1].days[0].ex.length === 2 && db.routines[1].days[0].ex[0].rest === 120 && db.routines[1].days[0].ex[1].sets === 4 && db.routines[1].days[0].ex[1].weight === "25"'),
    'guardar: ejercicio vacío descartado, números y peso normalizados');

  /* ---------- 3. Inicio, selector de días y sesión ---------- */
  ok(await ev(`!document.querySelector('[data-act=open-picker]')`), 'inicio: con una sesión en curso no aparece Entrenar');
  await ev(`db.current = null; save()`); await go('');
  ok(await ev(`!!document.querySelector('[data-act=open-picker]') && !document.querySelector('.sheet')`), 'inicio: botón Entrenar con el selector cerrado');
  await click('[data-act=open-picker]'); await sleep(200);
  ok(await ev(`document.querySelectorAll('.sheet .list-row').length`) === 2, 'selector: muestra los días de la rutina');
  ok(await ev(`document.querySelector('.sheet .list-row.next')?.dataset.day === db.routines[1].days[0].id`), 'selector: resalta el día que toca');
  await shot('04-selector');
  await click('.sheet [data-act=start]'); await sleep(250);
  ok(await ev('db.current.routineName === "Rutina diciembre"'), 'sesión: usa la rutina en uso');
  ok(await ev('db.current.ex["sentadilla-copa"][0].w') === '25', 'peso: la primera vez con la rutina precarga el sugerido (25), no el de otra rutina (20)');
  ok(await ev(`document.querySelector('[data-ex=sentadilla-copa] .sug')?.textContent`) === 'Sugerido: 25 kg', 'peso: la sesión muestra el sugerido');
  await click('[data-ex="press-banca"] [data-act=set]');
  ok(await ev('rest.total') === 120, 'descanso: usa el propio del ejercicio (120 s)');
  await click('[data-ex="sentadilla-copa"] [data-act=set]');
  ok(await ev('rest.total') === 90, 'descanso: sin uno propio, usa el por defecto (90 s)');
  ok(await ev(`db.current.ex['sentadilla-copa'][1].w === db.current.ex['sentadilla-copa'][0].w && db.current.ex['sentadilla-copa'][1].r === db.current.ex['sentadilla-copa'][0].r`),
    'sesión: al marcar una serie, peso y reps pasan a la siguiente');
  const ph = await ev(`[...document.querySelectorAll('.phase .wu-row > span')].map(s => s.textContent.trim()).join(' | ')`);
  ok(ph === '10 × Ranas | 30" Isquios', `sesión: entrada en calor y elongación muestran reps y ejercicio (${ph})`);
  await shot('05-sesion', 900);

  /* ---------- 4. Continuar una sesión terminada hoy ---------- */
  await ev('finish()'); await sleep(300);
  const sid = await ev('db.sessions.at(-1).id'), nSess = await ev('db.sessions.length');
  ok(await ev('!db.current'), 'continuar: la sesión quedó terminada');
  await ev(`document.querySelector('details.last').open = true`); await sleep(100);
  ok(await ev(`!!document.querySelector('details.last [data-act=reopen]')`), 'continuar: el detalle de hoy muestra el botón');
  await go('history');
  ok(await ev(`document.querySelectorAll('[data-act=reopen]').length`) === 1, 'continuar: en el historial, solo la sesión de hoy');
  await go('');
  await ev(`document.querySelector('details.last').open = true; document.querySelector('[data-act=reopen]').click()`); await sleep(300);
  ok(await ev(`db.current?.id === ${JSON.stringify(sid)} && location.hash === '#session'`), 'continuar: vuelve a estar en curso');
  ok(await ev(`db.current.ex['press-banca'][0].done === true && db.current.paused >= 0 && db.current.end === undefined`), 'continuar: conserva las series marcadas');
  ok(await ev('db.sessions.length') === nSess - 1, 'continuar: sale del historial mientras está en curso');
  await ev('finish()'); await sleep(300);
  ok(await ev(`db.sessions.length === ${nSess} && db.sessions.at(-1).id === ${JSON.stringify(sid)}`), 'continuar: al terminar vuelve al historial');
  ok(await ev('db.sessions.every((s, i, a) => !i || a[i - 1].start <= s.start)'), 'historial ordenado por fecha');

  /* ---------- 5. Peso: la segunda vez con la rutina usa lo real ---------- */
  await ev(`(() => { const r = db.routines[1]; db.sessions.push({ id: 'w1', routineId: r.id, routineName: r.name, dayId: r.days[0].id, dayName: 'Día 1',
    start: Date.now() - 1000, end: Date.now(), plan: [], phases: {}, ex: { 'sentadilla-copa': [{ w: '27', r: '8', done: true }] } }); save(); })()`);
  await ev('startSession(db.routines[1].days[0].id)'); await sleep(300);
  ok(await ev('db.current.ex["sentadilla-copa"][0].w') === '27', 'peso: la segunda vez con la rutina precarga lo real (27)');
  ok(await ev(`!!document.querySelector('[data-ex=sentadilla-copa] .sug')`), 'peso: el sugerido se sigue viendo como referencia');

  /* ---------- 6. Entrada en calor con series distintas por ítem ---------- */
  await ev(`(() => { db.routines[1].warmup.items = [{ name: 'Ranas', sets: 2, reps: '10' }, { name: 'Cinta', sets: 1, reps: '5 min' }]; db.current = null; save(); })()`);
  await ev('startSession(db.routines[1].days[0].id)'); await sleep(300);
  ok(await ev(`[...document.querySelectorAll('.phase')[0].querySelectorAll('.wu-row')].map(r => r.querySelectorAll('[data-act=phase]').length).join(',')`) === '2,1',
    'fases: cada ítem con su cantidad de series (2 y 1)');
  ok(await ev(`document.querySelector('[data-count=warmup]').textContent`) === '0/3', 'fases: el total es la suma de las series');
  await ev(`document.querySelectorAll('.phase')[0].querySelectorAll('.wu-row')[1].querySelector('[data-act=phase]').click()`); await sleep(100);
  ok(await ev(`document.querySelector('[data-count=warmup]').textContent`) === '1/3', 'fases: marcar suma al contador');
  await ev(`db.current = null; save()`); await go('routines');
  await click('[data-act=edit-routine]'); await sleep(150);
  ok(await ev(`document.querySelector('[data-p="warmup.items.0.sets"]').value`) === '2', 'editor: los ítems de la entrada en calor tienen series');
  await click('[data-act=ed-add-item][data-phase=warmup]');
  ok(await ev('db.draft.warmup.items.length === 5 && db.draft.warmup.items[4].sets === 2'), 'editor: "+ ítem" copia las series del anterior');
  await click('[data-act=ed-move][data-p="warmup.items.1"][data-dir="-1"]');
  ok(await ev('db.draft.warmup.items[0].name') === 'Ranas a 1 pierna', 'editor: los ítems se pueden reordenar');
  await ev(`db.draft = null; save()`);

  /* ---------- 7. Configuración ---------- */
  await go('history');
  ok(!(await ev(`!!document.querySelector('[data-act=export]')`)), 'historial: la copia de seguridad ya no está acá');
  await click('.tab[data-tab=settings]'); await sleep(150);
  ok(await ev(`location.hash === '#settings' && document.querySelector('.tab.on').dataset.tab === 'settings'`), 'configuración: pestaña activa');
  ok(await ev(`!!document.querySelector('[data-act=export]') && !!document.querySelector('#file')`), 'configuración: exportar e importar');

  // Descanso por defecto
  ok(await ev(`document.querySelector('[data-act=rest-default].on')?.dataset.sec`) === '90', 'descanso por defecto: 1:30 marcado de entrada');
  await click('[data-act=rest-default][data-sec="180"]');
  ok(await ev('db.settings.restSeconds') === 180, 'descanso por defecto: se guarda al elegir 3:00');
  await reload();
  ok(await ev(`document.querySelector('[data-act=rest-default].on')?.dataset.sec`) === '180', 'descanso por defecto: se mantiene al recargar');
  await shot('06-configuracion');
  await ev('startSession(db.routines[1].days[0].id)'); await sleep(300);
  await click('[data-ex="sentadilla-copa"] [data-act=set]');
  ok(await ev('rest.total') === 180, 'descanso por defecto: lo usan los ejercicios sin descanso propio (180 s)');
  await click('[data-ex="press-banca"] [data-act=set]');
  ok(await ev('rest.total') === 120, 'descanso por defecto: el descanso propio del ejercicio tiene prioridad (120 s)');
  await ev(`stopRest(); db.current = null; save()`); await go('routines');
  await click('[data-act=edit-routine]'); await sleep(150);
  ok(await ev(`document.querySelector('[data-p="days.0.ex.0.rest"]').placeholder`) === '180', 'descanso por defecto: el editor lo muestra como referencia');
  await ev(`db.draft = null; save()`);
  await go('settings');
  await click('[data-act=rest-default][data-sec="90"]');

  // Tamaño de letra
  await click('[data-act=font][data-scale="1.3"]');
  ok(await ev(`document.documentElement.style.zoom === '1.3' && db.settings.fontScale === 1.3`), 'letra: Muy grande aplicada');
  ok(await ev('db.settings.restSeconds') === 90, 'configuración: cambiar la letra no pisa el descanso');
  await reload();
  ok(await ev('document.documentElement.style.zoom') === '1.3', 'letra: se mantiene al recargar');
  await ev('startSession(db.routines[1].days[0].id)'); await sleep(300);
  for (const v of ['', 'routines', 'history', 'settings', 'session']) {
    await go(v);
    ok(await ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), `letra muy grande: sin scroll horizontal en "${v || 'inicio'}"`);
  }
  await shot('07-sesion-letra-grande', 900);
  await ev(`db.current = null; save()`); await go('settings');
  await click('[data-act=font][data-scale="1"]');
  ok(await ev('document.documentElement.style.zoom') === '', 'letra: volver a Normal');

  ok(errors.length === 0, 'sin errores de JavaScript' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  failed++;
  console.error('\nLa prueba se interrumpió:', e.message);
} finally {
  clearTimeout(watchdog);
  ws.close(); cleanup();
}

console.log(`\n${passed} OK, ${failed} ${failed === 1 ? 'falla' : 'fallas'}${CAPTURAS ? `. Capturas en ${OUT}` : ''}`);
process.exit(failed ? 1 : 0);
