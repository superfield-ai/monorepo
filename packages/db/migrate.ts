#!/usr/bin/env bun
/**
 * @file migrate.ts
 *
 * CLI entry point for the unified migration runner.
 *
 * Canonical reference: docs/architecture.md §Data Layer
 * ADR reference: docs/adr-schema-boundary.md
 *
 * # Subcommands
 *
 *   migrate up             — apply all pending migrations
 *   migrate status         — report applied vs. pending migrations
 *   migrate down [<n>]     — remove tracking record for the last <n> migrations (default: 1)
 *
 * # Usage
 *
 *   DATABASE_URL=postgres://... bun packages/db/migrate.ts up
 *   DATABASE_URL=postgres://... bun packages/db/migrate.ts status
 *   DATABASE_URL=postgres://... bun packages/db/migrate.ts down
 *   DATABASE_URL=postgres://... bun packages/db/migrate.ts down 3
 *
 * The migrator is a standalone program. It is NOT imported by the application
 * server. In production it runs as a k8s Job before the rolling app update.
 */

import {
  runMigrations,
  getMigrationStatus,
  rollbackMigrations,
} from "./migrator.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0] ?? "up";

  switch (subcommand) {
    case "up": {
      const applied = await runMigrations();
      if (applied.length > 0) {
        console.log(`Applied: ${applied.join(", ")}`);
      }
      break;
    }

    case "status": {
      const statuses = await getMigrationStatus();
      if (statuses.length === 0) {
        console.log("No migrations registered.");
        break;
      }

      const longestId = Math.max(...statuses.map((s) => s.id.length));
      console.log(
        `${"ID".padEnd(longestId)}  ${"STATUS".padEnd(10)}  APPLIED AT`,
      );
      console.log("-".repeat(longestId + 30));
      for (const s of statuses) {
        const status = s.applied ? "applied" : "pending";
        const ts = s.appliedAt ? s.appliedAt.toISOString() : "-";
        console.log(`${s.id.padEnd(longestId)}  ${status.padEnd(10)}  ${ts}`);
      }

      const pending = statuses.filter((s) => !s.applied).length;
      const applied = statuses.filter((s) => s.applied).length;
      console.log(
        `\nTotal: ${statuses.length} (${applied} applied, ${pending} pending)`,
      );
      break;
    }

    case "down": {
      const stepsArg = args[1];
      const steps = stepsArg !== undefined ? parseInt(stepsArg, 10) : 1;
      if (stepsArg !== undefined && (isNaN(steps) || steps < 1)) {
        console.error(
          `[migrate] error: 'down' argument must be a positive integer, got "${stepsArg}"`,
        );
        process.exit(1);
      }
      const rolledBack = await rollbackMigrations({ steps });
      if (rolledBack.length > 0) {
        console.log(`Rolled back: ${rolledBack.join(", ")}`);
      }
      break;
    }

    default: {
      console.error(`[migrate] unknown subcommand: "${subcommand}"`);
      console.error("Usage: migrate <up|status|down [n]>");
      process.exit(1);
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[migrate] FATAL: ${message}`);
    process.exit(1);
  });
