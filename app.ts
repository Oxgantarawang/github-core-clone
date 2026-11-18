// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and
// MCP, all over one in-memory store. Node's http server only, no dependencies.
//
// Every REST reply is application/json and carries X-GitHub-Request-Id; errors
// are JSON with a string message. The bearer <redacted> in MAKEFUN_SHOP_TOKEN is
// the only credential: a request without it is 401, and a repository under any
// other owner is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildCommit,
  collectReachable,
  commitGenerations,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  flattenTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktFlush,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import {
  Store,
  commitJson,
  createIssue,
  createPull,
  fastForwardOk,
  issueJson,
  mergePull,
  peelToCommit,
  pullConflicts,
  pullFiles,
  pullJson,
  repoJson,
  sortedRefs,
  type Repo,
} from './store.ts';
import { executeOperation } from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const FORGE_NAME = 'github-core-clone';
const FORGE_VERSION = '1.0.0';

const store = new Store();
let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': requestId() });
  res.end();
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** True when the request carries the trial's bearer token (any bearer when none is configured). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.length <= 7) return false;
  if (TOKEN === '') return true;
  return header.slice(7) === TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as JSON: null when it is not valid JSON (or empty). */
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a path into its decoded segments, dropping empty ones. */
function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map(decodeSegment);
}

/** Paginate a list the GitHub way: page/per_page with a Link rel="next" when more follow. */
function paginate<T>(res: ServerResponse, items: T[], query: URLSearchParams, basePath: string, host: string): T[] {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const next = `http://${host}${basePath}?per_page=${perPage}&page=${page + 1}`;
    res.setHeader('link', `<${next}>; rel="next"`);
  }
  return slice;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function repoShape(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepoFor(owner, name);
  if (!repo) { notFound(res); return null; }
  return repo;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const parts = segments(path.replace(/^\/api\/v3/, '') || '/');
  const host = req.headers.host ?? '127.0.0.1';

  // API root.
  if (parts.length === 0) {
    if (method !== 'GET') { notFound(res); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (parts[0] === 'meta' && parts.length === 1) {
    if (method !== 'GET') { notFound(res); return; }
    sendJson(res, 200, { installed_version: FORGE_VERSION });
    return;
  }

  if (parts[0] === 'user' && parts.length === 1) {
    if (method !== 'GET') { notFound(res); return; }
    const login = store.ownerLogin ?? 'owner';
    sendJson(res, 200, { login, id: 1, type: 'User', node_id: 'dXNlcjowbmU=' });
    return;
  }

  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const page = paginate(res, store.listRepos().map((repo) => repoJson(store, repo)), query, '/api/v3/user/repos', host);
      sendJson(res, 200, page);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') { sendJson(res, 422, { message: 'name is required' }); return; }
      const repo = store.createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if (!repo) { sendJson(res, 422, { message: 'Repository already exists' }); return; }
      sendJson(res, 201, repoJson(store, repo));
      return;
    }
    notFound(res);
    return;
  }

  // /repos/{owner}/{repo}[...]
  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = parts[1];
    const name = parts[2];
    const rest = parts.slice(3);

    // The repository itself.
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = repoShape(req, res, owner, name);
        if (repo) sendJson(res, 200, repoJson(store, repo));
        return;
      }
      if (method === 'PATCH') {
        const repo = repoShape(req, res, owner, name);
        if (!repo) return;
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(res, 200, repoJson(store, repo));
        return;
      }
      if (method === 'DELETE') {
        const repo = repoShape(req, res, owner, name);
        if (!repo) return;
        store.deleteRepo(name);
        sendNoContent(res);
        return;
      }
      notFound(res);
      return;
    }

    const repo = repoShape(req, res, owner, name);
    if (!repo) return;

    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = sortedRefs(repo)
          .filter((ref) => ref.name.startsWith('refs/heads/'))
          .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const tip = repo.branchTip(rest[1]);
        if (tip === undefined) { notFound(res); return; }
        sendJson(res, 200, { name: rest[1], commit: { sha: tip } });
        return;
      }
      notFound(res);
      return;
    }

    // Commits.
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = shaParam ? repo.resolveTip(shaParam) : repo.branchTip(repo.defaultBranch);
      if (tip === undefined) { sendJson(res, 200, []); return; }
      const commits = repo.commitHistory(tip).map((sha) => commitJson(repo, sha)).filter((entry): entry is Record<string, unknown> => entry !== null);
      sendJson(res, 200, commits);
      return;
    }

    // Git Data: refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return;
        }
        if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return;
      }
      if (method === 'GET') {
        const wanted = rest.slice(2).join('/');
        if (wanted === '') {
          sendJson(res, 200, sortedRefs(repo).map((ref) => ({ ref: ref.name, object: { sha: ref.oid } })));
          return;
        }
        const refName = `refs/${wanted}`;
        const tip = repo.refs.get(refName);
        if (tip === undefined) { notFound(res); return; }
        sendJson(res, 200, { ref: refName, object: { sha: tip } });
        return;
      }
      notFound(res);
      return;
    }

    // Contents.
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'PUT') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const content = typeof body.content === 'string' ? body.content : '';
        let contentBytes: Buffer;
        try {
          contentBytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
        } catch {
          sendJson(res, 422, { message: 'content is not valid base64' });
          return;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const existing = repo.branchTip(branch) !== undefined ? store.fileAt(repo, repo.branchTip(branch)!, filePath) : null;
        if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return;
        }
        const created = existing === null;
        const { commitSha, blobSha } = store.commitFile(repo, branch, filePath, contentBytes, message);
        sendJson(res, created ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobSha, size: contentBytes.length, encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'GET') {
        const refParam = query.get('ref');
        const tip = refParam ? repo.resolveTip(refParam) : repo.branchTip(repo.defaultBranch);
        if (tip === undefined) { notFound(res); return; }
        const file = store.fileAt(repo, tip, filePath);
        if (file) {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: file.data.toString('base64'),
            sha: file.oid,
          });
          return;
        }
        // Directory listing: immediate children of the path.
        const commit = repo.commitOf(tip);
        if (!commit) { notFound(res); return; }
        const all = flattenTree(commit.tree, (oid) => repo.objects.get(oid));
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
        for (const [path] of all) {
          if (!path.startsWith(prefix)) continue;
          const rest2 = path.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash < 0) {
            const entry = all.get(path)!;
            children.set(rest2, { type: 'file', name: rest2, path, sha: entry.oid });
          } else {
            const dir = rest2.slice(0, slash);
            if (!children.has(dir)) {
              // The tree oid of the directory: walk the tree to find it.
              let dirOid = '';
              const walk = (treeOid: string, segments: string[]): string => {
                if (segments.length === 0) return treeOid;
                const object = repo.objects.get(treeOid);
                if (!object || object.type !== 'tree') return '';
                for (const entry of parseTree(object.data)) {
                  if (entry.name === segments[0]) {
                    if (segments.length === 1) return entry.oid;
                    return walk(entry.oid, segments.slice(1));
                  }
                }
                return '';
              };
              dirOid = walk(commit.tree, `${filePath}/${dir}`.split('/'));
              children.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: dirOid || hashObject('tree', Buffer.alloc(0)) });
            }
          }
        }
        if (children.size === 0) { notFound(res); return; }
        sendJson(res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
        return;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const commitSha = store.deleteFile(repo, branch, filePath, message);
        if (commitSha === null) { notFound(res); return; }
        sendJson(res, 200, { commit: { sha: commitSha } });
        return;
      }
      notFound(res);
      return;
    }

    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const parsed = parseJsonBody(rawBody);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') { sendJson(res, 422, { message: 'name is required' }); return; }
        const label = { name, color: typeof body.color === 'string' ? body.color : 'ededed' };
        repo.labels.set(name, label);
        sendJson(res, 201, label);
        return;
      }
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()]);
        return;
      }
      notFound(res);
      return;
    }

    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = parseJsonBody(rawBody);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const labels: { name: string; color: string }[] = [];
          if (Array.isArray(body.labels)) {
            for (const entry of body.labels) {
              const labelName = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
              const found = repo.labels.get(labelName);
              if (!found) { sendJson(res, 422, { message: `Label '${labelName}' does not exist` }); return; }
              labels.push(found);
            }
          }
          const issue = createIssue(store, repo, title, typeof body.body === 'string' ? body.body : '', labels);
          sendJson(res, 201, issueJson(store, repo, issue));
          return;
        }
        if (method === 'GET') {
          let issues = [...repo.issues];
          const stateParam = query.get('state') ?? 'open';
          if (stateParam !== 'all') issues = issues.filter((issue) => issue.state === stateParam);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created') {
            issues.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          }
          const page = paginate(res, issues.map((issue) => issueJson(store, repo, issue)), query, `/api/v3/repos/${owner}/${name}/issues`, host);
          sendJson(res, 200, page);
          return;
        }
        notFound(res);
        return;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) { notFound(res); return; }
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (rest.length === 2) {
        if (!issue) { notFound(res); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(store, repo, issue)); return; }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(rawBody);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updatedAt = store.stamp();
          sendJson(res, 200, issueJson(store, repo, issue));
          return;
        }
        notFound(res);
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) { notFound(res); return; }
        if (method === 'POST') {
          const parsed = parseJsonBody(rawBody);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const comment = {
            id: repo.nextCommentId++,
            body: typeof body.body === 'string' ? body.body : '',
            userLogin: store.ownerLogin ?? 'owner',
            createdAt: store.stamp(),
          };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: comment.userLogin }, created_at: comment.createdAt });
          return;
        }
        if (method === 'GET') {
          const list = repo.comments.get(number) ?? [];
          sendJson(res, 200, list.map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.userLogin }, created_at: comment.createdAt })));
          return;
        }
        notFound(res);
        return;
      }
      notFound(res);
      return;
    }

    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = parseJsonBody(rawBody);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
          const body = isRecord(parsed.value) ? parsed.value : {};
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (head === '' || repo.branchTip(head) === undefined || repo.branchTip(base) === undefined) {
            sendJson(res, 422, { message: 'head or base branch not found' });
            return;
          }
          const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
          if (existing) { sendJson(res, 422, { message: 'A pull request already exists for this head branch' }); return; }
          const pull = createPull(store, repo, typeof body.title === 'string' ? body.title : '', typeof body.body === 'string' ? body.body : '', head, base);
          if (!pull) { sendJson(res, 422, { message: 'could not create pull request' }); return; }
          sendJson(res, 201, pullJson(store, repo, pull));
          return;
        }
        if (method === 'GET') {
          let pulls = [...repo.pulls];
          const stateParam = query.get('state') ?? 'open';
          if (stateParam !== 'all') pulls = pulls.filter((pull) => pull.state === stateParam);
          pulls.sort((a, b) => b.seq - a.seq);
          const page = paginate(res, pulls.map((pull) => pullJson(store, repo, pull)), query, `/api/v3/repos/${owner}/${name}/pulls`, host);
          sendJson(res, 200, page);
          return;
        }
        notFound(res);
        return;
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) { notFound(res); return; }
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (rest.length === 2) {
        if (!pull) { notFound(res); return; }
        if (method === 'GET') { sendJson(res, 200, pullJson(store, repo, pull)); return; }
        notFound(res);
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) { notFound(res); return; }
        sendJson(res, 200, pullFiles(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) { notFound(res); return; }
        if (pull.state !== 'open') { sendJson(res, 405, { message: 'Pull request is already closed' }); return; }
        if (pullConflicts(repo, pull)) { sendJson(res, 405, { message: 'Merge conflict' }); return; }
        const sha = mergePull(store, repo, pull);
        if (sha === null) { sendJson(res, 405, { message: 'Merge conflict' }); return; }
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      notFound(res);
      return;
    }

    notFound(res);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_V0_CAPS = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta quiet agent=forge/1.0';

function gitRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepoFor(owner, name);
  if (!repo) { notFound(res); return null; }
  return repo;
}

/** The v0 ref advertisement body for a service, with the "# service=" preamble. */
function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const tip = repo.branchTip(repo.defaultBranch);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${tip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag' && ref.name.startsWith('refs/tags/')) {
        lines.push(`${peelToCommit(repo, ref.oid)} ${ref.name}^{}\n`);
      }
    }
  }
  return encodePktLines(lines);
}

/** The v2 capability advertisement body (no service preamble). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'server-option\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The tree closure of a commit (tree + blobs, no parents). */
function treeClosure(repo: Repo, commitOid: string): Set<string> {
  const out = new Set<string>();
  const commit = repo.commitOf(commitOid);
  if (!commit) return out;
  try {
    for (const oid of collectReachable([commit.tree], (id) => repo.objects.get(id), { allowMissing: true })) out.add(oid);
  } catch {
    // A missing tree object means the commit is incomplete; send what exists.
  }
  return out;
}

/**
 * The objects a fetch must send: the depth-limited commits from `wants` plus
 * their trees, minus what the client already holds (`haves`, cut at the
 * shallow boundaries it named).
 */
function fetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | null,
): { send: GitObject[]; newShallow: string[]; unshallow: string[] } {
  const generations = commitGenerations(wants, (oid) => repo.objects.get(oid), depth === null ? undefined : depth - 1);
  const allowed = new Set<string>();
  for (const [oid, gen] of generations) {
    if (depth === null || gen <= depth - 1) allowed.add(oid);
  }
  const wanted = new Set<string>();
  for (const oid of allowed) {
    wanted.add(oid);
    for (const entry of treeClosure(repo, oid)) wanted.add(entry);
  }
  // What the client holds: the haves' closures, stopping at shallow boundaries.
  const shallowSet = new Set(shallow);
  const held = new Set<string>();
  const visit = (oid: string): void => {
    if (held.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const entry of treeClosure(repo, oid)) held.add(entry);
      if (shallowSet.has(oid)) return;
      for (const parent of commit.parents) visit(parent);
    } else if (object.type === 'tag') {
      visit(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visit(entry.oid);
    }
  };
  for (const have of haves) visit(have);

  const send: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.push(object);
  }
  const keyed = send.map((object) => [hashObject(object.type, object.data), object] as const);
  keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 0; i < keyed.length; i += 1) send[i] = keyed[i][1];
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of allowed) {
      const gen = generations.get(oid) ?? 0;
      if (gen === depth - 1) newShallow.push(oid);
    }
    for (const boundary of shallow) {
      if (allowed.has(boundary) && (generations.get(boundary) ?? 0) < depth - 1) unshallow.push(boundary);
    }
  }
  return { send, newShallow, unshallow };
}

/** Split a pack into sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  const repo = gitRepo(res, owner, name);
  if (!repo) return;
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    sendBytes(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-upload-pack') {
    sendBytes(res, 200, v0Advertisement(repo, 'git-upload-pack', UPLOAD_V0_CAPS), 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(res, 200, v0Advertisement(repo, 'git-receive-pack', RECEIVE_CAPS), 'application/x-git-receive-pack-advertisement');
    return;
  }
  notFound(res);
}

function lsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  interface Line { name: string; oid: string; symrefTarget?: string; peeled?: string; unborn?: boolean }
  const lines: Line[] = [];
  const tip = repo.branchTip(repo.defaultBranch);
  if (tip === undefined) {
    lines.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: 'refs/heads/main', unborn: true });
  } else if (symrefs) {
    lines.push({ name: 'HEAD', oid: tip, symrefTarget: 'refs/heads/main' });
  }
  for (const ref of sortedRefs(repo)) {
    let peeled: string | undefined;
    if (peel && ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') peeled = peelToCommit(repo, ref.oid);
    }
    lines.push({ name: ref.name, oid: ref.oid, peeled });
  }
  const kept = prefixes.length === 0 ? lines : lines.filter((line) => prefixes.some((prefix) => line.name.startsWith(prefix)));
  const packets: (string | 'flush')[] = [];
  for (const line of kept) {
    if (line.unborn) {
      packets.push(`unborn ${line.name}${line.symrefTarget ? ` symref-target:${line.symrefTarget}` : ''}\n`);
    } else {
      packets.push(`${line.oid} ${line.name}${line.symrefTarget ? ` symref-target:${line.symrefTarget}` : ''}${line.peeled ? ` peeled:${line.peeled}` : ''}\n`);
    }
  }
  packets.push('flush');
  return encodePktLines(packets);
}

function fetchResponse(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null, v2: boolean): Buffer {
  const { send, newShallow, unshallow } = fetchObjects(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
    if (depth !== null) {
      const shallowLines: (string | 'flush')[] = ['shallow-info\n'];
      for (const oid of newShallow) shallowLines.push(`shallow ${oid}\n`);
      for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
      shallowLines.push('flush');
      parts.push(encodePktLines(shallowLines));
    }
    if (send.length > 0) {
      parts.push(encodePktLines(['packfile\n']));
      parts.push(sidebandPack(writePack(send)));
      parts.push(pktFlush());
    }
  } else {
    const lines: (string | 'flush')[] = ['NAK\n'];
    for (const oid of newShallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(lines));
    if (send.length > 0) parts.push(sidebandPack(writePack(send)));
  }
  return Buffer.concat(parts);
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = gitRepo(res, owner, name);
  if (!repo) return;
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'delim') lines.push('\u0001');
    else if (packet.kind === 'flush') lines.push('\u0000');
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (v2 && first === 'command=ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      else if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
    }
    sendBytes(res, 200, lsRefsResponse(repo, prefixes, peel, symrefs), 'application/x-git-upload-pack-result');
    return;
  }
  if (v2 && first === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
    }
    if (wants.length === 0) { sendBytes(res, 200, Buffer.alloc(0), 'application/x-git-upload-pack-result'); return; }
    sendBytes(res, 200, fetchResponse(repo, wants, haves, shallow, Number.isFinite(depth) ? depth : null, true), 'application/x-git-upload-pack-result');
    return;
  }
  if (!v2) {
    // v0: wants/shallow/deepen, flush, haves/done, flush.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      if (line === '\u0000') continue;
      const text = line.replace(/\n$/, '').split('\0')[0];
      if (text.startsWith('want ')) wants.push(text.slice(5).trim().split(' ')[0]);
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10);
    }
    if (wants.length === 0) { sendBytes(res, 200, Buffer.alloc(0), 'application/x-git-upload-pack-result'); return; }
    sendBytes(res, 200, fetchResponse(repo, wants, haves, shallow, Number.isFinite(depth) ? depth : null, false), 'application/x-git-upload-pack-result');
    return;
  }
  sendJson(res, 400, { message: 'unknown upload-pack command' });
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = gitRepo(res, owner, name);
  if (!repo) return;
  const { packets, offset } = decodePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '').split('\0')[0];
    const parts = line.split(' ');
    if (parts.length < 3 || !isOid(parts[0]) || !isOid(parts[1])) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const reportLines = (unpackOk: boolean, results: { ref: string; ok: boolean; reason: string }[]): Buffer => {
    const lines: (string | 'flush')[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
    for (const result of results) {
      lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
    }
    lines.push('flush');
    const inner = encodePktLines(lines);
    return Buffer.concat([sidebandPack(inner), pktFlush()]);
  };
  if (commands.length === 0) {
    sendBytes(res, 200, reportLines(false, []), 'application/x-git-receive-pack-result');
    return;
  }
  // Unpack first: every object the push carries enters the store.
  const pack = body.subarray(offset);
  if (pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      sendBytes(res, 200, reportLines(false, commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack error' }))), 'application/x-git-receive-pack-result');
      return;
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'new object missing' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
    } else if (!fastForwardOk(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  sendBytes(res, 200, reportLines(true, results), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

async function handleGraphQL(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  const parsed = parseJsonBody(rawBody);
  if (!parsed.ok) { sendJson(res, 400, { message: 'Invalid JSON' }); return; }
  const ctx = { store, viewerLogin: store.ownerLogin ?? 'owner' };
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    const variables = isRecord(entry.variables) ? entry.variables : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
    return executeOperation(ctx, entry.query, variables, operationName);
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28)
// ---------------------------------------------------------------------------

const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full owner/repo name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function mcpResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function mcpError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function mcpToolText(obj: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function mcpToolError(message: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [fullOwner, fullRepo] = args.full_name.split('/', 2);
    if (owner === '') owner = fullOwner;
    if (name === '') name = fullRepo;
  }
  if (owner === '' || name === '') return null;
  return store.getRepoFor(owner, name) ?? null;
}

function mcpCallTool(name: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  const required: Record<string, string[]> = {
    create_repo: ['name'],
    get_repo: ['owner', 'repo'],
    create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'],
    create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
    get_issue: ['owner', 'repo', 'number'],
    list_pull_requests: ['owner', 'repo'],
  };
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return mcpToolError(`Unknown tool: ${name}`);
  const missing = (required[name] ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return mcpToolError(`Missing required argument(s): ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (typeof args.owner === 'string' && args.owner !== '') store.adoptOwner(args.owner);
    const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    if (!repo) return mcpToolError(`Repository ${repoName} already exists`);
    return mcpToolText(repoJson(store, repo));
  }

  const repo = mcpResolveRepo(args);
  if (!repo) return mcpToolError('Repository not found');

  if (name === 'get_repo') return mcpToolText(repoJson(store, repo));

  if (name === 'create_issue') {
    const issue = createIssue(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return mcpToolText(issueJson(store, repo, issue));
  }

  if (name === 'list_issues') {
    let issues = [...repo.issues];
    const stateParam = typeof args.state === 'string' ? args.state : 'open';
    if (stateParam !== 'all') issues = issues.filter((issue) => issue.state === stateParam);
    return mcpToolText(issues.map((issue) => issueJson(store, repo, issue)));
  }

  if (name === 'get_issue') {
    const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
    if (!issue) return mcpToolError('Issue not found');
    return mcpToolText(issueJson(store, repo, issue));
  }

  if (name === 'list_pull_requests') {
    let pulls = [...repo.pulls];
    const stateParam = typeof args.state === 'string' ? args.state : 'open';
    if (stateParam !== 'all') pulls = pulls.filter((pull) => pull.state === stateParam);
    return mcpToolText(pulls.map((pull) => pullJson(store, repo, pull)));
  }

  if (name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    if (repo.branchTip(head) === undefined || repo.branchTip(base) === undefined) {
      return mcpToolError('head or base branch not found');
    }
    const pull = createPull(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
    if (!pull) return mcpToolError('could not create pull request');
    return mcpToolText(pullJson(store, repo, pull));
  }

  if (name === 'merge_pull_request') {
    const pull = repo.pulls.find((candidate) => candidate.number === Number(args.pull_number));
    if (!pull) return mcpToolError('Pull request not found');
    if (pull.state !== 'open') return mcpToolError('Pull request is already closed');
    const sha = mergePull(store, repo, pull);
    if (sha === null) return mcpToolError('Merge conflict');
    return mcpToolText({ sha, merged: true, number: pull.number, state: pull.state });
  }

  return mcpToolError(`Unknown tool: ${name}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  // A body that is not JSON is a parse error: HTTP 400 with JSON-RPC -32700.
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    mcpError(res, 400, null, -32700, 'Parse error');
    return;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    mcpError(res, 400, isRecord(body) ? body.id : null, -32600, 'Invalid Request');
    return;
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  if (method === 'server/discover') {
    mcpResult(res, id, {
      resultType: 'discover',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: FORGE_NAME, version: FORGE_VERSION } },
    });
    return;
  }
  if (method === 'initialize') {
    const paramsRecord = params as Record<string, unknown>;
    const requested = typeof paramsRecord.protocolVersion === 'string' ? paramsRecord.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2026-07-28';
    mcpResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
    });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  if (method === 'tools/list') {
    mcpResult(res, id, { tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = MCP_TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      mcpError(res, 200, id, -32602, `Unknown tool: ${toolName}`);
      return;
    }
    mcpResult(res, id, mcpCallTool(toolName, args));
    return;
  }
  mcpError(res, 200, id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeSegment(gitMatch[1]);
          const repoName = decodeSegment(gitMatch[2]);
          const suffix = gitMatch[3] ?? '';
          if (method === 'GET' && suffix.startsWith('/info/refs')) {
            const service = queryOf(req).get('service') ?? '';
            handleInfoRefs(req, res, owner, repoName, service);
            return;
          }
          if (method === 'POST' && suffix === '/git-upload-pack') {
            handleUploadPack(req, res, owner, repoName, await readBody(req));
            return;
          }
          if (method === 'POST' && suffix === '/git-receive-pack') {
            handleReceivePack(req, res, owner, repoName, await readBody(req));
            return;
          }
          notFound(res);
          return;
        }

        // GraphQL and MCP need the bearer token.
        if (path === '/api/graphql') {
          if (method !== 'POST') { notFound(res); return; }
          if (!authorized(req)) { unauthorized(res); return; }
          await handleGraphQL(req, res, await readBody(req));
          return;
        }

        if (path === '/mcp') {
          if (method !== 'POST') { notFound(res); return; }
          if (!authorized(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            return;
          }
          await handleMcp(req, res, await readBody(req));
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) { unauthorized(res); return; }
          const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
          const rawBody = needsBody ? await readBody(req) : Buffer.alloc(0);
          await handleRest(req, res, path, rawBody);
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
