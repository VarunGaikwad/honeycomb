export const CONFIG_LIMITS = {
  maxReadLimit: 10_000,
  minReadLineLength: 15,
  maxReadLineLength: 10_000,
  maxGrepMatches: 10_000,
  maxGitLogLimit: 100,
  minOutputChars: 64,
  maxOutputChars: 1_000_000,
  maxProjectPromptChars: 8_000,
} as const;

export const OUTPUT_TRUNCATION_MARKER = '\n... [output truncated]';
