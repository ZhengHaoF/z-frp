import http from "node:http";
import net from "node:net";

const httpServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c.toString()));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", "x-zfrp": "ok" });
    res.end(JSON.stringify({ path: req.url, method: req.method, body, headers: req.headers }));
  });
});
httpServer.listen(19090, "127.0.0.1", () => console.log("fixture http :19090"));

const tcpServer = net.createServer((socket) => {
  socket.write("HELLO\n");
  socket.on("data", (chunk) => socket.write(Buffer.from(chunk.toString().toUpperCase())));
  // 客户端被强杀时会 ECONNRESET，测试 fixture 不该因此退出
  socket.on("error", () => socket.destroy());
});
tcpServer.listen(19092, "127.0.0.1", () => console.log("fixture tcp :19092"));

process.on("SIGTERM", () => {
  httpServer.close();
  tcpServer.close();
  process.exit(0);
});
