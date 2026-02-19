import { Config } from '$lib/server/config';
import { logger } from '@repro/server-libs/logger';

export function load() {
  logger.info({ env: Config.nodeEnv }, 'Dashboard loaded');
  return {
    showBanner: Config.showBanner,
    enableNewFeature: Config.enableNewFeature,
  };
}
