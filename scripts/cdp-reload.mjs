// 重新加载 WebView 页面并收集控制台异常，用于定位加载期脚本错误。
// 用法: node scripts/cdp-reload.mjs [port]
const port = process.argv[2] || "9333";

const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("没有可调试的页面");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const seen = [];

ws.addEventListener("open", () => {
  const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }));
  send(1, "Runtime.enable");
  send(2, "Log.enable");
  send(3, "Page.enable");
  setTimeout(() => send(4, "Page.reload", { ignoreCache: true }), 200);
  setTimeout(() => {
    console.log(seen.length ? seen.join("\n") : "(无异常输出)");
    ws.close();
    process.exit(0);
  }, 6000);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data.toString());
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    seen.push(
      `EXCEPTION @${d.lineNumber}:${d.columnNumber} ${d.exception?.description?.split("\n").slice(0, 3).join(" | ") ?? d.text}`,
    );
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ");
    seen.push(`CONSOLE[${msg.params.type}] ${text}`);
  }
  if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    seen.push(`LOG[${e.level}] ${e.text} ${e.url ? "@" + e.url + ":" + e.lineNumber : ""}`);
  }
});
