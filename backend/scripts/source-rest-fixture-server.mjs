import http from "node:http";

const port = Number(process.env.ASKLAKE_SOURCE_REST_PORT || 19080);

const rows = [
  { active: true, amount: 42.7, event_time: "2026-07-04T10:00:00Z", id: 1, payload: { region: "KR" }, user_id: "u_001" },
  { active: false, amount: 19.25, event_time: "2026-07-04T10:01:00Z", id: 2, payload: { region: "US" }, user_id: "u_002" },
  { active: true, amount: 7, event_time: "2026-07-04T10:02:00Z", id: 3, payload: { region: "JP" }, user_id: "u_003" },
];

const server = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/events") {
    sendJson(response, 200, { data: rows });
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  sendJson(response, 404, { error: { code: "NOT_FOUND", message: `No route for ${request.method} ${url.pathname}` } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`AskLake REST source fixture listening on http://127.0.0.1:${port}`);
});

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}
