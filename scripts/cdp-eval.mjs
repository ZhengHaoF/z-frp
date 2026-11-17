// 通过 WebView2 远程调试端口评估 JS，用于排查界面问题。
// 用法: node scripts/cdp-eval.mjs "<js 表达式>" [port]
// Node 22 自带全局 WebSocket，无需额外依赖。
const expr = process.argv[2] || "document.title";
const port = process.argv[3] || "9333";

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("没有可调试的页面");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }),
  );
});
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data.toString());
  if (msg.id !== 1) return;
  if (msg.result?.exceptionDetails) {
    console.log("EXCEPTION:", JSON.stringify(msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails, null, 2));
  } else {
    console.log(JSON.stringify(msg.result?.result?.value ?? msg.result, null, 2));
  }
  ws.close();
  process.exit(0);
});
ws.addEventListener("error", (e) => {
  console.error("WS 错误:", e.message ?? e);
  process.exit(1);
});
