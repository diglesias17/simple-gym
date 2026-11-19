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

// Perfil nuevo en cada corrida: localStorage vacío, así la app arranca sin rutinas.
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
// height: alto del recorte desde arriba de la página; 'pantalla' = solo lo visible (para hojas y ventanas fijas).
const shot = async (name, height) => {
  if (!CAPTURAS) return;
  await sleep(300);
  const screen = height === 'pantalla';
  const clip = height && !screen ? { clip: { x: 0, y: 0, width: 390, height, scale: 1 } } : {};
  const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !screen, ...clip });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
};

try {
  await cmd('Page.enable'); await cmd('Runtime.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cmd('Page.navigate', { url: APP }); await sleep(800);

  /* ---------- 0. Sin rutinas: rutinas de ejemplo ---------- */
  ok(await ev(`!!document.querySelector('.empty-card [data-act=new-menu]')`), 'inicio vacío: botón Crear rutina');
  await click('.empty-card [data-act=new-menu]'); await sleep(200);
  ok(await ev(`[...document.querySelectorAll('.sheet .list-row')].map(b => b.dataset.act).join(',')`) === 'new-routine,open-examples,import-routine',
    'nueva rutina: menú con desde cero, ejemplo e importar');
  await shot('00-menu-nueva', 'pantalla');
  ok(await ev(`TEMPLATES.every(t => t.days.every(([, ex]) => ex.every(([n]) => EXERCISES.includes(n))))`), 'ejemplos: todos los ejercicios están en la lista curada');
  ok(await ev(`TEMPLATES.every(t => t.days.every(([, , w = t.warmup, c = t.cooldown]) => w.length && [...w, ...c].every(([n]) => PHASE_ITEMS.includes(n) || EXERCISES.includes(n))))`),
    'ejemplos: entrada en calor y elongación con nombres de las listas');
  await click('.sheet [data-act=open-examples]'); await sleep(200);
  ok(await ev(`document.querySelectorAll('.sheet [data-act=use-example]').length`) === await ev('TEMPLATES.length'), 'ejemplos: la hoja muestra todas las rutinas');
  await shot('00-ejemplos', 'pantalla');
  await click('.sheet [data-act=use-example][data-i="0"]'); await sleep(200);
  ok(await ev(`location.hash === '#edit' && db.draft.name === 'Cuerpo completo' && !db.draft.draftOf && db.draft.days.length === 2`), 'ejemplos: se abre en el editor como rutina nueva');
  await click('.primary[data-act=ed-save]'); await sleep(300);
  ok(await ev(`db.routines.length === 1 && db.activeId === db.routines[0].id && db.routines[0].name === 'Cuerpo completo'`), 'ejemplos: guardada y en uso');
  ok(await ev(`(() => { const e = db.routines[0].days[0].ex[0]; return e.name === 'Sentadilla con barra' && e.sets === 3 && e.reps === '8–10' && e.rest === 120 && e.weight === null; })()`),
    'ejemplos: series, reps y descanso de la plantilla');
  ok(await ev(`db.routines[0].days.every(d => d.warmup.items.length === 4 && d.cooldown.items.length === 4) && !!db.routines[0].note`), 'ejemplos: cada día con entrada en calor y elongación, y nota');
  ok(await ev(`(() => { const r = fromTemplate(TEMPLATES.find(t => t.name === 'Torso / Piernas')); return r.days[0].warmup.items[0].name !== r.days[1].warmup.items[0].name
    && r.days[0].warmup.items[0].name === r.days[2].warmup.items[0].name; })()`), 'ejemplos: torso y piernas con entrada en calor distinta');
  await go('routines');
  ok(await ev(`!document.querySelector('.content [data-act=open-examples], .content [data-act=import-routine]')`), 'rutinas: sin botones sueltos, todo en el menú');
  ok(await ev(`['edit-routine', 'dup-routine', 'export-routine'].every(a => { const b = document.querySelector('.rt-actions [data-act=' + a + ']'); return b?.querySelector('svg') && b.getAttribute('aria-label'); })`),
    'rutinas: acciones con ícono y nombre accesible');
  await shot('00-rutinas', 400);
  await click('[data-act=new-menu]'); await sleep(200);
  await click('.sheet [data-act=open-examples]'); await sleep(200);
  ok(await ev(`!!document.querySelector('.sheet [data-act=use-example]')`), 'ejemplos: también desde la pestaña Rutinas');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(150);
  ok(await ev(`!document.querySelector('.sheet')`), 'ejemplos: Escape cierra la hoja');

  /* ---------- 1. Datos guardados ---------- */
  // Los datos de la primera versión (sin "v") ya no se cargan.
  await ev(`localStorage.setItem('simplegym:v1', JSON.stringify({ sessions: [{ id: 'x', dayId: 'd1', start: 1, ex: {} }] })); location.hash = ''`);
  await reload();
  ok(await ev('db.routines.length === 0 && db.sessions.length === 0'), 'datos de la primera versión: se ignoran');

  // Formato v2 anterior: entrada en calor en texto libre con "vueltas" para toda la fase.
  const t0 = Date.now() - 86400000;
  const oldWarmup = { rounds: 2, items: ['10 × Puente de glúteos', '10 × Ranas a 1 pierna', '30" Plancha', '10 × Círculos de brazos'] };
  const plan = names => names.map(name => ({ key: name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, sets: 3, reps: '10', rest: null }));
  const day1 = ['Sentadilla copa', 'Curl de bíceps con mancuernas', 'Sentadilla Zercher'];
  const day2 = ['Peso muerto rumano', 'Remo con mancuerna', 'Vuelos laterales', 'Plancha', 'Press militar con mancuernas', 'Gemelos parado'];
  const v2 = {
    v: 2, activeId: 'r1', draft: null, settings: { fontScale: 1, restSeconds: 90 },
    routines: [{ id: 'r1', name: 'Rutina de prueba', note: '', created: t0, warmup: oldWarmup, cooldown: { items: [] }, days: [
      { id: 'd1', name: 'Día 1', ex: day1.map(name => ({ name, sets: 3, reps: '10', rest: null })) },
      { id: 'd2', name: 'Día 2', ex: day2.map(name => ({ name, sets: 3, reps: '10', rest: null })) }] }],
    sessions: [{ id: 'a', routineId: 'r1', routineName: 'Rutina de prueba', dayId: 'd1', dayName: 'Día 1', start: t0, end: t0 + 3600000,
      warmup: [true, true], cooldown: [], note: 'ok', plan: plan(day1), phases: { warmup: oldWarmup, cooldown: { items: [] } },
      ex: { 'sentadilla-copa': [{ w: '20', r: '10', done: true }, { w: '22', r: '8', done: true }], 'curl-de-biceps-con-mancuernas': [{ w: '8', r: '10', done: true }] } }],
    current: { id: 'b', routineId: 'r1', routineName: 'Rutina de prueba', dayId: 'd2', dayName: 'Día 2', start: Date.now(),
      warmup: [true], cooldown: [], note: '', plan: plan(day2), phases: { warmup: oldWarmup, cooldown: { items: [] } },
      ex: { 'peso-muerto-rumano': [{ w: '40', r: '8', done: true }, { w: '40', r: '', done: false }] } },
  };
  await ev(`localStorage.setItem('simplegym:v1', ${JSON.stringify(JSON.stringify(v2))}); location.hash = ''`);
  await reload();
  ok(await ev('db.routines.length === 1 && db.activeId === "r1" && db.sessions.length === 1'), 'datos guardados: se cargan rutina y sesiones');
  ok(await ev('db.current.dayName === "Día 2" && db.current.plan.length === 6 && db.current.ex["peso-muerto-rumano"].length === 2'), 'datos guardados: la sesión en curso se conserva');
  ok(await ev('JSON.stringify(db.routines[0].days[1].warmup.items[0]) + JSON.stringify(db.routines[0].days[1].warmup.items[2])')
    === '{"name":"Puente de glúteos","sets":2,"reps":"10"}{"name":"Plancha","sets":2,"reps":"30\\""}',
    'fases viejas: entrada en calor separada en ejercicio, series (las 2 vueltas) y reps');
  ok(await ev(`!('rounds' in db.routines[0].days[0].warmup) && !('rounds' in db.current.phases.warmup)`), 'fases viejas: ya no quedan vueltas');
  ok(await ev(`!('warmup' in db.routines[0]) && !('cooldown' in db.routines[0]) && db.routines[0].days.every(d => d.warmup.items.length === 4 && d.cooldown.items.length === 0)`),
    'fases de la rutina: pasan a cada día');
  ok(await ev('db.sessions[0].phases.warmup.items[1].name === "Ranas a 1 pierna" && db.current.phases.warmup.items[1].reps === "10"'), 'fases viejas: también en sesiones guardadas y en curso');
  ok(await ev('lastSets(exKey("Sentadilla Copa")).sets.length') === 2, 'historial vinculado por nombre, sin importar mayúsculas');
  await go('session');
  ok(await ev(`document.querySelector('[data-count=warmup]').textContent`) === '1/8', 'fases viejas: la sesión en curso conserva lo marcado (1/8)');
  ok(await ev(`document.querySelectorAll('.phase .wu-row')[0].querySelectorAll('[data-act=phase]').length`) === 2, 'sesión: un check por serie en la entrada en calor');
  await shot('01-sesion-migrada', 900);
  await go('');
  await shot('02-inicio');

  /* ---------- 2. Crear una rutina con el editor ---------- */
  await go('routines');
  await click('[data-act=new-menu]'); await sleep(150);
  await click('.sheet [data-act=new-routine]'); await sleep(150);
  await type('[data-p="name"]', 'Rutina diciembre');
  ok(await ev(`!document.querySelector('.ed-phase h3') && document.querySelectorAll('.ed-phase.empty [data-act=ed-add-item]').length === 2`), 'editor: el día empieza sin fases, con botones para agregarlas');
  await click('[data-act=ed-add-item][data-phase=warmup][data-d="0"]');
  await type('[data-p="days.0.warmup.items.0.name"]', 'Ranas');
  await type('[data-p="days.0.warmup.items.0.reps"]', '10');
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
  ok(await ev(`db.draft.days[1].warmup.items[0]?.name === 'Ranas' && db.draft.days[1].warmup !== db.draft.days[0].warmup`), 'editor: el día nuevo copia la entrada en calor del anterior');
  await type('[data-p="days.1.ex.0.name"]', 'Remo');
  await click('[data-act=ed-add-item][data-phase=cooldown][data-d="0"]');
  await type('[data-p="days.0.cooldown.items.0.name"]', 'Isquios');
  await type('[data-p="days.0.cooldown.items.0.reps"]', '30"');
  ok(await ev('db.draft.days[1].cooldown.items.length') === 0, 'editor: cada día tiene su propia elongación');
  ok(await ev('db.draft.days[0].ex[0].name') === 'Press banca', 'editor: subir un ejercicio');
  // Pestañas de días
  const visibleDays = `[...document.querySelectorAll('.ed-day')].map(s => !s.hidden)`;
  ok(await ev(`document.querySelectorAll('.day-tab[data-act=ed-day]').length === 2 && document.querySelector('.day-tab.on').dataset.d === '1'
    && ${visibleDays}.join() === 'false,true'`), 'editor: una pestaña por día y se ve solo el elegido (el recién agregado)');
  await click('.day-tab[data-d="0"]');
  ok(await ev(`${visibleDays}.join() === 'true,false' && document.querySelector('.day-tab.on').dataset.d === '0'`), 'editor: tocar una pestaña muestra ese día');
  await type('[data-p="days.0.name"]', 'Día A');
  ok(await ev(`document.querySelector('.day-tab[data-d="0"]').textContent.trim()`) === 'Día A', 'editor: la pestaña se actualiza al escribir el nombre');
  await type('[data-p="days.0.name"]', 'Día 1');
  // Acordeón de ejercicios
  const sum = i => ev(`(() => { const d = document.querySelector('[data-item="days.0.ex.${i}"]'); return d.querySelector('.ed-sum-name').textContent + ' | ' + d.querySelector('.ed-sum-meta').textContent; })()`);
  ok(await sum(0) === 'Press banca | 3 series · 120 s' && await sum(1) === 'Sentadilla copa | 4 × 6–8 · 25 kg', 'acordeón: cerrado muestra nombre, series, reps, peso y descanso');
  await type('[data-p="days.0.ex.1.reps"]', '8');
  ok(await sum(1) === 'Sentadilla copa | 4 × 8 · 25 kg', 'acordeón: el resumen se actualiza al escribir');
  await type('[data-p="days.0.ex.1.reps"]', '6–8');
  await ev(`document.querySelector('[data-item="days.0.ex.0"]').open = true`); await sleep(100);
  await ev(`document.querySelector('[data-item="days.0.ex.1"]').open = true`); await sleep(100);
  ok(await ev(`[...document.querySelectorAll('details.ed-ex[open]')].map(d => d.dataset.item).join()`) === 'days.0.ex.1', 'acordeón: se abre de a uno');
  await click('[data-act=ed-move][data-p="days.0.ex.1"][data-dir="-1"]');
  ok(await ev(`[...document.querySelectorAll('details.ed-ex[open]')].map(d => d.dataset.item).join()`) === 'days.0.ex.0', 'acordeón: al subir un ejercicio sigue abierto');
  await click('[data-act=ed-move][data-p="days.0.ex.0"][data-dir="1"]');
  await reload();
  ok(await ev('db.draft?.name') === 'Rutina diciembre', 'editor: el borrador sobrevive a recargar la página');
  await go('edit');
  await shot('03-editor', 1100);

  // Autocompletar
  const options = id => `[...document.querySelectorAll('#${id} option')].map(x => x.value)`;
  ok(await ev(`(() => { const o = ${options('ex-names')}; return o.indexOf('Sentadilla copa') < o.indexOf('Burpees') && o.length > 120; })()`),
    'autocompletar: primero los nombres propios, después la lista curada');
  ok(await ev(`(() => { const o = ${options('ex-names')}.map(exKey); return new Set(o).size === o.length && o.filter(k => k === 'sentadilla-zercher').length === 1; })()`),
    'autocompletar: sin repetidos entre propios y curados');
  ok(await ev(`(() => { const o = ${options('phase-items')}; const cur = o.indexOf('Elongación de isquios');
    return o.indexOf('Ranas a 1 pierna') < cur && o.indexOf('Sentadilla copa') < cur && o.includes('Press Pallof'); })()`),
    'autocompletar fases: propios primero (fases y ejercicios), después las dos listas curadas');
  ok(await ev(`(() => { const o = ${options('phase-items')}.map(exKey); return new Set(o).size === o.length && o.filter(k => k === 'plancha').length === 1; })()`),
    'autocompletar fases: sin repetidos (Plancha está en las dos listas)');
  ok(await ev(`document.querySelector('[data-p="days.0.ex.0.name"]').list?.id === 'ex-names' && document.querySelector('[data-p="days.0.warmup.items.0.name"]').list?.id === 'phase-items'`),
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
  await shot('04-selector', 'pantalla');
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
  await ev(`(() => { db.routines[1].days[0].warmup.items = [{ name: 'Ranas', sets: 2, reps: '10' }, { name: 'Cinta', sets: 1, reps: '5 min' }]; db.current = null; save(); })()`);
  await ev('startSession(db.routines[1].days[0].id)'); await sleep(300);
  ok(await ev(`[...document.querySelectorAll('.phase')[0].querySelectorAll('.wu-row')].map(r => r.querySelectorAll('[data-act=phase]').length).join(',')`) === '2,1',
    'fases: cada ítem con su cantidad de series (2 y 1)');
  ok(await ev(`document.querySelector('[data-count=warmup]').textContent`) === '0/3', 'fases: el total es la suma de las series');
  await ev(`document.querySelectorAll('.phase')[0].querySelectorAll('.wu-row')[1].querySelector('[data-act=phase]').click()`); await sleep(100);
  ok(await ev(`document.querySelector('[data-count=warmup]').textContent`) === '1/3', 'fases: marcar suma al contador');
  await ev(`(() => { db.routines[1].days[1].warmup.items = [{ name: 'Bicicleta fija', sets: 1, reps: '10 min' }]; db.current = null; save(); })()`);
  await ev('startSession(db.routines[1].days[1].id)'); await sleep(300);
  ok(await ev(`[...document.querySelectorAll('.phase')[0].querySelectorAll('.wu-row > span')].map(s => s.textContent.trim()).join(' | ')`) === '10 min Bicicleta fija'
    && !(await ev(`[...document.querySelectorAll('.phase')].some(p => p.textContent.includes('Isquios'))`)), 'fases: cada día usa su entrada en calor y su elongación');
  await ev(`db.current = null; save()`); await go('routines');
  await click('[data-act=edit-routine]'); await sleep(150);
  ok(await ev(`document.querySelector('[data-p="days.0.warmup.items.0.sets"]').value`) === '2', 'editor: los ítems de la entrada en calor tienen series');
  await click('[data-act=ed-add-item][data-phase=warmup][data-d="0"]');
  ok(await ev('db.draft.days[0].warmup.items.length === 5 && db.draft.days[0].warmup.items[4].sets === 2'), 'editor: "+ ítem" copia las series del anterior');
  await click('[data-act=ed-move][data-p="days.0.warmup.items.1"][data-dir="-1"]');
  ok(await ev('db.draft.days[0].warmup.items[0].name') === 'Ranas a 1 pierna', 'editor: los ítems se pueden reordenar');
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

  /* ---------- 8. Selector de ejercicios por músculo ---------- */
  const tap = sel => ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`).then(() => sleep(150));
  await go('routines');
  await click('[data-act=edit-routine]'); await sleep(150);
  const nEx = await ev('db.draft.days[0].ex.length');
  await click('[data-act=ed-add-ex][data-d="0"]');
  ok(await ev(`!!document.querySelector('.sheet.xp') && document.querySelectorAll('.sheet.xp svg.body').length === 2`), 'selector: "+ ejercicio" abre la figura (frente y espalda)');
  ok(await ev(`db.draft.days[0].ex.length`) === nEx + 1, 'selector: la fila nueva ya está agregada');
  ok(await ev(`[...new Set([...document.querySelectorAll('.sheet.xp [data-g]')].map(p => p.dataset.g))].filter(g => MUSCLES.some(m => m.id === g)).length`) === 15,
    'selector: los 15 grupos musculares se pueden tocar');
  ok(await ev(`MUSCLES.every(m => m.ex.every(n => EXERCISES.includes(n))) && EXERCISES.length === new Set(EXERCISES.map(exKey)).size`), 'selector: la lista curada incluye todos los ejercicios de los grupos, sin repetir');
  ok(await ev(`[...document.querySelectorAll('.sheet.xp .chip')].map(c => c.textContent).join(',')`) === 'Tus ejercicios,Cardio,Movilidad y elongación', 'selector: atajos para ejercicios');
  await shot('08-selector', 'pantalla');
  await tap('.sheet.xp path[data-g=cuadriceps]');
  ok(await ev(`document.querySelector('#xp-title').textContent`) === 'Cuádriceps', 'selector: tocar un músculo muestra su lista');
  ok(await ev(`[...document.querySelectorAll('[data-act=xp-pick]')].map(b => b.dataset.name).includes('Sentadilla copa')`), 'selector: la lista tiene los ejercicios del músculo');
  ok(await ev(`document.querySelector('[data-act=xp-pick][data-name="Sentadilla copa"] .row-meta')?.textContent`) === 'Último: 27 kg × 8', 'selector: muestra lo último que hiciste');
  await shot('09-selector-lista', 'pantalla');
  await click('[data-act=xp-back]');
  ok(await ev(`document.querySelectorAll('.sheet.xp path.mz.on[data-g=cuadriceps]').length`) === 2, 'selector: al volver queda resaltado el músculo visto');
  await tap('.sheet.xp path[data-g=pecho]');
  await click('[data-act=xp-pick][data-name="Press inclinado con mancuernas"]');
  ok(await ev(`!document.querySelector('.sheet.xp') && db.draft.days[0].ex[${nEx}].name === 'Press inclinado con mancuernas'`), 'selector: elegir completa el nombre y cierra');
  ok(await ev(`document.querySelector('[data-p="days.0.ex.${nEx}.name"]').value`) === 'Press inclinado con mancuernas', 'selector: el campo muestra el nombre elegido');
  await click(`[data-act=xp-open][data-p="days.0.ex.${nEx}.name"]`);
  ok(await ev(`document.querySelector('#xp-title').textContent`) === 'Pecho', 'selector: con un ejercicio cargado abre directo en su grupo');
  ok(await ev(`document.querySelector('.list-row.next')?.dataset.name`) === 'Press inclinado con mancuernas', 'selector: marca el ejercicio que ya tiene el campo');
  await click('[data-act=xp-back]');
  ok(await ev(`document.querySelectorAll('.sheet.xp path.mz.on[data-g=pecho]').length`) === 2, 'selector: al volver, la figura tiene resaltado ese grupo');
  ok(await ev(`(() => { const m = xpMatch('Press inclinado barra'); return m.g === 'pecho' && m.name === 'Press inclinado con barra'; })()`), 'selector: reconoce nombres escritos distinto (sin "con")');
  ok(await ev(`xpMatch('Curl bíceps mancuerna')?.name === 'Curl de bíceps con mancuernas' && xpMatch('remo hammer neutro')?.name === 'Remo hammer'`), 'selector: sin importar plurales, conectores ni una palabra de más');
  ok(await ev(`xpMatch('Peso muerto rumano').g === 'isquios' && xpMatch('Sentadilla búlgara').g === 'cuadriceps'`), 'selector: si está en varios grupos, elige donde es más común');
  ok(await ev(`xpMatch('Polea alta abierto') === null && xpMatch('') === null`), 'selector: sin coincidencia, abre la figura');
  ok(await ev(`xpMatch('Elongación de isquios', true).g === 'movilidad' && xpMatch('Puente de glúteos', true).g === 'movilidad'`), 'selector: en entrada en calor y elongación busca primero en Movilidad');
  await click('.chip[data-g=propios]');
  ok(await ev(`[...document.querySelectorAll('[data-act=xp-pick]')].map(b => b.dataset.name).includes('Press banca')`), 'selector: "Tus ejercicios" incluye nombres propios');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(150);
  ok(await ev(`!document.querySelector('.sheet.xp')`), 'selector: Escape cierra');
  await click('[data-act=ed-add-item][data-phase=warmup]');
  ok(await ev(`document.querySelector('.sheet.xp .chip')?.dataset.g`) === 'movilidad', 'selector: en la entrada en calor, primero Movilidad y elongación');
  await click('[data-act=xp-type]');
  ok(await ev(`!document.querySelector('.sheet.xp') && document.activeElement?.dataset.p === 'days.0.warmup.items.' + (db.draft.days[0].warmup.items.length - 1) + '.name'`), 'selector: "Escribir el nombre" cierra y deja el cursor en el campo');
  await click(`[data-act=xp-open][data-p="days.0.ex.0.name"]`);
  await click('[data-act=xp-back]');
  await ev(`(() => { const p = document.querySelector('.sheet.xp path[data-g=gemelos][tabindex]'); p.focus(); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`); await sleep(150);
  ok(await ev(`document.querySelector('#xp-title').textContent`) === 'Gemelos', 'selector: con teclado, Enter elige el músculo');
  ok(await ev(`!!document.querySelector('.sheet.xp [data-act=xp-back]') && !!document.querySelector('.sheet.xp [data-act=xp-type]')`), 'selector: en la lista hay Volver y Escribir un nombre nuevo');
  await click('[data-act=xp-close]');
  // Con letra muy grande la hoja entra en la pantalla, y en una lista larga Volver y Cancelar siguen a la vista.
  await ev(`db.settings.fontScale = 1.3; save(); applySettings()`);
  await cmd('Emulation.setDeviceMetricsOverride', { width: 330, height: 640, deviceScaleFactor: 1, mobile: true }); await sleep(300);
  await click(`[data-act=xp-open][data-p="days.0.ex.0.name"]`);
  await click('[data-act=xp-back]'); await sleep(400);   // termina la animación de entrada
  const fits = () => ev(`(() => { const r = document.querySelector('.sheet.xp').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; })()`);
  ok(await fits(), 'selector: con letra muy grande la hoja entra en la pantalla');
  await tap('.sheet.xp path[data-g=dorsales]');
  await ev(`document.querySelector('.sheet.xp').scrollTo(0, 9999)`); await sleep(150);
  ok(await fits() && await ev(`(() => { const s = document.querySelector('.sheet.xp').getBoundingClientRect(), h = document.querySelector('.xp-head').getBoundingClientRect(), f = document.querySelector('.xp-foot').getBoundingClientRect();
    return h.top >= s.top - 1 && h.bottom < s.bottom && f.bottom <= s.bottom + 1 && f.top > s.top; })()`), 'selector: al bajar en la lista, Volver, Cancelar y Escribir siguen a la vista');
  await shot('10-selector-letra-grande', 'pantalla');
  await click('[data-act=xp-close]');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await ev(`db.settings.fontScale = 1; save(); applySettings()`);
  await ev(`db.draft = null; save()`); await go('');

  /* ---------- 9. Exportar e importar una rutina suelta ---------- */
  // Exportar: se captura lo que se iba a descargar.
  await go('routines');
  await ev(`window._dl = null; window.downloadJSON = (data, name) => { window._dl = { data, name }; }`);
  await click('[data-act=export-routine]');
  ok(await ev(`_dl?.name === 'rutina-rutina-de-prueba.json' && _dl.data.type === 'simplegym-rutina' && _dl.data.routine.days.length === 2`), 'exportar rutina: archivo con la rutina');
  ok(await ev(`!('id' in _dl.data.routine) && !('id' in _dl.data.routine.days[0])`), 'exportar rutina: sin ids');
  ok(await ev(`!('warmup' in _dl.data.routine) && _dl.data.routine.days[0].warmup.items.length === 4`), 'exportar rutina: fases dentro de cada día');
  // Importar: se carga un archivo en el input como si lo eligiera el usuario.
  const pick = json => ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(json)}], 'r.json', { type: 'application/json' }));
    const i = document.querySelector('#routine-file'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`).then(() => sleep(300));
  await click('[data-act=new-menu]'); await sleep(150);
  ok(await ev(`!!document.querySelector('.sheet [data-act=import-routine]') && !!document.querySelector('#routine-file')`), 'importar rutina: opción en el menú');
  await ev(`document.querySelector('#routine-file').click = () => {}`);   // sin diálogo de archivos en la prueba
  await click('.sheet [data-act=import-routine]'); await sleep(150);
  ok(await ev(`!document.querySelector('.sheet')`), 'importar rutina: el menú se cierra al elegir');
  await pick('no es json');
  ok(await ev(`document.querySelector('#toast').textContent === 'Archivo no válido' && location.hash === '#routines'`), 'importar rutina: archivo inválido avisa');
  await pick(await ev('JSON.stringify(db)'));
  ok(await ev(`document.querySelector('#toast').textContent.includes('Configuración')`), 'importar rutina: una copia completa indica dónde importarla');
  const nR = await ev('db.routines.length');
  await pick(await ev('JSON.stringify(_dl.data)'));
  ok(await ev(`location.hash === '#edit' && db.draft.name === 'Rutina de prueba' && !db.draft.draftOf && db.draft.days[1].ex.length === 6 && db.draft.days[0].warmup.items[1].name === 'Ranas a 1 pierna'`), 'importar rutina: se abre en el editor como nueva');
  await ev(`db.draft = null; save()`); await go('routines');
  // Rutina sola, con la entrada en calor en el formato viejo (texto libre y vueltas).
  await pick(JSON.stringify({ name: 'Vieja', warmup: { rounds: 2, items: ['10 × Ranas'] }, days: [{ name: 'Día 1', ex: [{ name: 'Remo', sets: 4, reps: '8' }] }] }));
  ok(await ev(`db.draft?.name === 'Vieja' && JSON.stringify(db.draft.days[0].warmup.items[0]) === '{"name":"Ranas","sets":2,"reps":"10"}' && db.draft.days[0].cooldown.items.length === 0`),
    'importar rutina: acepta la rutina sola y convierte la entrada en calor vieja');
  await click('.primary[data-act=ed-save]'); await sleep(300);
  ok(await ev(`db.routines.length === ${nR} + 1 && db.routines.at(-1).days[0].ex[0].sets === 4`), 'importar rutina: al guardar queda agregada');
  await go('');

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
