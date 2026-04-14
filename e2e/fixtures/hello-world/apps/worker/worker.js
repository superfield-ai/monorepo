/* eslint-disable @typescript-eslint/no-require-imports */
const http = require("http");
const net = require("net");

const API_SERVER_HOST = process.env.API_SERVER_HOST || "api-server";
const API_SERVER_PORT = process.env.API_SERVER_PORT || 8080;
const POSTGRES_HOST = process.env.POSTGRES_HOST || "postgres";
const POSTGRES_PORT = process.env.POSTGRES_PORT || 5432;
const WORK_ITEMS = parseInt(process.env.WORK_ITEMS || "3", 10);

async function waitForService(host, port, name, maxRetries = 30) {
  console.log(`Waiting for ${name} at ${host}:${port}...`);

  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port, timeout: 1000 });
        socket.on("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
      });
      console.log(`✓ ${name} is reachable`);
      return;
    } catch {
      console.log(
        `  Attempt ${i + 1}/${maxRetries}: ${name} not ready, retrying...`,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Failed to reach ${name} at ${host}:${port}`);
}

async function incrementCounter() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_SERVER_HOST,
      port: API_SERVER_PORT,
      path: "/counter/increment",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            resolve(result.count);
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`API returned ${res.statusCode}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.end();
  });
}

async function main() {
  try {
    // Test network connectivity to both services
    await waitForService(POSTGRES_HOST, POSTGRES_PORT, "Postgres");
    await waitForService(API_SERVER_HOST, API_SERVER_PORT, "API Server");

    console.log("\n✓ All services are reachable. Starting work...\n");

    // Simulate worker processing tasks
    for (let i = 1; i <= WORK_ITEMS; i++) {
      try {
        const newCount = await incrementCounter();
        console.log(
          `Task ${i}/${WORK_ITEMS} completed. Counter is now: ${newCount}`,
        );
      } catch (err) {
        console.error(`Task ${i}/${WORK_ITEMS} failed:`, err.message);
        throw err;
      }
    }

    console.log(`\n✓ All ${WORK_ITEMS} tasks completed successfully`);
    console.log("Worker ready for incoming tasks. Listening for signals...");

    // Keep the container running
    setInterval(() => {}, 1000);
  } catch (err) {
    console.error("\nWorker failed:", err.message);
    process.exit(1);
  }
}

main();
