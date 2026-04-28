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
  error: string | null;
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

    this.state = { ...this.state, selectedFile: filename, loading: true, error: null };
    this.notify();

    try {
      const url = `${this.docsContentBaseUrl}/${encodeURIComponent(filename)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      this.contentCache.set(filename, text);
      this.state = { ...this.state, content: text, loading: false, error: null };
    } catch (err) {
      this.state = {
        ...this.state,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.notify();
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
