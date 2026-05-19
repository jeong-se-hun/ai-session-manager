import fs from "node:fs";
import readline from "node:readline";

export interface JsonLine<T = unknown> {
  line: number;
  value: T;
}

export async function readJsonl<T = unknown>(filePath: string, onLine: (line: JsonLine<T>) => void): Promise<number> {
  if (!fs.existsSync(filePath)) return 0;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const raw of reader) {
    count += 1;
    if (!raw.trim()) continue;
    try {
      onLine({ line: count, value: JSON.parse(raw) as T });
    } catch {
      onLine({ line: count, value: { parse_error: true, raw } as T });
    }
  }
  return count;
}

export function truncateText(value: string, max = 900): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}
