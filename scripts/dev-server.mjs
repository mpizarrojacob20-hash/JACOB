import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const { default: jacobAgentHandler } = await import(
  pathToFileURL(path.join(root, "api", "jacob-agent.js"))
);

const PORT = process.env.PORT || 3001;

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/jacob-agent" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        req.body = body ? JSON.parse(body) : {};
      } catch {
        req.body = {};
      }
      const fakeRes = {
        _status: 200,
        status(code) {
          this._status = code;
          return this;
        },
        setHeader() {},
        json(payload) {
          res.writeHead(this._status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        },
        end() {
          res.writeHead(this._status);
          res.end();
        },
      };
      await jacobAgentHandler(req, fakeRes);
    });
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    const html = fs.readFileSync(path.join(root, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`JACOB dev server running at http://localhost:${PORT}`);
});
