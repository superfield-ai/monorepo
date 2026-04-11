#!/usr/bin/env bun
import { runCLI } from "../index.ts";

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

process.on("uncaughtException", (error) => {
  console.error(`[error] Uncaught exception: ${formatUnknownError(error)}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[error] Unhandled rejection: ${formatUnknownError(reason)}`);
  process.exit(1);
});

runCLI(process.argv.slice(2)).catch((error) => {
  console.error(`[error] ${formatUnknownError(error)}`);
  process.exit(1);
});
