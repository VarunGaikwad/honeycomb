import config from './bi.config.json' with { type: 'json' };

/** Tool categories that can be enabled or disabled without changing TypeScript. */
export interface BiConfig {
  toolGroups: {
    filesystem: boolean;
    execution: boolean;
    git: boolean;
    agent: boolean;
    advanced: boolean;
  };
  filesystem: {
    defaultReadLimit: number;
    maxReadLineLength: number;
    maxGrepMatches: number;
  };
  output: {
    maxChars: number;
  };
  git: {
    defaultLogLimit: number;
  };
  execution: {
    timeoutMs: number;
  };
  startup: {
    autoEnableQuietStartup: boolean;
  };
  ui: {
    footerStyle: 'compact' | 'detailed';
    startupMessage: string;
    workingTips: { enabled: boolean; delayMs: number };
    tagline: string;
    gettingStartedTitle: string;
    gettingStarted: string;
    commandsTitle: string;
    keysTitle: string;
    commands: Array<{ command: string; description: string }>;
    keys: Array<{ key: string; description: string }>;
  };
  systemPrompt: {
    core: string[];
  };
}

/** Defaults are kept in bi.config.json so common capability changes stay declarative. */
export const BI_CONFIG: BiConfig = { ...config, ui: { ...config.ui, footerStyle: config.ui.footerStyle === 'compact' ? 'compact' : 'detailed' } };
