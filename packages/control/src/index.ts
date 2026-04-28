/**
 * @file index.ts
 *
 * Studio Server — main entrypoint.
 *
 * Exports `startControl(opts?)` for use by `superfield control` and for
 * integration tests. The side-effect startup that runs on import was replaced
 * with an explicit function call so the server only starts when requested.
 */

import { loadConfig, vlog, type ControlConfig } from "./config";
import { embeddedAssets } from "./embedded-assets.gen";
import { ProcessManager } from "./process-manager";
import { route } from "./router";
import { controlWsHandler, type WsData } from "./control-ws";

export interface StartControlOpts {
  /** Override individual config values (takes precedence over env vars). */
  config?: Partial<ControlConfig>;
}

export async function startControl(opts: StartControlOpts = {}): Promise<{
  server: ReturnType<typeof Bun.serve>;
  pm: ProcessManager;
  config: ControlConfig;
}> {
  const baseConfig = loadConfig();
  const config: ControlConfig = {
    ...baseConfig,
    embeddedAssets,
    ...opts.config,
  };
  const pm = new ProcessManager();

  vlog(
    config,
    "Configuration loaded:",
    JSON.stringify(
      {
        port: config.port,
        logDir: config.logDir,
        clusterContext: config.clusterContext,
        webServiceUrl: config.webServiceUrl,
        apiServiceUrl: config.apiServiceUrl,
        superfieldApiUrl: config.superfieldApiUrl,
        assetsDir: config.assetsDir ?? "(unset)",
        verbose: config.verbose,
      },
      null,
      2,
    ),
  );

  let shuttingDown = false;

  const server = Bun.serve<WsData>({
    hostname: "0.0.0.0",
    port: config.port,
    idleTimeout: 0,

    async fetch(req: Request, srv): Promise<Response> {
      if (shuttingDown) {
        return new Response(
          "Service Unavailable — studio server is shutting down",
          { status: 503 },
        );
      }
      const url = new URL(req.url);
      vlog(config, `→ ${req.method} ${url.pathname}${url.search}`);
      const res = await route(
        req,
        config,
        srv as unknown as {
          upgrade: (req: Request, opts: { data: WsData }) => boolean;
        },
      );
      if (res !== undefined) {
        vlog(config, `← ${res.status} ${url.pathname}`);
      }
      return res;
    },

    websocket: controlWsHandler,

    error(err: Error): Response {
      console.error("[studio] Unhandled server error:", err.message);
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  console.log(`\n⬡ Studio Mode`);
  console.log(`  Studio:  http://0.0.0.0:${config.port}`);
  console.log(`  App:     http://0.0.0.0:${config.port}/app/`);
  console.log(`  API:     http://0.0.0.0:${config.port}/api/`);
  console.log(`  Cluster: context=${config.clusterContext}`);
  console.log(`  Logs:    ${config.logDir}`);
  console.log(`  DevLoop: ${config.superfieldApiUrl}`);
  console.log(`\nPress Ctrl+C to stop.\n`);

  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[studio] Received ${signal}. Shutting down…`);
    server.stop();
    await pm.shutdown();
    console.log("[studio] Goodbye.");
    process.exit(0);
  }

  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT").catch((err) => {
      console.error("[studio] Error during shutdown:", err);
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM").catch((err) => {
      console.error("[studio] Error during shutdown:", err);
      process.exit(1);
    });
  });

  return { server, pm, config };
}
