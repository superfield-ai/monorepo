const http = require("http");
const url = require("url");

// Simple in-memory counter for demo
let counter = 0;

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Get counter value
  if (pathname === "/counter" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: counter }));
    return;
  }

  // Increment counter
  if (pathname === "/counter/increment" && req.method === "POST") {
    counter++;
    console.log(`Counter incremented to ${counter}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: counter }));
    return;
  }

  // Default
  res.writeHead(404);
  res.end("Not found");
});

server.listen(8080, "0.0.0.0", () => {
  console.log("API Server listening on port 8080");
});
