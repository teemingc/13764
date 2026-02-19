import { Config } from '$lib/server/config';

export function load() {
  return {
    environment: Config.nodeEnv,
  };
}
