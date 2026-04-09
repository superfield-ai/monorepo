import { setupServer, type SetupServer } from "msw/node";
import { http, HttpResponse, type HttpHandler } from "msw";

/**
 * GitHub MSW seed helper (#95).
 *
 * Stands up a stateful in-memory fake of the GitHub REST API big enough to
 * drive `runSlot`, `tickDevLoop`, session CRUD, `runPrePRSelfAudit`, and the
 * surrounding dev-loop plumbing. The handlers read from and write to a single
 * in-memory `GitHubState` store so tests can drive a full tick without
 * brittle call-ordering assertions.
 *
 * The intercepted base URL is `https://api.github.com` — Octokit's default.
 * All unknown endpoints fail loudly (500 + explicit error message) rather
 * than passing through to the real network.
 */

// ---------- Seed interfaces (contract with tests + harness) ----------

export interface SeedComment {
  id?: number;
  body: string;
}

export interface SeedIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments?: SeedComment[];
}

export interface SeedPR {
  number: number;
  issueNumber: number;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
}

export interface SeedCheck {
  sha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | null;
}

export interface SeedGitHubOpts {
  owner: string;
  repo: string;
  planBody: string;
  issues?: SeedIssue[];
  prs?: SeedPR[];
  checks?: SeedCheck[];
}

export interface GitHubState {
  getIssue(n: number): SeedIssue | undefined;
  getComments(issueNumber: number): StoredComment[];
  getPRForIssue(issueNumber: number): SeedPR | undefined;
  getCheckRun(args: { sha: string; name: string }): SeedCheck | undefined;
  listIssues(filter?: { label?: string }): SeedIssue[];
  getAllComments(): StoredComment[];
}

export interface SeededGitHub {
  server: SetupServer;
  state: GitHubState;
}

// ---------- Internal store types ----------

export interface StoredComment {
  id: number;
  issueNumber: number;
  body: string;
  created_at: string;
  updated_at: string;
}

interface Store {
  owner: string;
  repo: string;
  issuesByNumber: Map<number, SeedIssue>;
  commentsByIssue: Map<number, StoredComment[]>;
  commentsById: Map<number, StoredComment>;
  prsByNumber: Map<number, SeedPR>;
  prByIssue: Map<number, number>;
  checks: SeedCheck[];
  nextCommentId: number;
}

// ---------- Seed function ----------

export function seedGitHub(opts: SeedGitHubOpts): SeededGitHub {
  const store: Store = {
    owner: opts.owner,
    repo: opts.repo,
    issuesByNumber: new Map(),
    commentsByIssue: new Map(),
    commentsById: new Map(),
    prsByNumber: new Map(),
    prByIssue: new Map(),
    checks: [...(opts.checks ?? [])],
    nextCommentId: 1,
  };

  // Default Plan issue on number 1 unless overridden by a seeded issue with
  // number 1 (then the caller is fully in charge of its shape).
  const hasExplicitPlan = (opts.issues ?? []).some((i) => i.number === 1);
  if (!hasExplicitPlan) {
    store.issuesByNumber.set(1, {
      number: 1,
      title: "Plan",
      body: opts.planBody,
      state: "open",
      labels: ["plan"],
    });
  }

  for (const issue of opts.issues ?? []) {
    const copy: SeedIssue = {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [...issue.labels],
    };
    store.issuesByNumber.set(issue.number, copy);
    if (issue.comments) {
      for (const c of issue.comments) {
        addComment(store, issue.number, c.body, c.id);
      }
    }
  }

  for (const pr of opts.prs ?? []) {
    store.prsByNumber.set(pr.number, { ...pr });
    store.prByIssue.set(pr.issueNumber, pr.number);
  }

  const state: GitHubState = {
    getIssue: (n) => cloneIssue(store.issuesByNumber.get(n)),
    getComments: (n) =>
      (store.commentsByIssue.get(n) ?? []).map((c) => ({ ...c })),
    getPRForIssue: (n) => {
      const prNum = store.prByIssue.get(n);
      if (prNum === undefined) return undefined;
      const pr = store.prsByNumber.get(prNum);
      return pr ? { ...pr } : undefined;
    },
    getCheckRun: ({ sha, name }) =>
      store.checks.find((c) => c.sha === sha && c.name === name),
    listIssues: (filter) => {
      const issues = Array.from(store.issuesByNumber.values()).map(cloneIssue);
      if (filter?.label) {
        return issues
          .filter(
            (i): i is SeedIssue =>
              !!i && i.labels.includes(filter.label as string),
          )
          .map((i) => ({ ...i, labels: [...i.labels] }));
      }
      return issues.filter((i): i is SeedIssue => !!i);
    },
    getAllComments: () =>
      Array.from(store.commentsById.values()).map((c) => ({ ...c })),
  };

  const server = setupServer(...buildHandlers(store));
  return { server, state };
}

function cloneIssue(issue: SeedIssue | undefined): SeedIssue | undefined {
  if (!issue) return undefined;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: [...issue.labels],
  };
}

function addComment(
  store: Store,
  issueNumber: number,
  body: string,
  forcedId?: number,
): StoredComment {
  const id = forcedId ?? store.nextCommentId;
  if (forcedId !== undefined && forcedId >= store.nextCommentId) {
    store.nextCommentId = forcedId + 1;
  } else if (forcedId === undefined) {
    store.nextCommentId += 1;
  }
  const now = new Date().toISOString();
  const comment: StoredComment = {
    id,
    issueNumber,
    body,
    created_at: now,
    updated_at: now,
  };
  const list = store.commentsByIssue.get(issueNumber) ?? [];
  list.push(comment);
  store.commentsByIssue.set(issueNumber, list);
  store.commentsById.set(id, comment);
  return comment;
}

// ---------- Handlers ----------

function buildHandlers(store: Store): HttpHandler[] {
  const base = `https://api.github.com/repos/${store.owner}/${store.repo}`;

  function issueAsJson(issue: SeedIssue): Record<string, unknown> {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      html_url: `https://github.com/${store.owner}/${store.repo}/issues/${issue.number}`,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
    };
  }

  function commentAsJson(c: StoredComment): Record<string, unknown> {
    return {
      id: c.id,
      body: c.body,
      created_at: c.created_at,
      updated_at: c.updated_at,
      html_url: `https://github.com/${store.owner}/${store.repo}/issues/${c.issueNumber}#issuecomment-${c.id}`,
    };
  }

  function prAsJson(pr: SeedPR): Record<string, unknown> {
    return {
      number: pr.number,
      title: `PR #${pr.number}`,
      body: "",
      html_url: `https://github.com/${store.owner}/${store.repo}/pull/${pr.number}`,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.merged ? new Date().toISOString() : null,
      head: { ref: pr.head, sha: fakeSha(pr.head) },
      base: { ref: pr.base, sha: fakeSha(pr.base) },
    };
  }

  const handlers: HttpHandler[] = [
    // --- Issues ---
    http.get(`${base}/issues`, ({ request }) => {
      const url = new URL(request.url);
      const labelsParam = url.searchParams.get("labels");
      const stateParam = url.searchParams.get("state") ?? "open";
      const wanted = labelsParam
        ? labelsParam.split(",").map((s) => s.trim())
        : [];
      const filtered = Array.from(store.issuesByNumber.values()).filter((i) => {
        if (stateParam !== "all" && i.state !== stateParam) return false;
        if (wanted.length > 0) {
          return wanted.every((w) => i.labels.includes(w));
        }
        return true;
      });
      return HttpResponse.json(filtered.map(issueAsJson));
    }),

    http.get(`${base}/issues/:num`, ({ params }) => {
      const n = Number(params.num);
      const issue = store.issuesByNumber.get(n);
      if (!issue) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return HttpResponse.json(issueAsJson(issue));
    }),

    http.patch(`${base}/issues/:num`, async ({ params, request }) => {
      const n = Number(params.num);
      const issue = store.issuesByNumber.get(n);
      if (!issue) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      const patch = (await request.json()) as {
        body?: string;
        state?: "open" | "closed";
        labels?: string[];
        title?: string;
      };
      if (typeof patch.body === "string") issue.body = patch.body;
      if (patch.state === "open" || patch.state === "closed") {
        issue.state = patch.state;
      }
      if (Array.isArray(patch.labels)) issue.labels = [...patch.labels];
      if (typeof patch.title === "string") issue.title = patch.title;
      return HttpResponse.json(issueAsJson(issue));
    }),

    // Label mutations
    http.post(`${base}/issues/:num/labels`, async ({ params, request }) => {
      const n = Number(params.num);
      const issue = store.issuesByNumber.get(n);
      if (!issue) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      const body = (await request.json()) as { labels?: string[] };
      for (const l of body.labels ?? []) {
        if (!issue.labels.includes(l)) issue.labels.push(l);
      }
      return HttpResponse.json(issue.labels.map((name) => ({ name })));
    }),

    http.delete(`${base}/issues/:num/labels/:label`, ({ params }) => {
      const n = Number(params.num);
      const issue = store.issuesByNumber.get(n);
      if (!issue) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      const label = String(params.label);
      issue.labels = issue.labels.filter((l) => l !== label);
      return HttpResponse.json(issue.labels.map((name) => ({ name })));
    }),

    // --- Comments ---
    http.get(`${base}/issues/:num/comments`, ({ params }) => {
      const n = Number(params.num);
      const comments = store.commentsByIssue.get(n) ?? [];
      return HttpResponse.json(comments.map(commentAsJson));
    }),

    http.post(`${base}/issues/:num/comments`, async ({ params, request }) => {
      const n = Number(params.num);
      if (!store.issuesByNumber.has(n)) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      const body = (await request.json()) as { body?: string };
      const c = addComment(store, n, body.body ?? "");
      return HttpResponse.json(commentAsJson(c), { status: 201 });
    }),

    http.patch(
      `${base}/issues/comments/:commentId`,
      async ({ params, request }) => {
        const id = Number(params.commentId);
        const existing = store.commentsById.get(id);
        if (!existing) {
          return HttpResponse.json({ message: "Not Found" }, { status: 404 });
        }
        const body = (await request.json()) as { body?: string };
        if (typeof body.body === "string") existing.body = body.body;
        existing.updated_at = new Date().toISOString();
        return HttpResponse.json(commentAsJson(existing));
      },
    ),

    http.delete(`${base}/issues/comments/:commentId`, ({ params }) => {
      const id = Number(params.commentId);
      const existing = store.commentsById.get(id);
      if (!existing) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      store.commentsById.delete(id);
      const list = store.commentsByIssue.get(existing.issueNumber) ?? [];
      store.commentsByIssue.set(
        existing.issueNumber,
        list.filter((c) => c.id !== id),
      );
      return new HttpResponse(null, { status: 204 });
    }),

    // --- Issue creation ---
    http.post(`${base}/issues`, async ({ request }) => {
      const body = (await request.json()) as {
        title?: string;
        body?: string;
        labels?: string[];
      };
      const num = nextIssueNumber(store);
      const issue: SeedIssue = {
        number: num,
        title: body.title ?? "",
        body: body.body ?? "",
        state: "open",
        labels: body.labels ?? [],
      };
      store.issuesByNumber.set(num, issue);
      return HttpResponse.json(issueAsJson(issue), { status: 201 });
    }),

    // --- PRs ---
    http.post(`${base}/pulls`, async ({ request }) => {
      const body = (await request.json()) as {
        title?: string;
        head?: string;
        base?: string;
        body?: string;
      };
      const num = nextPRNumber(store);
      const pr: SeedPR = {
        number: num,
        issueNumber: extractIssueFromBranch(body.head ?? "") ?? num,
        head: body.head ?? "",
        base: body.base ?? "main",
        state: "open",
        merged: false,
      };
      store.prsByNumber.set(num, pr);
      store.prByIssue.set(pr.issueNumber, num);
      return HttpResponse.json(prAsJson(pr), { status: 201 });
    }),

    http.get(`${base}/pulls`, ({ request }) => {
      const url = new URL(request.url);
      const stateParam = url.searchParams.get("state") ?? "open";
      const list = Array.from(store.prsByNumber.values()).filter((p) => {
        if (stateParam === "all") return true;
        if (stateParam === "closed") return p.state === "closed";
        return p.state === "open";
      });
      return HttpResponse.json(list.map(prAsJson));
    }),

    http.get(`${base}/pulls/:num`, ({ params }) => {
      const n = Number(params.num);
      const pr = store.prsByNumber.get(n);
      if (!pr) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return HttpResponse.json(prAsJson(pr));
    }),

    http.get(`${base}/pulls/:num/files`, ({ params }) => {
      const n = Number(params.num);
      if (!store.prsByNumber.has(n)) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return HttpResponse.json([]);
    }),

    http.put(`${base}/pulls/:num/merge`, ({ params }) => {
      const n = Number(params.num);
      const pr = store.prsByNumber.get(n);
      if (!pr) {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      pr.state = "closed";
      pr.merged = true;
      // Mutate the linked issue to closed — runSlot's post-merge close
      // detection depends on this.
      const issue = store.issuesByNumber.get(pr.issueNumber);
      if (issue) issue.state = "closed";
      return HttpResponse.json({
        sha: fakeSha(pr.head),
        merged: true,
        message: "Pull Request successfully merged",
      });
    }),

    // --- Check runs ---
    http.get(`${base}/commits/:ref/check-runs`, ({ params }) => {
      const ref = String(params.ref);
      const matched = store.checks.filter((c) => c.sha === ref);
      const runs =
        matched.length > 0
          ? matched
          : [
              {
                sha: ref,
                name: "default",
                status: "completed" as const,
                conclusion: "success" as const,
              },
            ];
      return HttpResponse.json({
        total_count: runs.length,
        check_runs: runs.map((c, idx) => ({
          id: 10_000 + idx,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion ?? null,
          html_url: `https://github.com/${store.owner}/${store.repo}/runs/${10_000 + idx}`,
          head_sha: c.sha,
        })),
      });
    }),

    // --- Branch / head SHA ---
    http.get(`${base}/branches/:branch`, ({ params }) => {
      const branch = String(params.branch);
      return HttpResponse.json({
        name: branch,
        commit: { sha: fakeSha(branch) },
      });
    }),

    // --- Contents API (get / put) ---
    http.get(`${base}/contents/:path*`, () => {
      return HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.put(`${base}/contents/:path*`, async ({ request }) => {
      const body = (await request.json()) as {
        branch?: string;
        message?: string;
      };
      return HttpResponse.json({
        content: { sha: fakeSha(body.message ?? "put") },
        commit: {
          sha: fakeSha((body.branch ?? "main") + ":" + (body.message ?? "")),
        },
      });
    }),

    // --- Git refs ---
    http.post(`${base}/git/refs`, async ({ request }) => {
      const body = (await request.json()) as { ref?: string; sha?: string };
      return HttpResponse.json(
        {
          ref: body.ref,
          object: { sha: body.sha },
        },
        { status: 201 },
      );
    }),

    // --- Fail-fast fallback ---
    http.all("https://api.github.com/*", ({ request }) => {
      const msg = `no MSW handler for ${request.method} ${request.url}; add one in helpers/github-msw.ts`;
      return HttpResponse.json({ error: msg }, { status: 500 });
    }),
  ];

  return handlers;
}

function nextIssueNumber(store: Store): number {
  let max = 0;
  for (const n of store.issuesByNumber.keys()) if (n > max) max = n;
  return max + 1;
}

function nextPRNumber(store: Store): number {
  let max = 0;
  for (const n of store.prsByNumber.keys()) if (n > max) max = n;
  return max + 1;
}

function extractIssueFromBranch(branch: string): number | undefined {
  const m = /(?:^|[-/])(\d+)(?:$|[-/])/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

function fakeSha(seed: string): string {
  // Deterministic fake 40-char hex from a string input.
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const base = h.toString(16).padStart(8, "0");
  return (base + base + base + base + base).slice(0, 40);
}
