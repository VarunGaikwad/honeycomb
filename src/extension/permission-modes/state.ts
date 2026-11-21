export const MODE_ENTRY = 'bi.permission-mode';
export function restorePermissionMode(entries: readonly unknown[]): string | undefined {
 const entry=[...entries].reverse().find((x:any)=>x?.type==='custom'&&x.customType===MODE_ENTRY) as {data?: {mode?: unknown}} | undefined;
 const mode=entry?.data?.mode;
 return typeof mode === 'string' && ['default','acceptEdits','plan','auto','dontAsk','bypassPermissions'].includes(mode)?mode:undefined;
}
