// Practice mode: a private room where computer-controlled soldiers (bots) fill every free
// seat. Solo or Teams, at one of three difficulty levels. The bots themselves live on the
// server (server/src/bots/), they play by exactly the same rules as people do.

export type BotLevel = "easy" | "medium" | "hard";
export const BOT_LEVELS: readonly BotLevel[] = ["easy", "medium", "hard"];
export const BOT_LEVEL_NAME: Record<BotLevel, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

export function isBotLevel(v: unknown): v is BotLevel {
  return v === "easy" || v === "medium" || v === "hard";
}

/** Room sizes on offer in the lobby (you + bots). Teams: 2 = 1v1 … 10 = 5v5. */
export const PRACTICE_SIZES = [2, 4, 6, 8, 10] as const;
export const DEFAULT_PRACTICE_SIZE = 6;

/** Bots are named "Bot <name>", so they're easy to tell apart from people. */
export const BOT_NAMES = [
  "Viper", "Ghost", "Rook", "Havoc", "Blaze", "Nova", "Raptor", "Bolt",
  "Fang", "Jinx", "Kodiak", "Onyx", "Talon", "Wraith", "Sable", "Diesel",
];
