import path from "node:path";
import { getSetting, getSettings, saveSettings } from "./appDb";
import {
  appHome,
  backupRoot,
  claudeHome as defaultClaudeHome,
  codexHome as defaultCodexHome,
  expandHome,
  geminiHome as defaultGeminiHome,
  logsDbPath as defaultLogsDbPath,
  sessionIndexPath as defaultSessionIndexPath,
  stateDbPath as defaultStateDbPath,
  trashRoot
} from "./paths";
import type { SetupSaveRequest } from "../shared/types";

const SETTING_KEYS = {
  codexHome: "paths.codexHome",
  claudeHome: "paths.claudeHome",
  geminiHome: "paths.geminiHome",
  setupCompleted: "setup.completed"
} as const;

export interface ConfiguredHomes {
  codexHome: string;
  claudeHome: string;
  geminiHome: string;
}

export interface StoragePaths extends ConfiguredHomes {
  appHome: string;
  stateDbPath: string;
  logsDbPath: string;
  historyPath: string;
  sessionIndexPath: string;
  sessionsRoot: string;
  claudeProjectsRoot: string;
  claudeTranscriptsRoot: string;
  geminiHistoryRoot: string;
  geminiTmpRoot: string;
  trashRoot: string;
  backupRoot: string;
}

export function getDefaultHomes(): ConfiguredHomes {
  return {
    codexHome: defaultCodexHome,
    claudeHome: defaultClaudeHome,
    geminiHome: defaultGeminiHome
  };
}

export function getEnvHomes(): Record<keyof ConfiguredHomes, string | null> {
  return {
    codexHome: process.env.CODEX_HOME ? normalizeHome(process.env.CODEX_HOME) : null,
    claudeHome: process.env.CLAUDE_HOME ? normalizeHome(process.env.CLAUDE_HOME) : null,
    geminiHome: process.env.GEMINI_HOME ? normalizeHome(process.env.GEMINI_HOME) : null
  };
}

export function getConfiguredHomes(): ConfiguredHomes {
  const settings = getSettings([SETTING_KEYS.codexHome, SETTING_KEYS.claudeHome, SETTING_KEYS.geminiHome]);
  const env = getEnvHomes();
  const defaults = getDefaultHomes();
  return {
    codexHome: normalizeHome(settings.get(SETTING_KEYS.codexHome) || env.codexHome || defaults.codexHome),
    claudeHome: normalizeHome(settings.get(SETTING_KEYS.claudeHome) || env.claudeHome || defaults.claudeHome),
    geminiHome: normalizeHome(settings.get(SETTING_KEYS.geminiHome) || env.geminiHome || defaults.geminiHome)
  };
}

export function getSetupCompleted(): boolean {
  return getSetting(SETTING_KEYS.setupCompleted) === "true";
}

export function saveConfiguredHomes(request: SetupSaveRequest): ConfiguredHomes {
  const homes = {
    codexHome: normalizeHome(request.codexHome),
    claudeHome: normalizeHome(request.claudeHome),
    geminiHome: normalizeHome(request.geminiHome)
  };
  saveSettings({
    [SETTING_KEYS.codexHome]: homes.codexHome,
    [SETTING_KEYS.claudeHome]: homes.claudeHome,
    [SETTING_KEYS.geminiHome]: homes.geminiHome,
    [SETTING_KEYS.setupCompleted]: request.completed === false ? "false" : "true"
  });
  return homes;
}

export function getStoragePaths(): StoragePaths {
  const homes = getConfiguredHomes();
  return {
    ...homes,
    appHome,
    stateDbPath: path.join(homes.codexHome, path.basename(defaultStateDbPath)),
    logsDbPath: path.join(homes.codexHome, path.basename(defaultLogsDbPath)),
    historyPath: path.join(homes.codexHome, "history.jsonl"),
    sessionIndexPath: path.join(homes.codexHome, path.basename(defaultSessionIndexPath)),
    sessionsRoot: path.join(homes.codexHome, "sessions"),
    claudeProjectsRoot: path.join(homes.claudeHome, "projects"),
    claudeTranscriptsRoot: path.join(homes.claudeHome, "transcripts"),
    geminiHistoryRoot: path.join(homes.geminiHome, "history"),
    geminiTmpRoot: path.join(homes.geminiHome, "tmp"),
    trashRoot,
    backupRoot
  };
}

export function normalizeHome(input: string): string {
  return path.resolve(expandHome(input.trim()));
}
