// scribella.naklitechie.com: the page's files, plus one narrow route that carries Git traffic to Overleaf, because
// git.overleaf.com sends no CORS headers. It forwards only Git's smart-HTTP paths, only to that host, and stores nothing.
const HOST = 'git.overleaf.com';
const ORIGINS = new Set(['https://naklios.dev', 'https://scribella.naklitechie.com']);
const GIT_PATH = /^\/git-proxy\/git\.overleaf\.com\/([A-Za-z0-9]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function cors(request) {
  const origin = request.headers.get('Origin');
  return ORIGINS.has(origin) ? {
    'Access-Control-Allow-Origin':origin,
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':'Authorization, Content-Type, Git-Protocol',
    'Access-Control-Expose-Headers':'Content-Type',
    'Vary':'Origin',
  } : null;
}

export async function gitProxy(request, load = fetch) {
  const url = new URL(request.url), match = GIT_PATH.exec(url.pathname), origin = request.headers.get('Origin');
  // A same-origin GET carries no Origin header. Any other site's page is refused.
  if (origin && !ORIGINS.has(origin)) return new Response('Origin not allowed', { status:403 });
  const headers = cors(request) || {};
  if (request.method === 'OPTIONS') return new Response(null, { status:204, headers });
  if (!match || (request.method !== 'GET' && request.method !== 'POST')) return new Response('Not a Git route', { status:404, headers });
  if (match[2] === 'info/refs' && !/^service=git-(upload|receive)-pack$/.test(url.search.slice(1))) return new Response('Bad service', { status:400, headers });
  const forward = new Headers();
  for (const name of ['Authorization', 'Content-Type', 'Git-Protocol', 'Accept']) if (request.headers.has(name)) forward.set(name, request.headers.get(name));
  forward.set('User-Agent', 'git/scribella');
  const reply = await load(`https://${HOST}/${match[1]}/${match[2]}${url.search}`, { method:request.method, headers:forward, body:request.method === 'POST' ? request.body : null, redirect:'manual' });
  const out = new Headers(headers);
  if (reply.headers.has('Content-Type')) out.set('Content-Type', reply.headers.get('Content-Type'));
  if (reply.status === 401) out.set('X-Scribella', 'Overleaf refused the token');
  return new Response(reply.body, { status:reply.status, headers:out });
}

export default {
  fetch(request, env) {
    return new URL(request.url).pathname.startsWith('/git-proxy/') ? gitProxy(request) : env.ASSETS.fetch(request);
  },
};
