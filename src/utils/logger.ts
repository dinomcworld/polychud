import { config } from "../config.js";

const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const currentLevel = levels[config.LOG_LEVEL];

function log(level: keyof typeof levels, message: string, ...args: unknown[]) {
  if (levels[level] < currentLevel) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  console[level === "debug" ? "log" : level](`${prefix} ${message}`, ...args);
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => log("debug", msg, ...args),
  info: (msg: string, ...args: unknown[]) => log("info", msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log("warn", msg, ...args),
  error: (msg: string, ...args: unknown[]) => log("error", msg, ...args),
};
