// Scribella's page: wires storage, the editor, builds and the PDF pane. Writing works everywhere; compiling needs the
// NakliOS TeX service, because the engine lives there.
import { browserStore, hostStore } from './storage.js';
import { TEMPLATES, cleanFilePath, createProject, findMain, isImage, isText, listFiles, listProjects, projectFolder, readSettings, safeName, writeSettings } from './project.js';
import { createBuilder } from './build.js';
import { createEditor } from './editor.js';
import { createPdfView } from './pdf-view.js';
import { explain, visibleDiagnostics } from './explain.js';
import { bibKeys, collectKeys } from './lint.js';
import { buildOutline, wordCount } from './outline.js';
import { findAll, findTodos, replaceAllIn } from './search.js';
import { SYMBOLS, figureBlock, needsBooktabs, parseTable, slug, tableBlock } from './insert.js';
import { makeZip, readZip } from './zip.js';

const AUTOSAVE_MS = 1200;
const OUTSIDE_EDIT_MS = 1500;
const OWN_WRITE_MS = 4000;
const KEYS_ITEM = 'scribella.keys';
const $ = id => document.getElementById(id);
const naklios = window.naklios;
const hosted = () => !!(naklios?.capabilities?.hosted && naklios.capabilities.fs);
const canCompile = () => storeKind === 'host' && naklios.capabilities.experimental_tex === true;
const COMPILE_HINT = () => (naklios?.capabilities?.hosted
  ? 'Writing works here. To compile, connect a Folder or Crate in NakliOS Settings.'
  : 'Writing works here. To compile, open Scribella inside NakliOS, where the TeX engine runs.');

let store = null, storeKind = null;
const state = { project:null, settings:{}, files:[], texts:{}, path:null, dirty:false, revision:0, problems:[], log:'', job:null, auto:true };
let saveTimer = null, outsideTimer = null, stopWatching = null;
const ownWrites = new Map();
const readKeys = () => { try { return localStorage.getItem(KEYS_ITEM) || 'default'; } catch (_) { return 'default'; } };

const say = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const pdf = createPdfView($('pdf'), { onPages:pages => { $('pages').textContent = `${pages} ${pages === 1 ? 'page' : 'pages'}`; } });

function projectIndex() {
  const labels = new Set(), keys = new Set(), macros = new Set();
  let hasBib = false;
  for (const [path, text] of Object.entries(state.texts)) {
    if (/\.bib$/i.test(path)) { hasBib = true; bibKeys(text).forEach(key => keys.add(key)); }
    if (/\.(tex|ltx)$/i.test(path)) {
      collectKeys(text).labels.forEach(label => labels.add(label.key));
      for (const [, name] of text.matchAll(/\\(?:re)?newcommand\*?\{?\\([A-Za-z@]+)/g)) macros.add(name);
    }
  }
  return { labels, bibKeys:keys, hasBib, files:new Set(state.files), macros };
}

const editor = createEditor($('editor'), {
  path:() => state.path || '',
  project:projectIndex,
  keys:readKeys(),
  onDrop:(files, at) => dropFiles(files, at).catch(fail),
  onSave:() => saveNow().then(() => state.project && build()),
  onChange() {
    state.dirty = true;
    state.texts[state.path] = editor.text;
    state.revision += 1;
    showCounts();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow().then(() => { if (state.auto) build(); }), AUTOSAVE_MS);
  },
});

const fullPath = path => `${projectFolder(state.project)}/${path}`;

function writeFile(path, data) {
  ownWrites.set(path, Date.now());
  return store.write(fullPath(path), data);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.dirty || !state.path) return;
  state.dirty = false;
  try {
    await writeFile(state.path, state.texts[state.path]);
  } catch (error) {
    state.dirty = true;
    say(`Saving failed: ${error.message}`, true);
    throw error;
  }
}

function showCounts() {
  const main = state.texts[state.settings.main];
  $('words').textContent = main ? `About ${wordCount(main).toLocaleString('en')} words` : '';
  renderOutline();
}

function renderTree() {
  $('files').replaceChildren(...state.files.map(path => {
    const row = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'row';
    open.dataset.command = 'open-file';
    open.textContent = path;
    open.title = path;
    open.setAttribute('aria-current', path === state.path ? 'true' : 'false');
    open.addEventListener('click', () => openFile(path).catch(fail));
    row.append(open);
    return row;
  }));
  const texFiles = state.files.filter(path => /\.(tex|ltx)$/i.test(path));
  $('main-file').replaceChildren(...texFiles.map(path => new Option(path, path, false, path === state.settings.main)));
  $('engine').value = state.settings.engine || 'pdflatex';
}

function renderOutline() {
  const items = state.settings.main ? buildOutline(path => state.texts[path] ?? null, state.settings.main) : [];
  $('outline').replaceChildren(...items.map(item => {
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'row';
    go.dataset.command = 'outline-item';
    go.style.paddingLeft = `${8 + Math.max(0, item.level - 2) * 12}px`;
    go.textContent = item.title;
    go.addEventListener('click', () => jump(item.file, item.line).catch(fail));
    row.append(go);
    return row;
  }));
}

async function jump(path, line, token) {
  if (path !== state.path && state.files.includes(path)) await openFile(path);
  if (line) editor.goToLine(line, token);
}

function renderProblems() {
  const list = state.problems;
  const errors = list.filter(item => item.severity === 'error').length;
  $('problem-count').textContent = list.length ? `${errors} ${errors === 1 ? 'error' : 'errors'}, ${list.length - errors} ${list.length - errors === 1 ? 'warning' : 'warnings'}` : 'No problems';
  $('problems').replaceChildren(...list.map(item => {
    const row = document.createElement('li');
    row.className = item.severity;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'problem';
    go.dataset.command = 'problem';
    const title = document.createElement('strong');
    title.textContent = item.headline;
    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = item.line ? `${item.file}:${item.line}` : item.file || '';
    go.append(title, place);
    if (item.explanation) {
      const words = document.createElement('p');
      words.textContent = item.explanation;
      go.append(words);
    }
    go.addEventListener('click', () => jump(item.file, item.line, item.token).catch(fail));
    row.append(go);
    if (item.engine && item.engine !== state.settings.engine) {
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'btn small';
      change.dataset.command = 'apply-fix';
      change.textContent = 'Switch to XeLaTeX';
      change.addEventListener('click', () => changeSettings({ engine:item.engine }).then(renderTree).catch(fail));
      row.append(change);
    }
    if (item.suggestion) {
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'btn small';
      fix.dataset.command = 'apply-fix';
      fix.textContent = `Replace with ${item.suggestion}`;
      fix.addEventListener('click', () => applyFix(item).catch(fail));
      row.append(fix);
    }
    return row;
  }));
}

async function applyFix(item) {
  await jump(item.file, item.line);
  if (!editor.replaceOnLine(item.line, item.token, item.suggestion)) say(`Line ${item.line} no longer holds ${item.token}.`, true);
}

async function compile() {
  await saveNow();
  $('build').hidden = true;
  $('cancel').hidden = false;
  state.job = naklios.experimental_tex.compile({
    folder:projectFolder(state.project),
    main:state.settings.main,
    engine:state.settings.engine || 'pdflatex',
    onChunk(chunk) {
      if (chunk.kind !== 'progress') return;
      if (chunk.stage === 'download') say(`Downloading TeX Live, once for this browser: ${Math.round(chunk.percent || 0)}%`);
      else say({ queued:'Waiting for TeX…', reading:'Reading the project…', compiling:'Compiling…', writing:'Saving the build…' }[chunk.stage] || 'Working…');
    },
  });
  try { return await state.job; } finally { state.job = null; }
}

async function afterBuild({ result, stale }) {
  const log = result.log ? await store.read(result.log).catch(() => '') : '';
  state.log = log;
  state.problems = visibleDiagnostics(result.diagnostics).map(item => ({ ...item, ...explain(item, { log, source:state.texts[item.file] || '' }) }));
  renderProblems();
  if (result.pdf && result.ok) await pdf.show(await store.readBinary(result.pdf));
  const errors = state.problems.filter(item => item.severity === 'error').length;
  if (result.ok) say(stale ? 'Built. More edits are waiting.' : 'Built.');
  else say(pdf.pages ? `TeX stopped with ${errors} ${errors === 1 ? 'error' : 'errors'}. The last good PDF stays on screen.` : `TeX stopped with ${errors} ${errors === 1 ? 'error' : 'errors'}.`, true);
}

const builder = createBuilder({
  compile,
  onState(update) {
    if (update.phase === 'building') { document.body.dataset.building = 'true'; return; }
    if (!builder.running || update.phase === 'done' || update.phase === 'failed') { $('build').hidden = false; $('cancel').hidden = true; delete document.body.dataset.building; }
    if (update.phase === 'done') afterBuild(update).catch(fail);
    if (update.phase === 'failed' && update.error?.code !== 'ECANCELED' && !/ECANCELED/.test(update.error?.message || '')) say(`The build did not run: ${update.error.message}`, true);
    else if (update.phase === 'failed') say('Build stopped.');
  },
});

function build() {
  if (!state.project || !state.settings.main) return;
  if (!canCompile()) { say(COMPILE_HINT()); return; }
  builder.request(state.revision);
}

async function openFile(path) {
  await saveNow();
  state.path = path;
  $('file-name').textContent = path;
  const text = isText(path);
  $('editor').hidden = !text;
  $('not-text').hidden = text;
  if (text) {
    state.texts[path] ??= await store.read(fullPath(path));
    editor.load(state.texts[path]);
  }
  renderTree();
}

// Edits from outside the page, such as an agent or another tab, reach the editor and start a build.
async function outsideChange(event) {
  const root = `${projectFolder(state.project)}/`;
  const path = event.path?.startsWith(root) ? event.path.slice(root.length) : event.path;
  if (!path || path.split('/').some(part => part.startsWith('.'))) return;
  if (Date.now() - (ownWrites.get(path) ?? 0) < OWN_WRITE_MS) return;
  state.files = await listFiles(store, state.project);
  if (state.files.includes(path) && isText(path)) {
    state.texts[path] = await store.read(fullPath(path));
    if (path === state.path && !state.dirty) editor.load(state.texts[path]);
  } else if (!state.files.includes(path)) delete state.texts[path];
  renderTree();
  showCounts();
  state.revision += 1;
  clearTimeout(outsideTimer);
  outsideTimer = setTimeout(() => { if (state.auto) build(); }, OUTSIDE_EDIT_MS);
}

async function watchProject(name) {
  stopWatching?.();
  stopWatching = null;
  if (storeKind !== 'host' || !naklios.fs.subscribe) return;
  stopWatching = await naklios.fs.subscribe(projectFolder(name), event => { outsideChange(event).catch(fail); });
}

async function openProject(name) {
  await saveNow();
  pdf.clear();
  $('pages').textContent = '';
  state.project = name;
  state.settings = await readSettings(store, name);
  state.files = await listFiles(store, name);
  state.texts = {};
  for (const path of state.files.filter(isText)) state.texts[path] = await store.read(fullPath(path));
  state.settings.main = state.files.includes(state.settings.main) ? state.settings.main : findMain(state.files, state.texts);
  state.problems = [];
  renderProblems();
  document.body.dataset.view = 'project';
  $('project-name').textContent = name;
  naklios?.title?.(`${name} — Scribella`);
  document.title = `${name} — Scribella`;
  await openFile(state.settings.main || state.files[0]);
  showCounts();
  await watchProject(name).catch(error => console.error('Watching the project failed', error));
  const last = state.settings.main && `${projectFolder(name)}/.tex-build/${state.settings.main.replace(/^.*\//, '').replace(/\.[^.]+$/, '')}.pdf`;
  if (last && await store.exists(last)) await pdf.show(await store.readBinary(last));
  say(canCompile() ? 'Ready.' : COMPILE_HINT());
}

async function renderHome() {
  document.body.dataset.view = 'home';
  const names = await listProjects(store);
  $('projects').replaceChildren(...names.map(name => {
    const row = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'row';
    open.dataset.command = 'open-project';
    open.textContent = name;
    open.addEventListener('click', () => openProject(name).catch(fail));
    row.append(open);
    return row;
  }));
  $('no-projects').hidden = names.length > 0;
  $('where').textContent = storeKind === 'host' ? 'Projects live in your NakliOS storage.' : 'Projects live in this browser only.';
}

function fail(error) {
  console.error(error);
  say(error.message || String(error), true);
}

async function changeSettings(change) {
  Object.assign(state.settings, change);
  await writeSettings(store, state.project, state.settings);
  showCounts();
  build();
}

async function newFile() {
  const path = cleanFilePath($('new-file-name').value);
  if (state.files.includes(path)) throw new Error(`${path} already exists.`);
  await writeFile(path, '');
  state.files = await listFiles(store, state.project);
  state.texts[path] = '';
  $('new-file-name').value = '';
  $('new-file-form').hidden = true;
  await openFile(path);
}

async function deleteFile() {
  if (!state.path || !confirm(`Delete ${state.path}? This cannot be undone.`)) return;
  const gone = state.path;
  state.dirty = false;
  await store.remove(fullPath(gone));
  delete state.texts[gone];
  state.files = await listFiles(store, state.project);
  state.path = null;
  await openFile(state.settings.main && state.files.includes(state.settings.main) ? state.settings.main : state.files[0]);
}

async function renameFile(from, to) {
  const path = cleanFilePath(to);
  if (state.files.includes(path)) throw new Error(`${path} already exists.`);
  await saveNow();
  await writeFile(path, await store.readBinary(fullPath(from)));
  ownWrites.set(from, Date.now());
  await store.remove(fullPath(from));
  if (from in state.texts) { state.texts[path] = state.texts[from]; delete state.texts[from]; }
  state.files = await listFiles(store, state.project);
  if (state.settings.main === from) await changeSettings({ main:path });
  if (state.path === from) state.path = null;
  await openFile(state.path || path);
  return path;
}

async function addFiles(files, folder = '') {
  const added = [];
  for (const file of files) {
    const path = cleanFilePath(folder + file.name.replace(/[\\/]/g, '-'));
    await writeFile(path, new Uint8Array(await file.arrayBuffer()));
    if (isText(path)) state.texts[path] = await file.text();
    added.push(path);
  }
  state.files = await listFiles(store, state.project);
  renderTree();
  showCounts();
  return added;
}

async function dropFiles(files, at) {
  const images = files.filter(file => isImage(file.name)), others = files.filter(file => !isImage(file.name));
  for (const path of await addFiles(images, 'figures/')) editor.insert(figureBlock({ path }), at);
  if (others.length) await addFiles(others);
}

async function exportProject() {
  await saveNow();
  const files = await Promise.all(state.files.map(async path => ({ path, bytes:await store.readBinary(fullPath(path)) })));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([makeZip(files)], { type:'application/zip' }));
  link.download = `${safeName(state.project)}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  say(`Exported ${files.length} files.`);
}

async function importProject(file) {
  const files = readZip(new Uint8Array(await file.arrayBuffer()));
  if (!files.length) throw new Error('This zip holds no files.');
  const name = safeName(file.name.replace(/\.zip$/i, '')) || 'Imported';
  const existing = await listProjects(store);
  let unique = name;
  for (let copy = 2; existing.includes(unique); copy += 1) unique = `${name} ${copy}`;
  for (const { path, bytes } of files) await store.write(`${projectFolder(unique)}/${path}`, bytes);
  await writeSettings(store, unique, { engine:'pdflatex' });
  await openProject(unique);
}

const searchOptions = () => ({ regex:$('search-regex').checked, matchCase:$('search-case').checked });

function showMatches(matches) {
  $('search-count').textContent = `${matches.length}${matches.length >= 500 ? '+' : ''} ${matches.length === 1 ? 'match' : 'matches'}`;
  $('search-results').replaceChildren(...matches.map(item => {
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'row';
    go.dataset.command = 'search-result';
    go.title = item.text;
    go.textContent = `${item.file}:${item.line} ${item.text}`;
    go.addEventListener('click', () => jump(item.file, item.line, item.match).catch(fail));
    row.append(go);
    return row;
  }));
}

function runSearch() {
  try { showMatches(findAll(state.texts, $('search-query').value, searchOptions())); }
  catch (error) { $('search-count').textContent = `Bad pattern: ${error.message}`; }
}

async function replaceEverywhere(query, replacement, options) {
  let total = 0;
  for (const path of Object.keys(state.texts)) {
    const { text, count } = replaceAllIn(state.texts[path], query, replacement, options);
    if (!count) continue;
    total += count;
    state.texts[path] = text;
    await writeFile(path, text);
    if (path === state.path) editor.load(text);
  }
  state.revision += 1;
  showCounts();
  if (total && state.auto) build();
  return total;
}

function openPalette() {
  const filter = $('symbol-filter').value.trim().toLowerCase();
  $('symbols').replaceChildren(...SYMBOLS.flatMap(({ group, names }) => {
    const shown = names.filter(name => name.toLowerCase().includes(filter));
    if (!shown.length) return [];
    const heading = document.createElement('h2');
    heading.textContent = group;
    return [heading, ...shown.map(name => {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'btn small';
      pick.dataset.command = 'insert-symbol';
      pick.textContent = `\\${name}`;
      pick.addEventListener('click', () => { $('palette-dialog').close(); editor.insert(`\\${name}`); });
      return pick;
    })];
  }));
}

async function insertTable() {
  const rows = parseTable($('table-data').value);
  if (!rows.length) throw new Error('Paste some rows first.');
  const caption = $('table-caption').value.trim();
  editor.insert(tableBlock(rows, { caption, label:slug(caption || 'table') }));
  $('table-dialog').close();
  if (needsBooktabs(state.texts[state.settings.main] || '')) say('Add \\usepackage{booktabs} to the preamble for this table.', true);
}

function bindPage() {
  for (const [id, template] of Object.entries(TEMPLATES)) $('template').append(new Option(template.label, id));
  $('new-project').addEventListener('submit', event => {
    event.preventDefault();
    createProject(store, $('project-title').value, $('template').value).then(openProject).catch(fail);
  });
  $('home').addEventListener('click', () => saveNow().then(() => { stopWatching?.(); stopWatching = null; state.project = null; state.path = null; return chooseStore(); }).then(renderHome).catch(fail));
  $('build').addEventListener('click', () => saveNow().then(build).catch(fail));
  $('cancel').addEventListener('click', () => { if (state.job) naklios.experimental_tex.cancel(state.job.id); });
  $('auto').addEventListener('change', event => { state.auto = event.target.checked; });
  $('engine').addEventListener('change', event => changeSettings({ engine:event.target.value }).catch(fail));
  $('main-file').addEventListener('change', event => changeSettings({ main:event.target.value }).catch(fail));
  $('zoom-in').addEventListener('click', () => pdf.zoomBy(0.2));
  $('zoom-out').addEventListener('click', () => pdf.zoomBy(-0.2));
  $('add-file').addEventListener('click', () => { $('new-file-form').hidden = false; $('new-file-name').focus(); });
  $('new-file-form').addEventListener('submit', event => { event.preventDefault(); newFile().catch(fail); });
  $('delete-file').addEventListener('click', () => deleteFile().catch(fail));
  $('rename-file').addEventListener('click', () => {
    const next = prompt('New file name', state.path);
    if (next && next !== state.path) renameFile(state.path, next).catch(fail);
  });
  $('add-files').addEventListener('change', event => { addFiles([...event.target.files]).catch(fail); event.target.value = ''; });
  $('export').addEventListener('click', () => exportProject().catch(fail));
  $('import-zip').addEventListener('change', event => { const [file] = event.target.files; event.target.value = ''; if (file) importProject(file).catch(fail); });
  $('search-query').addEventListener('input', runSearch);
  $('search-regex').addEventListener('change', runSearch);
  $('search-case').addEventListener('change', runSearch);
  $('search-todos').addEventListener('click', () => showMatches(findTodos(state.texts)));
  $('replace-all').addEventListener('click', () => {
    const query = $('search-query').value, matches = findAll(state.texts, query, searchOptions());
    if (!matches.length || !confirm(`Replace ${matches.length} matches across the project?`)) return;
    replaceEverywhere(query, $('search-replace').value, searchOptions()).then(count => { say(`Replaced ${count}.`); runSearch(); }).catch(fail);
  });
  $('insert').addEventListener('change', event => {
    const pick = event.target.value;
    event.target.value = '';
    if (pick === 'table') $('table-dialog').showModal();
    if (pick === 'symbol') { openPalette(); $('palette-dialog').showModal(); }
    if (pick === 'figure') $('figure-file').click();
  });
  $('figure-file').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; dropFiles(files, editor.view.state.selection.main.head).catch(fail); });
  $('symbol-filter').addEventListener('input', openPalette);
  $('table-form').addEventListener('submit', event => { event.preventDefault(); insertTable().catch(fail); });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
  $('keys').value = readKeys();
  $('keys').addEventListener('change', event => {
    editor.setKeys(event.target.value);
    try { localStorage.setItem(KEYS_ITEM, event.target.value); } catch (_) {}
  });
  addEventListener('pagehide', () => { saveNow().catch(() => {}); });
}

const commands = {
  'projects.list':() => listProjects(store),
  'project.open':({ name }) => openProject(name).then(() => ({ opened:name })),
  'project.create':({ name, template }) => createProject(store, name, template).then(openProject).then(() => ({ opened:state.project })),
  'files.list':() => state.files,
  'file.read':({ path }) => state.texts[path] ?? store.read(fullPath(path)),
  async 'file.write'({ path, text }) {
    await writeFile(path, text);
    state.texts[path] = text;
    state.files = await listFiles(store, state.project);
    if (path === state.path) editor.load(text);
    renderTree();
    showCounts();
    return { written:path };
  },
  async 'build.run'() {
    if (!canCompile()) throw new Error('Compiling needs the NakliOS TeX service.');
    const result = await compile();
    await afterBuild({ result, stale:false });
    $('build').hidden = false; $('cancel').hidden = true;
    return { ok:result.ok, problems:state.problems.map(({ severity, file, line, headline, explanation }) => ({ severity, file, line, headline, explanation })) };
  },
  async 'file.rename'({ from, to }) { return { renamed:await renameFile(from, to) }; },
  'search.find':({ query, regex, matchCase }) => findAll(state.texts, query, { regex, matchCase }),
  'search.todos':() => findTodos(state.texts),
  async 'search.replace'({ query, replacement, regex, matchCase }) { return { replaced:await replaceEverywhere(query, replacement, { regex, matchCase }) }; },
  'problems.list':() => state.problems.map(({ severity, file, line, headline, explanation, suggestion }) => ({ severity, file, line, headline, explanation, suggestion })),
};

async function registerCommands() {
  const manifest = await (await fetch('./commands.json')).json();
  naklios?.experimental_commands?.register?.(manifest.commands.map(command => ({ ...command, name:`scribella.${command.name}`, handler:commands[command.name] })));
}

// TeX reads NakliOS storage, so a project must live there to compile. The host's capabilities can arrive after the page
// starts, so the choice is made again whenever they change, while no project is open.
async function chooseStore() {
  const kind = hosted() ? 'host' : 'browser';
  if (kind === storeKind || state.project) return;
  storeKind = kind;
  store = kind === 'host' ? hostStore(naklios.fs) : browserStore();
  await renderHome();
}

async function start() {
  bindPage();
  window.scribella = { commands, state };
  naklios?.ready?.();
  await chooseStore();
  naklios?.onCapabilitiesChange?.(() => { chooseStore().catch(fail); });
  await registerCommands().catch(error => console.error('Commands failed to register', error));
}

// Inside NakliOS the capabilities arrive after load, so the first read waits for them briefly.
const hostedFrame = window.parent !== window;
let started = false;
const go = () => { if (!started) { started = true; start().catch(fail); } };
if (hostedFrame && naklios?.onCapabilitiesChange) {
  naklios.onCapabilitiesChange(() => { if (naklios.capabilities.hosted) go(); });
  setTimeout(go, 1500);
} else go();
