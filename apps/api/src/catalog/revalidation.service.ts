import { Injectable, Logger } from '@nestjs/common';

import { loadConfig } from '../config/config';
import { webUrlFor } from '../config/links';

/**
 * After a catalog write, the public pages are stale until the web tier drops them.
 * This asks the web tier to revalidate the `catalog` cache tag, proving itself with the
 * shared secret from the environment.
 *
 * A failure is logged and swallowed on purpose: the write has already committed, and a
 * page that is a minute stale is better than an API that reports a failure for a change
 * it did make.
 */
@Injectable()
export class CatalogRevalidationService {
  private readonly logger = new Logger(CatalogRevalidationService.name);
  private readonly endpoint: string;
  private readonly secret: string;

  constructor() {
    const config = loadConfig(process.env);
    // The web tier's public URL is not always reachable from inside the API container
    // (in compose it is another service), so a deployment may name the internal
    // endpoint outright. Production falls back to WEB_URL, which is the public https one.
    const explicit = (process.env.REVALIDATE_URL ?? '').trim();
    this.endpoint =
      explicit === '' ? `${webUrlFor(config.NODE_ENV, process.env.WEB_URL)}/api/revalidate` : explicit;
    this.secret = config.REVALIDATE_SECRET;
  }

  async trigger(): Promise<void> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-secret': this.secret,
        },
        body: JSON.stringify({ tag: 'catalog' }),
      });

      if (!response.ok) {
        this.logger.warn(`The web tier refused catalog revalidation with ${response.status}`);
      }
    } catch (error) {
      this.logger.warn(
        `Could not ask the web tier to revalidate the catalog: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
