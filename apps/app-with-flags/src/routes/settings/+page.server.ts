import { Config } from '$lib/server/config';

export function load() {
  return {
    currentEnv: Config.nodeEnv,
    flagsConfigured: Boolean(Config.flagsSecret),
  };
}
