// store.ts — the forge's in-memory store: repositories, git objects and refs,
// issues, labels, comments and pull requests, plus the tree/commit building the
// contents API and the merge path need.
//
// One process, one owner: the bearer <redacted> names a single login, and the first
// owner name the server sees on any owner-scoped route becomes that login. A
// repository under any other owner is 404, never 403. All server-built commits
// use a fixed clock (a counter off one epoch) so two runs leave identical bytes.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './git.ts';

export const FORGE_IDENTITY = 'Forge <forge@make.fun>';
const EPOCH_SEC = 1700000000;

export interface Label { name: string; color: string; }
export interface Issue {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; seq: number;
  createdAt: string; updatedAt: string; userLogin: string;
}
export interface Comment { id: number; body: string; userLogin: string; createdAt: string; }
export interface Pull {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null;
  mergeCommitSha: string | null; head: string; base: string;
  headSha: string; baseSha: string; seq: number;
  createdAt: string; updatedAt: string; userLogin: string;
}

export class Repo {
  id: number;
  name: string;
  owner: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  issues: Issue[] = [];
  nextIssue = 1;
  pulls: Pull[] = [];
  nextPull = 1;
  labels = new Map<string, Label>();
  comments = new Map<number, Comment[]>();
  nextCommentId = 1;
  seq = 0;

  constructor(id: number, name: string, owner: string | null, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string { return `${this.owner ?? 'owner'}/${this.name}`; }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  refTip(ref: string): string | undefined { return this.refs.get(ref); }

  branchTip(branch: string): string | undefined { return this.refs.get(`refs/heads/${branch}`); }

  /** The tip commit of a branch name, a ref, or a bare sha. */
  resolveTip(ref: string): string | undefined {
    if (isOid(ref)) return this.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return this.refs.get(ref);
    return this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`);
  }

  /** Walk a tip's ancestry newest-first. */
  commitHistory(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** The commit object of a tip, or null. */
  commitOf(tip: string | undefined): { oid: string; tree: string; parents: string[]; message: string } | null {
    if (!tip) return null;
    const object = this.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    return { oid: tip, tree: parsed.tree, parents: parsed.parents, message: parsed.message };
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  ownerLogin: string | null = null;
  private clock = 0;

  /** A deterministic timestamp: one second per event off a fixed epoch. */
  stamp(): string {
    this.clock += 1;
    return new Date((EPOCH_SEC + this.clock) * 1000).toISOString();
  }

  /** A deterministic commit timestamp (seconds). */
  commitStamp(): number {
    this.clock += 1;
    return EPOCH_SEC + this.clock;
  }

  /** Adopt the first owner name seen; later names must match it. */
  adoptOwner(name: string): void {
    if (this.ownerLogin === null) {
      this.ownerLogin = name;
      for (const repo of this.repos.values()) if (repo.owner === null) repo.owner = name;
    }
  }

  /** True when `name` is the token owner's login (adopting it when unknown). */
  isOwner(name: string): boolean {
    this.adoptOwner(name);
    return this.ownerLogin === name;
  }

  getRepo(name: string): Repo | undefined { return this.repos.get(name); }

  /** A repo by name, only when `owner` is the token owner. */
  getRepoFor(owner: string, name: string): Repo | undefined {
    if (!this.isOwner(owner)) return undefined;
    const repo = this.repos.get(name);
    if (!repo) return undefined;
    if (repo.owner !== null && repo.owner !== owner) return undefined;
    return repo;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId++, name, this.ownerLogin, description, isPrivate);
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean { return this.repos.delete(name); }

  /** Repos owned by the token owner, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => this.ownerLogin === null || repo.owner === null || repo.owner === this.ownerLogin);
  }

  // ------------------------------------------------------------------ trees

  /** Rebuild the nested trees for a flat path -> blob map, returning the root oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    interface Node { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, Node>; }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const dir = segments[index];
        if (!node.dirs.has(dir)) node.dirs.set(dir, make());
        node = node.dirs.get(dir)!;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return repo.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Commit one file change on `branch`, creating the branch from the default tip when missing. */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
    const blobSha = repo.putObject('blob', content);
    let tip = repo.branchTip(branch);
    if (tip === undefined && branch !== repo.defaultBranch) {
      tip = repo.branchTip(repo.defaultBranch);
      if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
    }
    const files = new Map<string, { mode: string; oid: string }>();
    if (tip !== undefined) {
      const commit = repo.commitOf(tip);
      if (commit) for (const [p, entry] of flattenTree(commit.tree, (oid) => repo.objects.get(oid))) files.set(p, entry);
    }
    files.set(path, { mode: '100644', oid: blobSha });
    const tree = this.buildTreeFromFiles(repo, files);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = repo.putObject('commit', buildCommit(tree, parents, message.endsWith('\n') ? message : `${message}\n`, FORGE_IDENTITY, this.commitStamp()));
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete a file on the default branch (or `branch`), committing the removal. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const tip = repo.branchTip(branch);
    if (tip === undefined) return null;
    const commit = repo.commitOf(tip);
    if (!commit) return null;
    const files = flattenTree(commit.tree, (oid) => repo.objects.get(oid));
    if (!files.has(path)) return null;
    files.delete(path);
    const tree = this.buildTreeFromFiles(repo, files);
    const commitSha = repo.putObject('commit', buildCommit(tree, [tip], message.endsWith('\n') ? message : `${message}\n`, FORGE_IDENTITY, this.commitStamp()));
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return commitSha;
  }

  /** The blob bytes of a path at a tip commit, or null. */
  fileAt(repo: Repo, tip: string, path: string): { oid: string; data: Buffer } | null {
    const commit = repo.commitOf(tip);
    if (!commit) return null;
    const entry = flattenTree(commit.tree, (oid) => repo.objects.get(oid)).get(path);
    if (!entry) return null;
    const object = repo.objects.get(entry.oid);
    if (!object || object.type !== 'blob') return null;
    return { oid: entry.oid, data: object.data };
  }
}

// ---------------------------------------------------------------------------
// global (Relay) ids — opaque, stable, base64 of a typed key
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`forge:${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    if (!text.startsWith('forge:')) return null;
    const segments = text.split(':');
    if (segments.length < 3) return null;
    return { kind: segments[1], parts: segments.slice(2) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// issues, pulls, merge, diff — methods on the store, kept beside the store
// ---------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string { return globalId('repo', repo.id); }
export function issueGlobalId(repo: Repo, issue: Issue): string { return globalId('issue', repo.id, issue.number); }
export function pullGlobalId(repo: Repo, pull: Pull): string { return globalId('pr', repo.id, pull.number); }
export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return globalId('comment', repo.id, issue.number, comment.id);
}

export function createIssue(store: Store, repo: Repo, title: string, body: string, labels: Label[]): Issue {
  repo.seq += 1;
  const now = store.stamp();
  const issue: Issue = {
    id: repo.id * 100000 + repo.nextIssue,
    number: repo.nextIssue++,
    title, body, state: 'open', labels: [...labels],
    seq: repo.seq, createdAt: now, updatedAt: now,
    userLogin: store.ownerLogin ?? 'owner',
  };
  repo.issues.push(issue);
  return issue;
}

export function createPull(store: Store, repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = repo.branchTip(head);
  const baseSha = repo.branchTip(base);
  if (headSha === undefined || baseSha === undefined) return null;
  repo.seq += 1;
  const now = store.stamp();
  const pull: Pull = {
    id: repo.id * 100000 + repo.nextPull,
    number: repo.nextPull++,
    title, body, state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
    head, base, headSha, baseSha, seq: repo.seq,
    createdAt: now, updatedAt: now,
    userLogin: store.ownerLogin ?? 'owner',
  };
  repo.pulls.push(pull);
  return pull;
}

/** Files changed between two tips: path -> {status, oldOid, newOid}. */
export function diffTips(repo: Repo, baseTip: string, headTip: string): Map<string, { status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
  const out = new Map<string, { status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }>();
  const baseCommit = repo.commitOf(baseTip);
  const headCommit = repo.commitOf(headTip);
  const baseFiles = baseCommit ? flattenTree(baseCommit.tree, (oid) => repo.objects.get(oid)) : new Map();
  const headFiles = headCommit ? flattenTree(headCommit.tree, (oid) => repo.objects.get(oid)) : new Map();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const oldEntry = baseFiles.get(path);
    const newEntry = headFiles.get(path);
    if (oldEntry && !newEntry) out.set(path, { status: 'removed', oldOid: oldEntry.oid, newOid: null });
    else if (!oldEntry && newEntry) out.set(path, { status: 'added', oldOid: null, newOid: newEntry.oid });
    else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) out.set(path, { status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
  }
  return out;
}

function countLines(data: Buffer | null): number {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  return text.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === '')).length;
}

/** Per-file change counts for a pull request's files list. */
export function pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const diff = diffTips(repo, pull.baseSha, pull.headSha);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const [filename, change] of [...diff.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const oldData = change.oldOid ? repo.objects.get(change.oldOid)?.data ?? null : null;
    const newData = change.newOid ? repo.objects.get(change.newOid)?.data ?? null : null;
    let additions = 0;
    let deletions = 0;
    if (change.status === 'added') additions = countLines(newData);
    else if (change.status === 'removed') deletions = countLines(oldData);
    else {
      // A line-count diff: lines present in the new blob but not the old, and the reverse.
      const oldLines = new Set((oldData?.toString('utf8') ?? '').split('\n'));
      const newLines = (newData?.toString('utf8') ?? '').split('\n');
      const oldList = (oldData?.toString('utf8') ?? '').split('\n');
      const newSet = new Set(newLines);
      additions = newLines.filter((line) => line !== '' && !oldLines.has(line)).length;
      deletions = oldList.filter((line) => line !== '' && !newSet.has(line)).length;
      if (additions === 0 && deletions === 0) { additions = 1; }
    }
    out.push({ filename, status: change.status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/**
 * Whether merging `pull` would conflict: a file the pull changes whose content
 * on the default branch has moved since the pull's base.
 */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.branchTip(pull.base);
  if (!baseTip) return false;
  const diff = diffTips(repo, pull.baseSha, pull.headSha);
  if (diff.size === 0) return false;
  const baseCommit = repo.commitOf(pull.baseSha);
  const tipCommit = repo.commitOf(baseTip);
  const baseFiles = baseCommit ? flattenTree(baseCommit.tree, (oid) => repo.objects.get(oid)) : new Map();
  const tipFiles = tipCommit ? flattenTree(tipCommit.tree, (oid) => repo.objects.get(oid)) : new Map();
  for (const path of diff.keys()) {
    const atBase = baseFiles.get(path)?.oid ?? null;
    const atTip = tipFiles.get(path)?.oid ?? null;
    if (atBase !== atTip) return true;
  }
  return false;
}

/**
 * Squash-merge a pull request onto its base branch: one commit whose tree is
 * the base tip's tree with the pull's changed files overlaid, parented on the
 * base tip. Returns the merge commit sha, or null when conflicted.
 */
export function mergePull(store: Store, repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open' || pull.merged) return null;
  if (pullConflicts(repo, pull)) return null;
  const baseTip = repo.branchTip(pull.base);
  const headTip = repo.branchTip(pull.head);
  if (!baseTip || !headTip) return null;
  const baseCommit = repo.commitOf(baseTip);
  const headCommit = repo.commitOf(headTip);
  if (!baseCommit || !headCommit) return null;
  const files = flattenTree(baseCommit.tree, (oid) => repo.objects.get(oid));
  const diff = diffTips(repo, pull.baseSha, headTip);
  for (const [path, change] of diff) {
    if (change.status === 'removed') files.delete(path);
    else if (change.newOid) files.set(path, { mode: '100644', oid: change.newOid });
  }
  const tree = store.buildTreeFromFiles(repo, files);
  const message = `${pull.title}\n\nSquash-merged pull request #${pull.number}.\n`;
  const commitSha = repo.putObject('commit', buildCommit(tree, [baseTip], message, FORGE_IDENTITY, store.commitStamp()));
  repo.refs.set(`refs/heads/${pull.base}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.stamp();
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = pull.mergedAt;
  return commitSha;
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.ownerLogin ?? 'owner';
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    clone_url: `https://example.invalid/${owner}/${repo.name}.git`,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? store.ownerLogin ?? 'owner';
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.userLogin, id: 1, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: repo.comments.get(issue.number)?.length ?? 0,
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? store.ownerLogin ?? 'owner';
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: !pullConflicts(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${owner}:${pull.base}` },
    user: { login: pull.userLogin, id: 1, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: '' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha,
    commit: {
      message: parsed.message.replace(/\n+$/, ''),
      author: ident(parsed.author),
      committer: ident(parsed.committer),
      tree: { sha: parsed.tree },
    },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
  };
}

/** The peeled commit of a tag object, or the oid itself when it is a commit. */
export function peelToCommit(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object) return oid;
  if (object.type === 'tag') return parseTag(object.data).object;
  return oid;
}

/** All refs of a repo, sorted by name, with HEAD first for advertisements. */
export function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** True when `ancestor` is in `descendant`'s history (or equal). */
export function fastForwardOk(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (!isOid(newOid) || !repo.objects.has(newOid)) return false;
  return isAncestor(oldOid, newOid, (oid) => repo.objects.get(oid));
}
