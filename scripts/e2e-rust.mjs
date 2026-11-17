// Rust 客户端端到端验收：HTTP GET / POST 100KB / TCP 回显
// 用法: node scripts/e2e-rust.mjs
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";

const HTTP_ENTRY = { host: "127.0.0.1", port: 18080, hostHeader: "demo.test.local" };
const TCP_ENTRY = { host: "127.0.0.1", port: 19091 };
const AUTH_TOKEN = "tcp-auth-token-at-least-8-chars";

const results = [];
function ok(name, detail) {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? "  " + detail : ""}`);
}
function fail(name, detail) {
  results.push({ name, pass: false, detail });
  console.log(`FAIL  ${name}  ${detail}`);
}

function httpRequest({ method = "GET", path = "/", body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HTTP_ENTRY.host,
        port: HTTP_ENTRY.port,
        method,
        path,
        headers: {
          host: HTTP_ENTRY.hostHeader,
          "content-type": "application/json",
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function testHttp() {
  const g = await httpRequest({ path: "/hello?x=1" });
  if (g.status === 200 && g.headers["x-zfrp"] === "ok" && JSON.parse(g.body).path === "/hello?x=1") {
    ok("HTTP GET", `status=200 path=${JSON.parse(g.body).path}`);
  } else {
    fail("HTTP GET", `status=${g.status} body=${g.body.slice(0, 120)}`);
  }

  const payload = JSON.stringify({ blob: "z".repeat(100_000) });
  const p = await httpRequest({ method: "POST", path: "/big", body: payload });
  let parsed = null;
  try {
    parsed = JSON.parse(p.body);
  } catch {}
  const echoed = parsed?.body ?? "";
  const sameLen = echoed.length === payload.length;
  const sameHash = createHash("sha256").update(echoed).digest("hex") === createHash("sha256").update(payload).digest("hex");
  if (p.status === 200 && sameLen && sameHash) {
    ok("HTTP POST 100KB", `bytes=${echoed.length} sha256 一致`);
  } else {
    fail("HTTP POST 100KB", `status=${p.status} sent=${payload.length} got=${echoed.length} hashMatch=${sameHash}`);
  }

  const nf = await httpRequest({ path: "/nf" });
  void nf;
}

function tcpRoundTrip() {
  return new Promise((resolve) => {
    const sock = net.connect(TCP_ENTRY.port, TCP_ENTRY.host);
    let buf = "";
    let stage = "auth"; // auth → hello → echo
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ pass: false, detail: `超时(${stage})，收到: ${JSON.stringify(buf)}` });
    }, 8000);

    sock.on("connect", () => sock.write(`AUTH ${AUTH_TOKEN}\n`));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      if (stage === "auth" && buf.includes("OK") && buf.includes("HELLO")) {
        stage = "echo";
        sock.write("ping-12345\n");
        return;
      }
      if (stage === "echo" && buf.includes("PING-12345")) {
        clearTimeout(timer);
        sock.end();
        resolve({ pass: true, detail: `回显 ${JSON.stringify(buf.trim().split("\n").pop())}` });
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      resolve({ pass: false, detail: e.message });
    });
  });
}

(async () => {
  try {
    await testHttp();
  } catch (e) {
    fail("HTTP 通道", e.message);
  }
  const tcp = await tcpRoundTrip();
  tcp.pass ? ok("TCP 回显", tcp.detail) : fail("TCP 回显", tcp.detail);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n结果: ${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
