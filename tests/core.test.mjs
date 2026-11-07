import test from 'node:test';
import assert from 'node:assert/strict';
import { closestCommand, editDistance, explain, stoppedAt, visibleDiagnostics } from '../src/explain.js';
import { bibKeys, blankComments, collectKeys, lintSource } from '../src/lint.js';
import { buildOutline, wordCount } from '../src/outline.js';
import { createBuilder } from '../src/build.js';
import { memoryStore } from '../src/storage.js';
import { createProject, findMain, listFiles, listProjects, readSettings } from '../src/project.js';

test('an unknown command gets a one-click fix when it is a near typo', () => {
  const source = 'a \\citep{x} b \\citep{y}\nc \\cietp{z}\n';
  const log = '! Undefined control sequence.\nl.2 c \\cietp\n              {z}\n';
  assert.equal(stoppedAt(log, 2), '\\cietp');
  const result = explain({ severity:'error', kind:'tex', line:2, message:'Undefined control sequence.' }, { log, source });
  assert.equal(result.token, '\\cietp');
  assert.equal(result.suggestion, '\\citep');
  assert.match(result.explanation, /uses 2 times/);
});

test('a suggestion is never the token itself, and a package command needs the paper to use it', () => {
  assert.equal(closestCommand('\\section', '')?.name === '\\section', false);
  assert.equal(closestCommand('\\cietp', '').name, '\\cite');
});

test('no suggestion when the token is not on the failing line, or nothing is close', () => {
  const log = '! Undefined control sequence.\nl.1 \\zzqqyy\n';
  const result = explain({ kind:'tex', line:1, message:'Undefined control sequence.' }, { log, source:'\\zzqqyy\n' });
  assert.equal(result.suggestion, undefined);
  assert.equal(closestCommand('\\ab', ''), null);
  assert.equal(editDistance('ab', 'ba'), 1);
});

test('known messages read plainly, unknown ones stay as TeX wrote them', () => {
  assert.equal(explain({ kind:'tex', message:'Missing $ inserted.' }).headline, 'Math outside math mode');
  assert.equal(explain({ kind:'tex', message:'Something rare' }).headline, 'Something rare');
  assert.match(explain({ kind:'missing-file', name:'x.sty', message:'x.sty is not in your project' }).headline, /x\.sty/);
});

test('the closing lines and repeats of one error are hidden', () => {
  const error = { severity:'error', file:'a', line:1, message:'Bad' };
  assert.equal(visibleDiagnostics([error, { ...error }, { ...error, message:'==> Fatal error occurred' }, { ...error, message:'Emergency stop.' }, { ...error, severity:'warning', message:'Shell escape feature is not enabled.' }]).length, 1);
  assert.equal(visibleDiagnostics([{ severity:'warning', message:'W' }, error])[0], error);
});

test('the linter finds unclosed and mismatched environments', () => {
  assert.match(lintSource('\\begin{figure}\n')[0].message, /never closed/);
  assert.match(lintSource('\\begin{a}\\end{b}')[0].message, /closes/);
  assert.match(lintSource('\\end{a}')[0].message, /no \\begin/);
  assert.deepEqual(lintSource('\\begin{verbatim}\\begin{x}\\end{verbatim}'), []);
  assert.deepEqual(lintSource('%novalidate\n\\begin{a}\n%validate\n'), []);
});

test('the linter checks keys against the whole project, and ignores comments', () => {
  const project = { labels:new Set(['a']), bibKeys:new Set(['k']), hasBib:true, files:new Set(['main.tex', 'sec/one.tex']) };
  const found = lintSource('\\ref{a} \\ref{b} \\cite{k, m} \\input{sec/one} \\input{two} % \\ref{c}\n', project, 'main.tex');
  assert.deepEqual(found.map(item => item.message), ['No \\label{b} in this project.', 'No entry m in the bibliography.', 'two.tex is not in this project.']);
  const source = '\\cite{k, m}';
  const cite = collectKeys(source).cites[1];
  assert.equal(source.slice(cite.from, cite.to), 'm');
  assert.equal(blankComments('a % b').length, 5);
  assert.equal(blankComments('100\\% sure'), '100\\% sure');
  assert.match(lintSource('\\label{a}\\label{a}')[0].message, /more than once/);
});

test('bibliography keys skip @comment and @string', () => {
  assert.deepEqual(bibKeys('@article{a,\n}\n@string{b = "c"}\n@comment{d,\n}\n@BOOK{e ,\n}'), ['a', 'e']);
});

test('the outline follows \\input once and survives a cycle', () => {
  const files = { 'main.tex':'\\section{One}\n\\input{b}\n% \\section{No}\n', 'b.tex':'\\subsection*{Two}\n\\input{main}\n' };
  const items = buildOutline(path => files[path] ?? null, 'main.tex');
  assert.deepEqual(items.map(item => [item.title, item.level, item.file, item.line]), [['One', 2, 'main.tex', 1], ['Two', 3, 'b.tex', 1]]);
});

test('word count leaves out the preamble, commands and math', () => {
  assert.equal(wordCount('\\title{Not this}\\begin{document}\nTwo \\emph{words} $x+y$ here \\cite{k}\n\\end{document}'), 3);
});

test('requests during a build merge into one more build', async () => {
  const seen = [], states = [];
  let release;
  const builder = createBuilder({
    compile:revision => { seen.push(revision); return new Promise(resolve => { release = () => resolve({ ok:true }); }); },
    onState:state => states.push(state),
  });
  builder.request(1);
  builder.request(2);
  builder.request(3);
  release();
  await new Promise(resolve => setTimeout(resolve));
  release();
  await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(seen, [1, 3]);
  const done = states.filter(state => state.phase === 'done');
  assert.deepEqual(done.map(state => state.stale), [true, false]);
  assert.equal(builder.running, false);
});

test('a failed build reports and the builder keeps working', async () => {
  const states = [];
  const builder = createBuilder({ compile:async () => { throw new Error('no'); }, onState:state => states.push(state) });
  builder.request(1);
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(states.at(-1).phase, 'failed');
  assert.equal(builder.running, false);
});

test('projects are created once, and hidden files stay out of the tree', async () => {
  const store = memoryStore();
  assert.deepEqual(await listProjects(store), []);
  const name = await createProject(store, ' My/Paper ');
  assert.equal(name, 'My-Paper');
  await assert.rejects(createProject(store, 'My-Paper'), /already exists/);
  await store.write('projects/My-Paper/.tex-build/main.pdf', 'x');
  await store.write('projects/My-Paper/fig/a.png', 'x');
  assert.deepEqual(await listProjects(store), ['My-Paper']);
  assert.deepEqual(await listFiles(store, 'My-Paper'), ['fig/a.png', 'main.tex', 'references.bib']);
  assert.equal((await readSettings(store, 'My-Paper')).main, 'main.tex');
});

test('the main file is the one with \\documentclass', () => {
  assert.equal(findMain(['a.tex', 'paper.tex'], { 'a.tex':'text', 'paper.tex':'\\documentclass{x}' }), 'paper.tex');
  assert.equal(findMain(['b.tex', 'main.tex'], { 'b.tex':'\\documentclass{x}', 'main.tex':'\\documentclass{x}' }), 'main.tex');
});
