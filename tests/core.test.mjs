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
import { addFields, citeKey, cleanValue, parseBib, sameWork, scanEntries, writeEntry } from '../src/bib.js';
import { auditEntry, findPaper, fromCrossref, noticesOf } from '../src/lookup.js';
import { checkPdf, checkSource } from '../src/blind.js';
import { formatLatex } from '../src/format.js';
import { keepProse, maskLatex } from '../src/spell.js';
import { annotatePdf, annotationCount } from '../src/review-pdf.js';
import { PDFDocument } from '../vendor/pdf-lib/pdf-lib.esm.js';
import { discover } from '../src/lookup.js';
import { parseBlg, parseLabels } from '../src/aux.js';
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
  assert.deepEqual(inverse(sync, 1, 110, 119.9), { file:'main.tex', line:11 });
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
  assert.equal(Object.keys(venues).length, 6);
  const store = memoryStore();
  assert.equal(await createProject(store, 'Paper', 'neurips-2026', venues), 'Paper');
  assert.match(await store.read('projects/Paper/main.tex'), /neurips_2026/);
  assert.match(await store.read('projects/Paper/main.tex'), /\\title\{Paper\}/);
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
});

test('comment environments and notes on URL lines leave the arXiv source', () => {
  const { text, removed } = stripComments('\\begin{comment}\nsecret\n\\end{comment}\nsee \\url{a%20b} % private\n\\verb|50%| ok');
  assert.equal(text, 'see \\url{a%20b} %\n\\verb|50%| ok');
  assert.equal(removed, 2);
});

const BIB = `@article{a1, title = {The {T}itle}, author = "Knuth, Donald and Lamport, Leslie", journal = {J}, year = 1984 }
@inproceedings{a1,
  title = {No year},
  journal = {Wrong},
  booktitle = {B},
  author = {X, Y},
  year = {19xx}
}
@string{s = "v"}
@thing{b2,}
`;

test('BibTeX parses braces, quotes and bare values, and the local scan finds problems', () => {
  const parsed = parseBib(BIB);
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.entries[0].fields.title, 'The {T}itle');
  assert.equal(parsed.entries[0].fields.year, '1984');
  assert.equal(BIB.slice(parsed.entries[0].from, parsed.entries[0].to).endsWith('}'), true);
  const messages = scanEntries(parsed).map(item => item.message);
  assert.ok(messages.includes('This key appears twice.'));
  assert.ok(messages.some(item => /not four digits/.test(item)));
  assert.ok(messages.some(item => /Unknown entry type thing/.test(item)));
  assert.ok(messages.some(item => /has a journal/.test(item)));
  assert.equal(parseBib('@article{x, title={a').problems.length, 1);
  assert.match(writeEntry({ type:'misc', key:'k', fields:{ title:'T', year:'' } }), /title = \{T\}/);
});

test('sameWork needs the title and the ordered authors', () => {
  const a = { title:'A {Big} Paper', author:'Knuth, Donald and Lamport, Leslie' };
  assert.equal(sameWork(a, { title:'a big paper', author:'Donald Knuth and Leslie Lamport' }), true);
  assert.equal(sameWork(a, { title:'a big paper', author:'Lamport, Leslie and Knuth, Donald' }), false);
  assert.equal(sameWork(a, { title:'a bigger paper', author:a.author }), false);
  assert.equal(citeKey({ author:'Knuth, D', title:'The Art of Code', year:'1968' }), 'knuth1968code');
});

const WORK = { type:'journal-article', title:['The Title'], author:[{ family:'Knuth', given:'Donald' }], 'container-title':['J'], issued:{ 'date-parts':[[1984]] }, DOI:'10.1/x', page:'1-2', 'updated-by':[{ type:'retraction' }] };
const answer = body => async () => new Response(JSON.stringify(body), { status:200 });

test('Crossref records become entries, and notices are read', () => {
  assert.equal(fromCrossref(WORK).type, 'article');
  assert.equal(fromCrossref(WORK).fields.author, 'Knuth, Donald');
  assert.deepEqual(noticesOf(WORK), ['retracted']);
});

test('the audit never counts a failure as checked, and refuses a different paper', async () => {
  const entry = { key:'k', fields:{ title:'The Title', author:'Knuth, Donald', doi:'10.1/x' } };
  const result = await auditEntry(entry, answer({ message:WORK }));
  assert.equal(result.status, 'update');
  assert.deepEqual(result.notices, ['retracted']);
  assert.equal(result.additions.pages, '1-2');
  assert.equal((await auditEntry(entry, async () => { throw new Error('offline'); })).status, 'unavailable');
  assert.equal((await auditEntry(entry, async () => new Response('', { status:500 }))).status, 'unavailable');
  assert.equal((await auditEntry(entry, async () => new Response('', { status:404 }))).status, 'unmatched');
  assert.equal((await auditEntry({ key:'k', fields:{ ...entry.fields, title:'Another' } }, answer({ message:WORK }))).status, 'conflict');
  assert.equal((await auditEntry({ key:'k', fields:{ pubstate:'preprint', title:'x' } })).status, 'skipped');
});

test('findPaper routes DOIs, arXiv ids and titles', async () => {
  const seen = [];
  const load = async url => { seen.push(url); return new Response(JSON.stringify(/openalex/.test(url) ? { title:'T', authorships:[{ author:{ display_name:'Ada Lovelace' } }], publication_year:2020 } : { message:{ ...WORK, items:[WORK] } })); };
  assert.equal((await findPaper('https://doi.org/10.1234/x.', load)).fields.doi, '10.1/x');
  const arxiv = await findPaper('arXiv:1706.03762v2', load);
  assert.equal(arxiv.fields.eprint, '1706.03762');
  assert.equal(arxiv.fields.author, 'Lovelace, Ada');
  assert.equal((await findPaper('The Title', load)).key, 'knuth1984title');
  assert.ok(seen[1].includes('10.48550'));
});

test('the double-blind check reads source and PDF facts', () => {
  const found = checkSource({ 'a.tex':'\\usepackage[final]{neurips_2026}\n\\author{A\\thanks{x}}\n\\url{https://github.com/me}\n% \\thanks{hidden}\nIn our previous work we did this.\n\\section*{Acknowledgements}\n' });
  assert.equal(found.length, 6);
  const pdfFound = checkPdf({ author:'Me', links:[{ page:2, url:'https://github.com/me/repo' }, { page:2, url:'https://arxiv.org/abs/1' }], fonts:[{ page:1, name:'F', type3:true, embedded:true }, { page:1, name:'G', type3:false, embedded:false }] });
  assert.equal(pdfFound.length, 4);
});

test('preprints are checked against OpenAlex', async () => {
  const load = async () => new Response(JSON.stringify({ title:'T One', authorships:[{ author:{ display_name:'Ada Lovelace' } }] }));
  assert.equal((await auditEntry({ key:'k', fields:{ title:'T One', author:'Lovelace, Ada', doi:'10.48550/arXiv.1706.03762' } }, load)).status, 'checked');
  assert.equal((await auditEntry({ key:'k', fields:{ title:'Other', author:'Lovelace, Ada', eprint:'1706.03762' } }, load)).status, 'conflict');
});

test('a citation note may add a known key and nothing else protected', () => {
  const before = 'As shown $x$ here.';
  const add = wordEdits(before, 'As shown $x$ \\cite{k1} here.');
  assert.equal(safeResult(before, add, { citeKeys:['k1'] }), 'As shown $x$ \\cite{k1} here.');
  assert.throws(() => safeResult(before, wordEdits(before, 'As shown $x$ \\cite{invented} here.'), { citeKeys:['k1'] }), /not applied/);
  assert.throws(() => safeResult(before, wordEdits(before, 'As shown $y$ \\cite{k1} here.'), { citeKeys:['k1'] }), /not applied/);
});

test('an anchor at its old offset still needs its context', () => {
  const anchor = makeAnchor('aa word bb word cc', 11, 15);
  assert.equal(locate('xxxxxxxword bb word cc', anchor), null, 'a copy shifted into the old offset is not the note, and two copies are never guessed');
});

test('comment markers inside verbatim stay', () => {
  const source = '\\begin{verbatim}\n\\begin{comment}\n\\end{verbatim}';
  assert.equal(stripComments(source).text, source);
});

test('outside values are made safe, and details are added without rewriting the entry', () => {
  assert.equal(cleanValue('<i>R&D</i> at 100% \\input{x}'), 'R\\&D at 100\\% inputx');
  const text = '@article{k, title = "A " # b, note = {keep}}\n';
  const [entry] = parseBib(text).entries;
  const next = addFields(text, entry, { doi:'10.1/x' });
  assert.ok(next.startsWith('@article{k, title = "A " # b, note = {keep},\n  doi = {10.1/x}\n}'));
  assert.throws(() => addFields(`x${text}`, entry, { doi:'y' }), /changed/);
});

test('the double-blind check sees authors and emails, and spares anonymous ones', () => {
  assert.equal(checkSource({ 'a.tex':'\\author{Anonymous}\n' }).length, 0);
  assert.equal(checkSource({ 'a.tex':'\\author{Ada Lovelace}\nme@uni.edu\n' }).length, 2);
});

test('formatting changes only indentation, and leaves verbatim alone', () => {
  const source = '\\begin{document}\n\\begin{itemize}\n\\item a   \n\\begin{verbatim}\n   raw\n\\end{verbatim}\n\\end{itemize}\n\\end{document}';
  assert.equal(formatLatex(source), '\\begin{document}\n\\begin{itemize}\n  \\item a\n  \\begin{verbatim}\n   raw\n\\end{verbatim}\n\\end{itemize}\n\\end{document}');
});

test('the .aux gives label numbers, and the bibliography log gives problems', () => {
  assert.deepEqual(parseLabels('\\newlabel{sec:a}{{2.1}{3}{Title}{section.2}{}}').get('sec:a'), { number:'2.1', page:'3' });
  assert.deepEqual(parseBlg('Warning--empty journal in x\nI found no \\citation commands\nRepeated entry---line 3\n').map(item => item.severity), ['warning', 'error']);
});

test('spellcheck sees prose only, with offsets unchanged', () => {
  const text = 'A wrod $x_y$ \\cite{key} here';
  const masked = maskLatex(text);
  assert.equal(masked.length, text.length);
  assert.ok(masked.includes('wrod') && !masked.includes('x_y') && !masked.includes('cite'));
});

test('review fixes: multi-line authors, Verbatim blocks and starred citations', () => {
  assert.equal(checkSource({ 'a.tex':'\\author[S]{\n  Ada Lovelace\n}\n' })[0].line, 1);
  const code = '\\begin{Verbatim}\n   x\n\\end{verbatim}\n   y\n\\end{Verbatim}';
  assert.equal(formatLatex(code), code);
  const before = 'A claim here.', next = 'A claim \\citep[see][p. 2]{k1} here.';
  assert.equal(safeResult(before, wordEdits(before, next), { citeKeys:['k1'] }), next);
});

test('findings beside blanked LaTeX are dropped', () => {
  const text = 'A wrod. $x$ is fine';
  assert.deepEqual(keepProse(text, [{ from:2, to:6 }, { from:9, to:10 }, { from:12, to:14, message:'does not start with a capital letter' }]).map(item => item.from), [2]);
  assert.equal(keepProse('\\textbf{mispelled}', [{ from:8, to:17, message:'spelling' }]).length, 1, 'a typo inside a prose argument stays');
});

test('notes land as real PDF annotations', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  const bytes = await annotatePdf(await pdf.save(), [{ page:1, x:100, y:100, text:'Fix this' }, { page:1, x:100, y:200, text:'And this' }]);
  assert.equal(await annotationCount(bytes), 2);
});

test('discovery lists papers with counts', async () => {
  const load = async () => new Response(JSON.stringify({ results:[{ title:'T', authorships:[{ author:{ display_name:'Ada Lovelace' } }], publication_year:2020, cited_by_count:7 }] }));
  const found = await discover('x', load);
  assert.equal(found[0].cited, 7);
  assert.equal(found[0].fields.author, 'Lovelace, Ada');
});

test('OpenAlex venues become proper entries', async () => {
  const load = async () => new Response(JSON.stringify({ results:[{ title:'T', authorships:[], publication_year:2020, primary_location:{ source:{ type:'journal', display_name:'J&K' } }, biblio:{ volume:'3', issue:'1', first_page:'5', last_page:'9' } }] }));
  const [entry] = await discover('x', load);
  assert.equal(entry.type, 'article');
  assert.equal(entry.fields.journal, 'J\\&K');
  assert.equal(entry.fields.pages, '5--9');
  assert.equal(parseBlg("You're missing a field name---line 3\n")[0].severity, 'error');
});
