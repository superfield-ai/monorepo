export function isRateLimitError(message: string): boolean {
  return /rate limit exceeded|api rate limit exceeded|too many requests|secondary rate limit/i.test(
    message,
  );
}

export function formatError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (isRateLimitError(singleLine)) {
    const requestId = /request id ([A-Z0-9:]+)/i.exec(singleLine)?.[1];
    return requestId
      ? `GitHub API rate limit exceeded (request id: ${requestId})`
      : "GitHub API rate limit exceeded";
  }
  return singleLine;
}
