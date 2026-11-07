import test from 'node:test';
import assert from 'node:assert/strict';
import { closestCommand, editDistance, explain, stoppedAt, visibleDiagnostics } from '../src/explain.js';
import { bibKeys, blankComments, collectKeys, lintSource } from '../src/lint.js';
import { buildOutline, wordCount } from '../src/outline.js';
import { createBuilder } from '../src/build.js';
import { memoryStore } from '../src/storage.js';
import { findAll, findTodos, replaceAllIn } from '../src/search.js';
import { escapeText, figureBlock, needsBooktabs, parseTable, tableBlock } from '../src/insert.js';
import { makeZip, readZip } from '../src/zip.js';
import { forward, inverse, parseSynctex } from '../src/synctex.js';
import { diffLists, markChanges } from '../src/changes.js';
import { stripComments, usedFiles } from '../src/arxiv.js';
import { listVersions, readVersion, saveVersion } from '../src/versions.js';
import { readFileSync } from 'node:fs';
import { keepsProtected, protectedSpans } from '../src/protected.js';
import { locate, makeAnchor, parseNotes } from '../src/annotations.js';
import { applyEdits, buildMessages, parseReply, safeResult, wordEdits } from '../src/revise.js';
import { cleanFilePath, loadVenues, createProject, findMain, listFiles, listProjects, readSettings } from '../src/project.js';

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

test('search finds across files, and a bad case filter misses', () => {
  const texts = { 'a.tex':'Hello world\nhello', 'b.tex':'nothing' };
  assert.equal(findAll(texts, 'hello').length, 2);
  assert.equal(findAll(texts, 'hello', { matchCase:true }).length, 1);
  assert.deepEqual(findAll(texts, 'w.r', { regex:true }).map(item => [item.file, item.line, item.column]), [['a.tex', 1, 6]]);
  assert.equal(findAll(texts, 'w.r').length, 0, 'plain search treats dots as dots');
  assert.deepEqual(findAll(texts, ''), []);
});

test('replace counts, and a regex may use groups', () => {
  assert.deepEqual(replaceAllIn('a b a', 'a', '$1'), { text:'$1 b $1', count:2 });
  assert.deepEqual(replaceAllIn('x=1, y=2', '(\\w)=(\\d)', '$2:$1', { regex:true }), { text:'1:x, 2:y', count:2 });
});

test('the TODO scan reads comments and \\todo in TeX files only', () => {
  const found = findTodos({ 'a.tex':'% TODO fix\nplain TODO text\n\\todo{later}\n', 'n.md':'% TODO no' });
  assert.deepEqual(found.map(item => item.line), [1, 3]);
});

test('tables escape cells, right-align numbers and handle quotes and tabs', () => {
  assert.deepEqual(parseTable('a,"b,c"\n1,2\n'), [['a', 'b,c'], ['1', '2']]);
  assert.deepEqual(parseTable('a\tb,c\n'), [['a', 'b,c']]);
  const block = tableBlock([['Name', 'Score'], ['A_1 & co', '50%'], ['B', '7']], { caption:'C', label:'c' });
  assert.match(block, /\{lr\}/);
  assert.ok(block.includes('A\\_1 \\& co & 50\\%'));
  assert.match(block, /\\toprule/);
  assert.equal(needsBooktabs('\\usepackage{a,booktabs}'), false);
  assert.equal(needsBooktabs('\\usepackage{a}'), true);
  assert.match(figureBlock({ path:'figures/My Plot.png' }), /fig:my-plot/);
});

test('zips round trip, lose one top folder, and refuse unsafe paths', () => {
  const bytes = new TextEncoder().encode('x');
  assert.deepEqual(readZip(makeZip([{ path:'paper/main.tex', bytes }, { path:'paper/fig/a.png', bytes }])).map(file => file.path).sort(), ['fig/a.png', 'main.tex']);
  assert.deepEqual(readZip(makeZip([{ path:'main.tex', bytes }, { path:'b/c.tex', bytes }])).map(file => file.path).sort(), ['b/c.tex', 'main.tex']);
  assert.deepEqual(readZip(makeZip([{ path:'main.tex', bytes }, { path:'.git/config', bytes }, { path:'__MACOSX/x', bytes }])).map(file => file.path), ['main.tex']);
  assert.throws(() => readZip(makeZip([{ path:'../evil', bytes }])), /unsafe/);
});

test('file names stay inside the project', () => {
  assert.equal(cleanFilePath(' /a/b.tex '), 'a/b.tex');
  for (const bad of ['', '../x', 'a/.git', 'a//b']) assert.throws(() => cleanFilePath(bad));
});

test('engine advice and letter-case checks', () => {
  assert.equal(explain({ kind:'tex', message:'Fatal Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.' }).engine, 'xelatex');
  assert.equal(explain({ kind:'tex', message:'Unicode character 你 (U+4F60)' }).engine, 'xelatex');
  const project = { labels:new Set(), bibKeys:new Set(), hasBib:false, files:new Set(['Sections/Intro.tex']) };
  assert.match(lintSource('\\input{sections/intro}', project, 'main.tex')[0].message, /letter case/);
});

const SYNC = `SyncTeX Version:1
Input:1:main.tex
Input:2:/texlive/article.cls
Input:3:sections/two.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,1:0,0:30000000,40000000,0
(1,10:6578176,6578176:13156352,657817,131563
h1,11:6578176,7894000:6578176,657817,131563
x1,12:6578176,9000000
k2,5:100,100:50
)
]
}1
{2
(3,4:6578176,6578176:6578176,657817,131563
x3,4:=,=
)
}2
Postamble:
`;

test('SyncTeX: a source line finds its page and box', () => {
  const sync = parseSynctex(SYNC);
  const box = forward(sync, 'main.tex', 11);
  assert.equal(box.page, 1);
  assert.equal(box.line, 11);
  assert.equal(Math.round(box.x), 100);
  assert.equal(forward(sync, 'sections/two.tex', 4).page, 2);
  assert.equal(forward(sync, 'main.tex', 500).line, 12, 'a line past the output falls back to the last line with output');
  assert.equal(forward(sync, 'other.tex', 1), null);
});

test('SyncTeX: a point finds its line, and TeX Live files are skipped', () => {
  const sync = parseSynctex(SYNC);
  assert.deepEqual(inverse(sync, 1, 110, 118), { file:'main.tex', line:11 });
  assert.deepEqual(inverse(sync, 2, 110, 100), { file:'sections/two.tex', line:4 });
  assert.equal(inverse(sync, 9, 1, 1), null);
});

test('special characters are escaped once, in cells and captions', () => {
  assert.equal(escapeText('a\\b_c%'), 'a\\textbackslash{}b\\_c\\%');
  assert.ok(tableBlock([['A'], ['1']], { caption:'50% of a_b' }).includes('\\caption{50\\% of a\\_b}'));
});

test('LuaLaTeX-only packages ask for LuaLaTeX', () => {
  assert.equal(explain({ kind:'tex', message:'Package foo Error: This package requires LuaTeX.' }).engine, 'lualatex');
});

test('versions save, list newest first and read back', async () => {
  const store = memoryStore();
  await saveVersion(store, 'p', { 'a.tex':'one' }, 'First', 1);
  await saveVersion(store, 'p', { 'a.tex':'two' }, 'Second', 2);
  assert.deepEqual((await listVersions(store, 'p')).map(item => item.label), ['Second', 'First']);
  assert.equal((await readVersion(store, 'p', '1'))['a.tex'], 'one');
});

test('changes mark prose and leave hard paragraphs alone', () => {
  assert.deepEqual(diffLists(['a', 'b'], ['a', 'c']).map(edit => edit[0]), ['=', '-', '+']);
  const old = '\\documentclass{article}\n\\begin{document}\n\nThe quick fox.\n\nGone away.\n\n$x=1$ math\n\n\\end{document}';
  const next = '\\documentclass{article}\n\\begin{document}\n\nThe slow fox.\n\n$x=2$ math\n\n\\end{document}';
  const marked = markChanges(old, next);
  assert.ok(marked.includes('The \\DIFdel{quick} \\DIFadd{slow} fox.'));
  assert.ok(marked.includes('\\DIFdel{Gone away.}'));
  assert.ok(marked.includes('$x=2$ math'));
  assert.ok(!marked.includes('$x=1$'));
  assert.ok(marked.indexOf('ulem') < marked.indexOf('\\begin{document}'));
  assert.ok(markChanges('', next).includes('\\DIFadd{The slow fox.}'), 'a file new since the version is all additions');
});

test('comments go, and what TeX reads stays', () => {
  const { text, removed } = stripComments('a % note\n% whole line\n100\\% sure\nb%\n\\begin{verbatim}\n% kept\n\\end{verbatim}\n\\url{x%20y}');
  assert.equal(text, 'a %\n100\\% sure\nb%\n\\begin{verbatim}\n% kept\n\\end{verbatim}\n\\url{x%20y}');
  assert.equal(removed, 2);
});

test('the arXiv pack holds what the paper uses', () => {
  const texts = { 'main.tex':'\\documentclass{mine}\\usepackage{local,amsmath}\\input{sec/a}\\bibliographystyle{plain2}\\includegraphics[width=1in]{fig/p}\\input{gone}', 'sec/a.tex':'\\includegraphics{b}', 'unused.tex':'x', 'mine.cls':'', 'local.sty':'' };
  const files = [...Object.keys(texts), 'fig/p.png', 'sec/b.pdf', 'plain2.bst', 'extra.png'];
  const { used, missing } = usedFiles({ files, texts, main:'main.tex' });
  assert.deepEqual(used, ['fig/p.png', 'local.sty', 'main.tex', 'mine.cls', 'plain2.bst', 'sec/a.tex', 'sec/b.pdf']);
  assert.deepEqual(missing, ['gone']);
});

test('every venue template lists files that exist, and creates a project', async () => {
  const load = async path => new Response(readFileSync(new URL(`../${path.slice(2)}`, import.meta.url)));
  const venues = await loadVenues(load);
  assert.equal(Object.keys(venues).length, 8);
  const store = memoryStore();
  assert.equal(await createProject(store, 'Paper', 'neurips-2026', venues), 'Paper');
  assert.match(await store.read('projects/Paper/main.tex'), /neurips_2026/);
  assert.ok((await listFiles(store, 'Paper')).includes('neurips_2026.sty'));
});

test('SyncTeX: a figure box cannot throw the view off the page, and generated files are skipped', () => {
  const text = 'Input:1:main.tex\nInput:2:main.bbl\nUnit:1\n{1\n[1,8:6578176,1000000:30000000,50000000,0\nx1,8:6578176,6578176\nh2,3:6578176,6578176:6578176,657817,0\n}1\n';
  const sync = parseSynctex(text);
  const box = forward(sync, 'main.tex', 8);
  assert.ok(box.y >= 0 && box.height <= 60);
  assert.deepEqual(inverse(sync, 1, 110, 100, new Set(['main.tex'])), { file:'main.tex', line:8 });
});

test('protected spans cover math, references, comments and commands, and spare prose', () => {
  const text = 'Prose $x+1$ more \\cite{a} and \\emph{word} % note\nend';
  const covered = protectedSpans(text).map(span => text.slice(span.from, span.to));
  assert.ok(covered.includes('$x+1$') && covered.includes('\\cite{a}') && covered.includes('% note'));
  assert.ok(!covered.some(piece => piece.includes('Prose') || piece.includes('word')));
  assert.equal(keepsProtected('a $x$ b', 'c $x$ d'), true);
  assert.equal(keepsProtected('a $x$ b', 'a $y$ b'), false);
  assert.equal(keepsProtected('a \\cite{k} b', 'a b'), false);
});

test('anchors survive edits elsewhere and refuse to guess', () => {
  const text = 'one two three two four';
  const anchor = makeAnchor(text, 8, 13);
  assert.deepEqual(locate(text, anchor), { from:8, to:13 });
  assert.deepEqual(locate(`zero ${text}`, anchor), { from:13, to:18 });
  assert.equal(locate('nothing here', anchor), null);
  const twice = makeAnchor(text, 4, 7);
  assert.deepEqual(locate(`xx${text}`, twice), { from:6, to:9 }, 'the context picks the right copy');
  assert.equal(locate('two and two', twice), null, 'two copies with no context fail');
  assert.deepEqual(parseNotes('bad'), { notes:[], rounds:0 });
});

test('replies parse, and a bad format is an error', () => {
  assert.deepEqual(parseReply('<revision>New text.</revision><reason>Clearer.</reason>'), { revision:'New text.', reason:'Clearer.' });
  assert.deepEqual(parseReply('<question>Which one?</question>'), { question:'Which one?' });
  assert.throws(() => parseReply('Sure, here you go'), /expected format/);
  const [system, user] = buildMessages({ task:'proofread', passage:'p', before:'b', note:'n', intent:'cite', keys:['k1'] });
  assert.match(system.content, /<revision>/);
  assert.match(user.content, /<bibliography>k1/);
});

test('edits are phrase sized, apply in any subset, and hold protected text', () => {
  const before = 'The quick brown fox $x$ jumps.', after = 'The slow red fox $y$ jumps high.';
  const edits = wordEdits(before, after);
  assert.equal(applyEdits(before, edits), after);
  assert.deepEqual(edits.map(edit => [edit.original, edit.insert, edit.held]), [['quick brown', 'slow red', false], ['$x$', '$y$', true], ['jumps.', 'jumps high.', false]]);
  const chosen = edits.filter(edit => !edit.held);
  assert.equal(safeResult(before, chosen), 'The slow red fox $x$ jumps high.');
  assert.throws(() => safeResult(before, edits), /not applied/);
  assert.equal(safeResult(before, edits, { allowProtected:true }), after);
});
