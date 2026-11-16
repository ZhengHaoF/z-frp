/** 结构化日志：一行一个 JSON 对象，便于 systemd/journald 与 grep。 */
import type { LogLevel } from "./types.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly threshold: number;

  constructor(
    private readonly scope: string,
    level: LogLevel = "info",
  ) {
    this.threshold = LEVELS[level] ?? LEVELS["info"]!;
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level]! < this.threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg: message,
      ...fields,
    });
    const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
    out.write(line + "\n");
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields);
  }
}
