/**
 * 验证 HTTP 入口是「边读边转发」而不是「读完再转发」。
 *
 * 做法：客户端慢速分块上传 1MB（约 1.5s），上游在收到第一块时立刻写回 FIRST；
 *   - 首字节明显早于上传结束 → 真流式（frps 收到一块就转发一块）
 *   - 首字节 ≈ 上传结束     → 仍在全量缓冲
 *
 * 用法：先起 frps + frpc + 上游，再 node scripts/test-stream-forward.mjs
 * 环境变量：UPSTREAM_PORT(19090) ENTRY_PORT(18080) TUNNEL_HOST(demo.test.local)
 */
import http from "node:http";
import { createHash } from "node:crypto";

const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 19090);
const ENTRY_PORT = Number(process.env.ENTRY_PORT ?? 18080);
const TUNNEL_HOST = process.env.TUNNEL_HOST ?? "demo.test.local";

const CHUNK_SIZE = 64 * 1024;
const CHUNK_COUNT = 16; // 1MB
const WRITE_INTERVAL_MS = 100; // 总上传时长 ≈ 1.5s

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------- 上游：收到第一块就回 FIRST，读完再回 DONE + 摘要 ----------
const upstream = http.createServer((req, res) => {
  const hash = createHash("sha256");
  let bytes = 0;
  let headSent = false;
  req.on("data", (c) => {
    if (!headSent) {
      headSent = true;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-upstream": "streaming" });
      res.write("FIRST\n");
    }
    hash.update(c);
    bytes += c.length;
  });
  req.on("end", () => res.end(`DONE ${bytes} ${hash.digest("hex")}\n`));
});

// ---------- 用例 ----------
function request({ method = "POST", path = "/stream", body = null, slow = false, contentLength = false }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let tFirstByte = 0;
    const chunks = [];
    const headers = { host: TUNNEL_HOST, "content-type": "application/octet-stream" };
    if (contentLength && body) headers["content-length"] = body.length;
    const req = http.request({
      host: "127.0.0.1",
      port: ENTRY_PORT,
      path,
      method,
      headers,
    });
    req.on("response", (res) => {
      res.on("data", (c) => {
        if (!tFirstByte) tFirstByte = Date.now();
        chunks.push(c);
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString(),
          firstByteMs: tFirstByte - t0,
          totalMs: Date.now() - t0,
        }),
      );
    });
    req.on("error", reject);

    if (!slow) {
      if (body) req.write(body);
      req.end();
      return;
    }
    // 慢速上传：16 块，每 100ms 一块
    let i = 0;
    const timer = setInterval(() => {
      if (i < CHUNK_COUNT) {
        req.write(body.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
        i += 1;
        return;
      }
      clearInterval(timer);
      req.end();
    }, WRITE_INTERVAL_MS);
  });
}

async function main() {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", r));

  // 1) 慢速上传 1MB：看首字节是否抢在上传结束之前
  const slowBody = Buffer.alloc(CHUNK_SIZE * CHUNK_COUNT);
  for (let i = 0; i < slowBody.length; i += 1) slowBody[i] = (i * 31 + 7) & 0xff;
  const streaming = await request({ body: slowBody, slow: true });
  const expectSha = sha256(slowBody);
  const streamingOk =
    streaming.status === 200 &&
    streaming.text.includes(`DONE ${slowBody.length} ${expectSha}`) &&
    streaming.text.startsWith("FIRST");
  // 判定：上传本身要 ~1.5s，首字节如果 < 800ms 说明没等 body 收完
  const isStreaming = streaming.firstByteMs < 800;

  console.log("[1] 慢速上传 1MB");
  console.log(`    状态        ${streaming.status}`);
  console.log(`    首字节      ${streaming.firstByteMs}ms（上传全程约 ${CHUNK_COUNT * WRITE_INTERVAL_MS}ms）`);
  console.log(`    总耗时      ${streaming.totalMs}ms`);
  console.log(`    内容校验    ${streamingOk ? "OK" : "FAIL"}  ${streaming.text.split("\n")[1] ?? ""}`);
  console.log(`    流式判定    ${isStreaming ? "OK 边读边转发" : "FAIL 仍在缓冲"}（阈值 800ms）`);

  // 2) 空 body：确认仍能正常收尾（FIN 空帧）
  const empty = await request({ body: null });
  const emptyOk = empty.status === 200 && empty.text.includes("DONE 0");
  console.log(`\n[2] 空 body POST：${empty.status} ${emptyOk ? "OK" : "FAIL"}`);

  // 3) 单次 2MB：确认大 body 不被 64KB 帧卡住
  const big = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = i & 0xff;
  const bigRes = await request({ body: big });
  const bigOk = bigRes.status === 200 && bigRes.text.includes(`DONE ${big.length} ${sha256(big)}`);
  console.log(`[3] 单次 2MB POST：${bigRes.status} ${bigOk ? "OK" : "FAIL"} (${bigRes.totalMs}ms)`);

  // 4) 带 Content-Length 的请求（真实 AI 客户端基本都带）：确认流式 body 与固定长度头不冲突
  const clBody = Buffer.alloc(300 * 1024);
  for (let i = 0; i < clBody.length; i += 1) clBody[i] = (i * 13 + 5) & 0xff;
  const clRes = await request({ body: clBody, contentLength: true });
  const clOk = clRes.status === 200 && clRes.text.includes(`DONE ${clBody.length} ${sha256(clBody)}`);
  console.log(`[4] 带 Content-Length 的 300KB：${clRes.status} ${clOk ? "OK" : "FAIL"}`);

  const pass = isStreaming && streamingOk && emptyOk && bigOk && clOk;
  console.log(pass ? "\n结果：全部通过" : "\n结果：有失败项");
  upstream.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("测试异常:", err);
  process.exit(1);
});
