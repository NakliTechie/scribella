// Runs Scribella's Overleaf sync against a real Git smart-HTTP server (git http-backend) on this machine: pull into an
// empty project, merge edits from both sides, push, then a true clash that must block the push. Needs git on PATH.
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/storage.js';
import { overleafSync } from '../src/overleaf.js';

const dir = mkdtempSync(path.join(tmpdir(), 'scribella-overleaf-'));
const sh = command => execSync(command, { cwd:dir, stdio:'pipe' }).toString();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const cgi = spawn('git', ['http-backend'], { env:{ ...process.env, GIT_PROJECT_ROOT:dir, GIT_HTTP_EXPORT_ALL:'1', PATH_INFO:url.pathname, QUERY_STRING:url.search.slice(1), REQUEST_METHOD:req.method, CONTENT_TYPE:req.headers['content-type'] || '', REMOTE_USER:'git' } });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), sent = false;
  cgi.stdout.on('data', chunk => {
    if (sent) return res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const at = head.indexOf('\r\n\r\n');
    if (at < 0) return;
    let status = 200;
    for (const line of head.slice(0, at).toString().split('\r\n')) { const [key, ...value] = line.split(':'); if (key.toLowerCase() === 'status') status = parseInt(value.join(':'), 10); else res.setHeader(key, value.join(':').trim()); }
    res.writeHead(status); res.write(head.slice(at + 4)); sent = true;
  });
  cgi.stdout.on('end', () => res.end());
});
try {
  sh('git init -q --bare -b master remote.git && git -C remote.git config http.receivepack true && git clone -q remote.git seed');
  writeFileSync(path.join(dir, 'seed/main.tex'), 'line one\nline two\nline three\n');
  sh('cd seed && git add . && git -c user.email=o@x -c user.name=O commit -qm init && git push -q origin master');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = memoryStore({ 'p/notes.tex':'local only\n' });
  const sync = overleafSync({ store, root:'p', link:{ id:'x', token:'t' }, url:`http://127.0.0.1:${server.address().port}/remote.git` });
  const main = async () => new TextDecoder().decode(await store.readBinary('p/main.tex'));
  const theirs = text => { sh('cd seed && git pull -q'); writeFileSync(path.join(dir, 'seed/main.tex'), text); sh('cd seed && git -c user.email=o@x -c user.name=O commit -qam edit && git push -q origin master'); };

  assert.deepEqual((await sync.pull()).changed, ['main.tex']);
  await store.write('p/main.tex', 'line one\nline two MINE\nline three\n');
  theirs('line ONE theirs\nline two\nline three\n');
  assert.deepEqual((await sync.pull()).conflicts, []);
  assert.equal(await main(), 'line ONE theirs\nline two MINE\nline three\n');
  assert.equal((await sync.push('from Scribella')).pushed, true);
  assert.equal(sh('git --git-dir=remote.git show master:main.tex'), 'line ONE theirs\nline two MINE\nline three\n');
  assert.deepEqual(sh('git --git-dir=remote.git ls-tree --name-only master').trim().split('\n'), ['main.tex', 'notes.tex']);
  await store.write('p/main.tex', 'line ONE theirs\nline two CLASH mine\nline three\n');
  theirs('line ONE theirs\nline two CLASH theirs\nline three\n');
  assert.deepEqual((await sync.push('clash')).conflicts, ['main.tex']);
  assert.match(await main(), /<<<<<<< yours\nline two CLASH mine\n=======\nline two CLASH theirs\n>>>>>>> overleaf/);
  assert.deepEqual((await sync.push('still marked')).conflicts, ['main.tex'], 'a file with markers is never pushed');
  console.log('Overleaf sync against git http-backend: PASS');
} finally {
  server.close();
  rmSync(dir, { recursive:true, force:true });
}
