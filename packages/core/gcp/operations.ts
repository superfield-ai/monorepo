import { googleJsonRequest } from "./http.js";
import type { HttpDeps } from "./http.js";

interface OperationResponse {
  status?: string;
  error?: {
    message?: string;
    [key: string]: unknown;
  };
}

export async function pollOperation(
  operationUrl: string,
  deps: HttpDeps,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<void> {
  const intervalMs = opts?.intervalMs ?? 5000;
  const timeoutMs = opts?.timeoutMs ?? 600_000;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const op = await googleJsonRequest<OperationResponse>(
      operationUrl,
      {},
      deps,
    );

    if (op?.status === "DONE") {
      if (op.error) {
        const msg =
          typeof op.error.message === "string"
            ? op.error.message
            : JSON.stringify(op.error);
        throw new Error(msg);
      }
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, remaining)),
    );
  }

  throw new Error("Operation timed out: " + operationUrl);
}
