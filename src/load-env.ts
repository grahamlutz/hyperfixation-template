import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `.env` for the entrypoints Next never sees.
 *
 * `next dev` and `next build` load `.env` themselves, so the web has one without asking; the
 * worker and the migrator are plain Node processes and had nothing — which is why `pnpm worker`
 * needed its whole environment supplied by hand. This is the missing half, and it is
 * deliberately *not* dotenv: the rules are the same few this template's own `.env` uses, and
 * `@hyperfixation/cli` parses the same file with the same rules when `hf check` reads it. A
 * parser that guessed at shell semantics would disagree with compose, which reads it with rules
 * of its own again.
 *
 * Existing values win. A container supplies its environment through compose and there is no
 * `.env` beside it; a `hf dev` supplies `HF_BUILD_SHA` on the command line precisely so it is
 * not the committed one. Neither may be overwritten by a file that happens to be present.
 */
export function loadEnv(dir: string = process.cwd()): string[] {
  const loaded: string[] = [];
  let contents: string;
  try {
    contents = readFileSync(path.join(dir, ".env"), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return loaded;
    throw cause;
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (process.env[name] !== undefined) continue;
    process.env[name] = unquote(trimmed.slice(eq + 1).trim());
    loaded.push(name);
  }
  return loaded;
}

function unquote(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0]!;
    if (value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}
