import { json } from '@sveltejs/kit';
import { Config } from '$lib/server/config';

export function GET() {
  return json({
    environment: Config.nodeEnv,
    showBanner: Config.showBanner,
    enableNewFeature: Config.enableNewFeature,
  });
}
