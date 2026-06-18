/**
 * @file DocsController
 *
 * Fetches the list of documentation files from /studio/docs and caches
 * individual file contents. Drives the DocsViewer in the Product tab.
 *
 * No React imports — pure TypeScript controller.
 */

export interface DocsState {
  files: string[];
  selectedFile: string | null;
  content: string | null;
  loading: boolean;
  /** True while a `createDoc` upload/write is in flight. */
  saving: boolean;
  error: string | null;
}

/** Input for authoring or uploading a document via {@link DocsController.createDoc}. */
export interface CreateDocInput {
  /** Human-readable document title. */
  title: string;
  /** Raw markdown content. */
  content: string;
  /** Optional filename key; derived from the title server-side when omitted. */
  filename?: string;
}

export type DocsListener = (state: DocsState) => void;

export interface DocsControllerOptions {
  readonly docsListUrl?: string;
  readonly docsContentBaseUrl?: string;
}

export class DocsController {
  private state: DocsState = {
    files: [],
    selectedFile: null,
    content: null,
    loading: false,
    saving: false,
    error: null,
  };
  private listeners: Set<DocsListener> = new Set();
  private contentCache = new Map<string, string>();
  private readonly docsListUrl: string;
  private readonly docsContentBaseUrl: string;

  constructor({
    docsListUrl = "/studio/docs",
    docsContentBaseUrl = "/studio/docs",
  }: DocsControllerOptions = {}) {
    this.docsListUrl = docsListUrl;
    this.docsContentBaseUrl = docsContentBaseUrl;
  }

  subscribe(listener: DocsListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): DocsState {
    return {
      ...this.state,
      files: [...this.state.files],
    };
  }

  async loadFileList(): Promise<void> {
    this.state = { ...this.state, loading: true, error: null };
    this.notify();

    try {
      const res = await fetch(this.docsListUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { files?: string[] };
      const files = body.files ?? [];

      // Auto-select README.md or the first file
      const defaultFile =
        files.find((f) => f.toLowerCase() === "readme.md") ?? files[0] ?? null;

      this.state = {
        ...this.state,
        files,
        loading: false,
        error: null,
        selectedFile: this.state.selectedFile ?? defaultFile,
      };
      this.notify();

      if (this.state.selectedFile) {
        await this.selectFile(this.state.selectedFile);
      }
    } catch (err) {
      this.state = {
        ...this.state,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this.notify();
    }
  }

  async selectFile(filename: string): Promise<void> {
    if (this.contentCache.has(filename)) {
      this.state = {
        ...this.state,
        selectedFile: filename,
        content: this.contentCache.get(filename) ?? null,
        loading: false,
        error: null,
      };
      this.notify();
      return;
    }

    this.state = {
      ...this.state,
      selectedFile: filename,
      loading: true,
      error: null,
    };
    this.notify();

    try {
      const url = `${this.docsContentBaseUrl}/${encodeURIComponent(filename)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      this.contentCache.set(filename, text);
      this.state = {
        ...this.state,
        content: text,
        loading: false,
        error: null,
      };
    } catch (err) {
      this.state = {
        ...this.state,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.notify();
  }

  /**
   * Author or upload a markdown document by POSTing it to the server ingest
   * route (`POST /studio/docs`). The server runs the same ingest-and-embed
   * pipeline as the CLI, so the new document becomes searchable in the brain.
   *
   * On success the docs list is reloaded and the freshly created document is
   * selected so its rendered content shows immediately. Returns the filename
   * the document reads back under, or `null` on failure (with `state.error`
   * populated).
   */
  async createDoc(input: CreateDocInput): Promise<string | null> {
    const title = input.title.trim();
    if (!title || !input.content.trim()) {
      this.state = {
        ...this.state,
        error: "title and content are required",
      };
      this.notify();
      return null;
    }

    this.state = { ...this.state, saving: true, error: null };
    this.notify();

    try {
      const res = await fetch(this.docsListUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          content: input.content,
          ...(input.filename ? { filename: input.filename } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { filename?: string };
      const filename = body.filename ?? null;

      this.state = { ...this.state, saving: false, error: null };
      this.notify();

      // Reload the list so the new file appears, then drop any stale cache and
      // select the freshly written document so its content renders.
      if (filename) {
        this.contentCache.delete(filename);
        this.state = { ...this.state, selectedFile: filename };
      }
      await this.loadFileList();
      if (filename) {
        this.contentCache.delete(filename);
        await this.selectFile(filename);
      }

      return filename;
    } catch (err) {
      this.state = {
        ...this.state,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      };
      this.notify();
      return null;
    }
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
