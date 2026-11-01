import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import type { NodeEnv } from '@abhyas/shared';

/**
 * The OpenAPI UI and document are a development and CI convenience. In production
 * they enumerate every route and payload the API has, so they are not served at
 * all — denying them is stronger than protecting them, and it means a production
 * deployment cannot leak its own surface by accident.
 */
export const API_DOCS_PATH = 'api/docs';

export function apiDocsEnabled(nodeEnv: NodeEnv): boolean {
  return nodeEnv !== 'production';
}

/** Returns whether the document was mounted, so the boot log can say so. */
export function configureApiDocs(app: INestApplication, nodeEnv: NodeEnv): boolean {
  if (!apiDocsEnabled(nodeEnv)) {
    return false;
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Abhyas API')
      .setDescription('Mock test platform API. Every response shape is generated from this document.')
      .setVersion('0.1.0')
      .build(),
  );

  // Serves the UI at /api/docs and the machine-readable document at /api/docs-json.
  SwaggerModule.setup(API_DOCS_PATH, app, document);

  return true;
}
