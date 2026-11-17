// 导出 Node 端协议编码的字节向量，供 Rust 单元测试对拍。
// 用法: node scripts/export-vectors.mjs > crates/frpc-core/tests/vectors.json
import fs from "node:fs";
import { encodeDataFrame, encodeControl, FLAG_FIN, FLAG_RST } from "../packages/shared/dist/protocol.js";

const hex = (buf) => Buffer.from(buf).toString("hex");

const dataFrames = [
  { name: "simple", streamId: 1, payload: "hi", flags: 0 },
  { name: "empty", streamId: 1, payload: "", flags: FLAG_FIN },
  { name: "flags-frst", streamId: 0x01020304, payload: "x", flags: FLAG_FIN | FLAG_RST },
  { name: "large", streamId: 7, payload: "a".repeat(64 * 1024), flags: 0 },
].map((c) => ({
  name: c.name,
  streamId: c.streamId,
  flags: c.flags,
  bytes: hex(encodeDataFrame(c.streamId, Buffer.from(c.payload), c.flags)),
}));

const controlFrames = [
  { name: "hello", frame: { type: "hello", v: 1, key: "abc" } },
  { name: "config-pull", frame: { type: "config-pull", v: 1, key: "k", local: "http://127.0.0.1:3000" } },
  { name: "register-tcp", frame: { type: "register", v: 1, proxies: [{ name: "db", type: "tcp", remotePort: 33061, authToken: "tok" }] } },
  { name: "heartbeat", frame: { type: "heartbeat", v: 1, at: 1700000000000 } },
].map((c) => ({ name: c.name, json: encodeControl(c.frame) }));

const out = { dataFrames, controlFrames };
const dest = new URL("../crates/frpc-core/tests/vectors.json", import.meta.url);
fs.mkdirSync(new URL("./", dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote vectors.json: ${dataFrames.length} data frames, ${controlFrames.length} control frames`);
