// graphql.ts — a small GraphQL executor for the documents gh and
// github-mcp-server send: queries, mutations, variables, aliases, inline
// fragments, input objects, enum literals and batched operation arrays.
//
// It is deliberately scoped to that surface: a hand-written tokenizer and a
// recursive-descent parser for selection sets, a field table per type, and
// validation that reports unknown fields the way the checks expect (HTTP 200
// with an `errors` array naming the field).

import {
  createIssue,
  createPull,
  globalId,
  issueGlobalId,
  mergePull,
  parseGlobalId,
  pullConflicts,
  pullFiles,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) { value += source[j + 1]; j += 2; }
        else { value += source[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    i += 1;
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[];
}
export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; type: string | null; selections: SelectionNode[] };

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; type: string }[];
  selections: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(source: string) { this.tokens = tokenize(source); }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }
  private expectPunct(value: string): void {
    const token = this.next();
    if (!token || token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(): string {
    const token = this.next();
    if (!token || token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next()!.value as string;
        const variables: { name: string; type: string }[] = [];
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            let typeName = '';
            while (this.peek() && !(this.peek()?.kind === 'punct' && ((this.peek() as { value: string }).value === ',' || (this.peek() as { value: string }).value === ')'))) {
              const part = this.next()!;
              typeName += part.kind === 'name' ? (part as { value: string }).value : (part as { value: string }).value;
            }
            variables.push({ name: varName, type: typeName });
            if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
              this.next();
              this.parseValue();
            }
            if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
          }
          this.expectPunct(')');
        }
        // Directives on the operation (@...) are skipped.
        while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
          this.next();
          this.expectName();
          if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
            this.next();
            let depth = 1;
            while (depth > 0 && this.pos < this.tokens.length) {
              const t = this.next()!;
              if (t.kind === 'punct' && t.value === '(') depth += 1;
              if (t.kind === 'punct' && t.value === ')') depth -= 1;
            }
          }
        }
        operations.push({ type, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token?.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        this.expectName(); // 'on'
        const typeName = this.expectName();
        void typeName;
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      this.next();
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '}') { this.next(); break; }
      if (token?.kind === 'spread') {
        this.next();
        if (this.peek()?.kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeName = this.expectName();
          selections.push({ kind: 'fragment', type: typeName, selections: this.parseSelectionSet() });
        } else if (this.peek()?.kind === 'name') {
          const fragName = this.next()!.value as string;
          selections.push({ kind: 'fragment', type: `...${fragName}`, selections: [] });
        }
        continue;
      }
      if (token?.kind === 'name') {
        const first = this.next()!.value as string;
        let alias: string | null = null;
        let name = first;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
          this.next();
          alias = first;
          name = this.expectName();
        }
        const args: { name: string; value: ValueNode }[] = [];
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            const argName = this.expectName();
            this.expectPunct(':');
            args.push({ name: argName, value: this.parseValue() });
          }
          this.expectPunct(')');
        }
        // Directives on the field (@...) are skipped.
        while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
          this.next();
          this.expectName();
          if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
            this.next();
            let depth = 1;
            while (depth > 0 && this.pos < this.tokens.length) {
              const t = this.next()!;
              if (t.kind === 'punct' && t.value === '(') depth += 1;
              if (t.kind === 'punct' && t.value === ')') depth -= 1;
            }
          }
        }
        const sub: SelectionNode[] = this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{'
          ? this.parseSelectionSet()
          : [];
        selections.push({ kind: 'field', field: { alias, name, args, selections: sub } });
        continue;
      }
      this.next();
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (!token) throw new Error('unexpected end of value');
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

/** Resolve a value node against the operation's variables. */
export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema surface (the fields gh feature-detects, plus what the checks read)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'resourcePath', 'databaseId'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

export interface GraphQLContext {
  store: Store;
  viewerLogin: string;
}

interface ExecState {
  errors: { message: string }[];
  fragments: Map<string, SelectionNode[]>;
  variables: Record<string, unknown>;
}

function argValue(field: FieldNode, name: string, state: ExecState): unknown {
  const arg = field.args.find((candidate) => candidate.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, state.variables);
}

function objectArg(field: FieldNode, name: string, state: ExecState): Record<string, unknown> {
  const value = argValue(field, name, state);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueNode(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: { __typename: 'User', login: issue.userLogin },
    url: `/api/v3/repos/${repo.owner ?? 'owner'}/${repo.name}/issues/${issue.number}`,
    databaseId: issue.id,
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: { __typename: 'Ref', name: pull.head },
    baseRef: { __typename: 'Ref', name: pull.base },
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    author: { __typename: 'User', login: pull.userLogin },
    url: `/api/v3/repos/${repo.owner ?? 'owner'}/${repo.name}/pull/${pull.number}`,
  };
}

function repoNode(ctx: GraphQLContext, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? ctx.viewerLogin;
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: { __typename: 'User', login: owner, id: 1 },
    defaultBranchRef: repo.branchTip(repo.defaultBranch) !== undefined ? { __typename: 'Ref', name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.isPrivate,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    _repo: repo,
  };
}

type AnyRecord = Record<string, unknown>;

/** Resolve one selection set against a typed value. Unknown fields become errors. */
function resolveSelections(
  ctx: GraphQLContext,
  state: ExecState,
  typeName: string,
  value: AnyRecord | null,
  selections: SelectionNode[],
): AnyRecord | null {
  if (value === null) return null;
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.type !== null && selection.type.startsWith('...')) {
        const frag = state.fragments.get(selection.type.slice(3));
        if (frag) Object.assign(out, resolveSelections(ctx, state, typeName, value, frag) ?? {});
        continue;
      }
      if (selection.type !== null && selection.type !== typeName) continue;
      Object.assign(out, resolveSelections(ctx, state, selection.type ?? typeName, value, selection.selections) ?? {});
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    out[key] = resolveField(ctx, state, typeName, value, field);
  }
  return out;
}

function unknownField(state: ExecState, typeName: string, fieldName: string): null {
  state.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveField(
  ctx: GraphQLContext,
  state: ExecState,
  typeName: string,
  value: AnyRecord,
  field: FieldNode,
): unknown {
  const { store } = ctx;
  // __typename is always available.
  if (field.name === '__typename') return value.__typename ?? typeName;

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      return resolveSelections(ctx, state, 'User', { __typename: 'User', login: ctx.viewerLogin, id: 1 }, field.selections);
    }
    if (field.name === 'repository') {
      const owner = String(argValue(field, 'owner', state) ?? '');
      const name = String(argValue(field, 'name', state) ?? '');
      const repo = store.getRepoFor(owner, name);
      if (!repo) return null;
      return resolveSelections(ctx, state, 'Repository', repoNode(ctx, repo), field.selections);
    }
    if (field.name === 'node') {
      const id = String(argValue(field, 'id', state) ?? '');
      const parsed = parseGlobalId(id);
      if (parsed?.kind === 'repo') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(parsed.parts[0]));
        if (!repo) return null;
        return resolveSelections(ctx, state, 'Repository', repoNode(ctx, repo), field.selections);
      }
      if (parsed?.kind === 'issue') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(parsed.parts[0]));
        const issue = repo?.issues.find((candidate) => candidate.number === Number(parsed.parts[1]));
        if (!repo || !issue) return null;
        return resolveSelections(ctx, state, 'Issue', issueNode(store, repo, issue), field.selections);
      }
      if (parsed?.kind === 'pr') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(parsed.parts[0]));
        const pull = repo?.pulls.find((candidate) => candidate.number === Number(parsed.parts[1]));
        if (!repo || !pull) return null;
        return resolveSelections(ctx, state, 'PullRequest', pullNode(store, repo, pull), field.selections);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(argValue(field, 'name', state) ?? '');
      const fields = TYPE_FIELDS[name];
      const enums = ENUM_VALUES[name];
      if (fields === undefined && enums === undefined) return null;
      const typeValue: AnyRecord = { __typename: '__Type', name, kind: enums !== undefined ? 'ENUM' : 'OBJECT' };
      return resolveSelections(ctx, state, '__Type', typeValue, field.selections);
    }
    if (field.name === '__schema') {
      return resolveSelections(ctx, state, '__Schema', { __typename: '__Schema' }, field.selections);
    }
    return unknownField(state, 'Query', field.name);
  }

  if (typeName === '__Type') {
    if (field.name === 'fields') {
      const name = String(value.name ?? '');
      return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName }));
    }
    if (field.name === 'enumValues') {
      const name = String(value.name ?? '');
      return (ENUM_VALUES[name] ?? []).map((enumName) => ({ __typename: '__EnumValue', name: enumName }));
    }
    if (field.name === 'name') return value.name ?? null;
    if (field.name === 'kind') return value.kind ?? null;
    return unknownField(state, '__Type', field.name);
  }

  if (typeName === '__Schema') {
    if (field.name === 'types') return [];
    if (field.name === 'queryType') return { __typename: '__Type', name: 'Query' };
    if (field.name === 'mutationType') return { __typename: '__Type', name: 'Mutation' };
    return unknownField(state, '__Schema', field.name);
  }

  if (typeName === 'Repository') {
    const repo = value._repo as Repo | undefined;
    if (!repo) return unknownField(state, 'Repository', field.name);
    if (field.name === 'issue') {
      const number = Number(argValue(field, 'number', state));
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (!issue) return null;
      return resolveSelections(ctx, state, 'Issue', issueNode(store, repo, issue), field.selections);
    }
    if (field.name === 'issues') {
      let issues = [...repo.issues];
      const states = argValue(field, 'states', state);
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((entry) => String(entry).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = objectArg(field, 'orderBy', state);
      if (orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') issues.sort((a, b) => b.seq - a.seq || b.number - a.number);
      else if (orderBy.field === 'CREATED_AT' && orderBy.direction === 'ASC') issues.sort((a, b) => a.seq - b.seq || a.number - b.number);
      else issues.sort((a, b) => a.number - b.number);
      const after = numberFromCursor(argValue(field, 'after', state));
      if (after !== null) {
        const index = issues.findIndex((issue) => issue.number === after);
        issues = index >= 0 ? issues.slice(index + 1) : issues;
      }
      const first = argValue(field, 'first', state);
      const page = typeof first === 'number' ? issues.slice(0, first) : issues;
      const hasNextPage = typeof first === 'number' ? issues.length > first : false;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
      const connection: AnyRecord = {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueNode(store, repo, issue)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, endCursor, startCursor: page.length > 0 ? cursorFor(page[0].number) : null },
        totalCount: issues.length,
      };
      return resolveSelections(ctx, state, 'IssueConnection', connection, field.selections);
    }
    if (field.name === 'pullRequests') {
      let pulls = [...repo.pulls];
      const first = argValue(field, 'first', state);
      if (typeof first === 'number') pulls = pulls.slice(0, first);
      const connection: AnyRecord = {
        __typename: 'PullRequestConnection',
        nodes: pulls.map((pull) => pullNode(store, repo, pull)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
        totalCount: repo.pulls.length,
      };
      return resolveSelections(ctx, state, 'PullRequestConnection', connection, field.selections);
    }
    if (field.name === 'pullRequest') {
      const number = Number(argValue(field, 'number', state));
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return null;
      return resolveSelections(ctx, state, 'PullRequest', pullNode(store, repo, pull), field.selections);
    }
    if (field.name === 'owner') {
      return resolveSelections(ctx, state, 'User', { __typename: 'User', login: repo.owner ?? ctx.viewerLogin, id: 1 }, field.selections);
    }
    if (field.name === 'defaultBranchRef') {
      const ref = value.defaultBranchRef as AnyRecord | null;
      if (!ref) return null;
      return resolveSelections(ctx, state, 'Ref', ref, field.selections);
    }
    if (['id', 'databaseId', 'name', 'nameWithOwner', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'url', 'createdAt', 'updatedAt'].includes(field.name)) {
      return value[field.name] ?? null;
    }
    return unknownField(state, 'Repository', field.name);
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') {
      const nodes = (value.nodes as AnyRecord[]) ?? [];
      const childType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
      return nodes.map((node) => resolveSelections(ctx, state, childType, node, field.selections));
    }
    if (field.name === 'pageInfo') {
      return resolveSelections(ctx, state, 'PageInfo', (value.pageInfo as AnyRecord) ?? {}, field.selections);
    }
    if (field.name === 'totalCount') return value.totalCount ?? null;
    return unknownField(state, typeName, field.name);
  }

  if (typeName === 'PageInfo') {
    if (['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'].includes(field.name)) return value[field.name] ?? null;
    return unknownField(state, 'PageInfo', field.name);
  }

  if (typeName === 'Issue') {
    if (['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'databaseId', 'url'].includes(field.name)) return value[field.name] ?? null;
    if (field.name === 'author') return resolveSelections(ctx, state, 'User', (value.author as AnyRecord) ?? { __typename: 'User', login: '' }, field.selections);
    if (field.name === 'labels') return [];
    if (field.name === 'comments') return { __typename: 'IssueCommentConnection', nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    if (field.name === 'resourcePath') return '';
    return unknownField(state, 'Issue', field.name);
  }

  if (typeName === 'PullRequest') {
    if (['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'createdAt', 'updatedAt', 'url'].includes(field.name)) return value[field.name] ?? null;
    if (field.name === 'headRef' || field.name === 'baseRef') {
      return resolveSelections(ctx, state, 'Ref', (value[field.name] as AnyRecord) ?? { __typename: 'Ref', name: '' }, field.selections);
    }
    if (field.name === 'author') return resolveSelections(ctx, state, 'User', (value.author as AnyRecord) ?? { __typename: 'User', login: '' }, field.selections);
    if (field.name === 'files') {
      const repo = findPullRepo(ctx, String(value.id ?? ''));
      const pull = repo?.pulls.find((candidate) => pullGlobalId(repo, candidate) === value.id);
      const files = repo && pull ? pullFiles(repo, pull).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, filename: file.filename })) : [];
      const first = argValue(field, 'first', state);
      const page = typeof first === 'number' ? files.slice(0, first) : files;
      const connection: AnyRecord = {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
        totalCount: files.length,
      };
      return resolveSelections(ctx, state, 'PullRequestChangedFileConnection', connection, field.selections);
    }
    return unknownField(state, 'PullRequest', field.name);
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path' || field.name === 'filename') return value[field.name] ?? null;
    return unknownField(state, 'PullRequestChangedFile', field.name);
  }

  if (typeName === 'User' || typeName === 'Ref') {
    if (field.name === 'login' || field.name === 'name' || field.name === 'id') return value[field.name] ?? null;
    return unknownField(state, typeName, field.name);
  }

  if (typeName === 'Mutation') return unknownField(state, 'Mutation', field.name);

  // Mutation payload wrappers: createIssue.issue, closeIssue.issue,
  // createPullRequest.pullRequest, mergePullRequest.pullRequest, addComment.commentEdge.
  if (typeName.endsWith('Payload')) {
    return resolvePayload(ctx, state, typeName, value, field);
  }

  if (typeName === 'IssueCommentEdge') {
    if (field.name === 'node') {
      return resolveSelections(ctx, state, 'IssueComment', (value.node as AnyRecord) ?? {}, field.selections);
    }
    return unknownField(state, 'IssueCommentEdge', field.name);
  }

  if (typeName === 'IssueComment') {
    if (field.name === 'id' || field.name === 'body') return value[field.name] ?? null;
    return unknownField(state, 'IssueComment', field.name);
  }

  return unknownField(state, typeName, field.name);
}

function findPullRepo(ctx: GraphQLContext, pullId: string): Repo | undefined {
  const parsed = parseGlobalId(pullId);
  if (parsed?.kind !== 'pr') return undefined;
  return [...ctx.store.repos.values()].find((repo) => repo.id === Number(parsed.parts[0]));
}

function findIssueRepo(ctx: GraphQLContext, issueId: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(issueId);
  if (parsed?.kind !== 'issue') return null;
  const repo = [...ctx.store.repos.values()].find((candidate) => candidate.id === Number(parsed.parts[0]));
  if (!repo) return null;
  const issue = repo.issues.find((candidate) => candidate.number === Number(parsed.parts[1]));
  return issue ? { repo, issue } : null;
}

/** Execute one mutation's top-level fields. */
function resolveMutation(ctx: GraphQLContext, state: ExecState, field: FieldNode): unknown {
  const { store } = ctx;
  const input = objectArg(field, 'input', state);
  if (field.name === 'createIssue') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    const repo = parsed?.kind === 'repo'
      ? [...store.repos.values()].find((candidate) => candidate.id === Number(parsed.parts[0]))
      : undefined;
    if (!repo) {
      state.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const issue = createIssue(store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return resolveSelections(ctx, state, 'CreateIssuePayload', { __typename: 'CreateIssuePayload', issue: issueNode(store, repo, issue) }, field.selections);
  }
  if (field.name === 'closeIssue') {
    const found = findIssueRepo(ctx, String(input.issueId ?? ''));
    if (!found) {
      state.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = store.stamp();
    return resolveSelections(ctx, state, 'CloseIssuePayload', { __typename: 'CloseIssuePayload', issue: issueNode(store, found.repo, found.issue) }, field.selections);
  }
  if (field.name === 'createPullRequest') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    const repo = parsed?.kind === 'repo'
      ? [...store.repos.values()].find((candidate) => candidate.id === Number(parsed.parts[0]))
      : undefined;
    if (!repo) {
      state.errors.push({ message: 'createPullRequest: repository not found' });
      return null;
    }
    const pull = createPull(store, repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if (!pull) {
      state.errors.push({ message: 'createPullRequest: head or base branch not found' });
      return null;
    }
    return resolveSelections(ctx, state, 'CreatePullRequestPayload', { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(store, repo, pull) }, field.selections);
  }
  if (field.name === 'mergePullRequest') {
    const repo = findPullRepo(ctx, String(input.pullRequestId ?? ''));
    const pull = repo?.pulls.find((candidate) => pullGlobalId(repo, candidate) === input.pullRequestId);
    if (!repo || !pull) {
      state.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    const merged = mergePull(store, repo, pull);
    if (merged === null) {
      state.errors.push({ message: 'mergePullRequest: pull request is conflicted' });
      return null;
    }
    return resolveSelections(ctx, state, 'MergePullRequestPayload', { __typename: 'MergePullRequestPayload', pullRequest: pullNode(store, repo, pull) }, field.selections);
  }
  if (field.name === 'addComment') {
    const found = findIssueRepo(ctx, String(input.subjectId ?? ''));
    if (!found) {
      state.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
    const comment = {
      id: found.repo.nextCommentId++,
      body: String(input.body ?? ''),
      userLogin: ctx.viewerLogin,
      createdAt: store.stamp(),
    };
    const list = found.repo.comments.get(found.issue.number) ?? [];
    list.push(comment);
    found.repo.comments.set(found.issue.number, list);
    const node = { __typename: 'IssueComment', id: globalId('comment', found.repo.id, found.issue.number, comment.id), body: comment.body };
    return resolveSelections(ctx, state, 'AddCommentPayload', { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node } }, field.selections);
  }
  state.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

/** Payload types: resolve the one nested object field they carry. */
function resolvePayload(ctx: GraphQLContext, state: ExecState, typeName: string, value: AnyRecord, field: FieldNode): unknown {
  const key = field.alias ?? field.name;
  void key;
  const nested = value[field.name] as AnyRecord | undefined;
  if (nested === undefined || nested === null) return null;
  const childType = field.name === 'issue' ? 'Issue' : field.name === 'pullRequest' ? 'PullRequest' : field.name === 'commentEdge' ? 'IssueCommentEdge' : typeName;
  if (field.name === 'commentEdge') {
    return resolveSelections(ctx, state, 'IssueCommentEdge', nested, field.selections);
  }
  return resolveSelections(ctx, state, childType, nested, field.selections);
}

/** Execute one operation document. Returns {data, errors?}. */
export function executeOperation(ctx: GraphQLContext, query: string, variables: Record<string, unknown>, operationName?: string | null): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  let parsed: { operations: Operation[]; fragments: Map<string, SelectionNode[]> };
  try {
    parsed = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const operation = operationName
    ? parsed.operations.find((candidate) => candidate.name === operationName)
    : parsed.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation found' }] };
  const state: ExecState = { errors: [], fragments: parsed.fragments, variables };
  const data: Record<string, unknown> = {};
  if (operation.type === 'mutation') {
    for (const selection of operation.selections) {
      if (selection.kind !== 'field') continue;
      const key = selection.field.alias ?? selection.field.name;
      if (['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'].includes(selection.field.name)) {
        data[key] = resolveMutation(ctx, state, selection.field);
      } else {
        state.errors.push({ message: `Cannot query field "${selection.field.name}" on type "Mutation".` });
        data[key] = null;
      }
    }
  } else {
    for (const selection of operation.selections) {
      if (selection.kind === 'field') {
        const key = selection.field.alias ?? selection.field.name;
        data[key] = resolveField(ctx, state, 'Query', { __typename: 'Query' }, selection.field);
      } else if (selection.kind === 'fragment') {
        const resolved = resolveSelections(ctx, state, 'Query', { __typename: 'Query' }, [selection]);
        if (resolved) Object.assign(data, resolved);
      }
    }
  }
  // Payload wrappers (createIssue.issue, mergePullRequest.pullRequest, addComment.commentEdge)
  // resolve their nested object through resolveSelections with a payload-aware path:
  // the mutation resolvers above already produced resolved payloads via a shim below.
  const result: { data: Record<string, unknown> | null; errors?: { message: string }[] } = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}
