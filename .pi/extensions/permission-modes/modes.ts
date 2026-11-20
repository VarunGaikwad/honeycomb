export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface ModeInfo {
  badge: string;
  description: string;
}

export const MODE_INFO: Readonly<Record<PermissionMode, ModeInfo>> = {
  default: { badge: "● manual", description: "Read-only tools are allowed; other calls require approval." },
  acceptEdits: { badge: "✎ edits", description: "Allow edits and filesystem-safe commands inside the working directory." },
  bypassPermissions: { badge: "⚡ bypass", description: "Allow calls except for policy hard-denies." },
};

/** Bypass is intentionally excluded from the low-friction keyboard cycle. */
export const CYCLE_MODES = ["default", "acceptEdits"] as const satisfies readonly PermissionMode[];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function nextCycleMode(mode: PermissionMode): PermissionMode {
  const index = CYCLE_MODES.indexOf(mode as (typeof CYCLE_MODES)[number]);
  return CYCLE_MODES[(index + 1) % CYCLE_MODES.length]!;
}

export function formatModeList(current: PermissionMode): string {
  return PERMISSION_MODES.map((mode) =>
    `${mode === current ? "›" : " "} ${MODE_INFO[mode].badge} ${mode} — ${MODE_INFO[mode].description}`,
  ).join("\n");
}
