import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

/** OpenAPI 3 sxemi zod sxemlərindən generasiya olunur → frontend tip generasiyası. */
export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'LexAudit AI API',
        version: '0.1.0',
        description:
          'Deterministik mühasibat, RAG və agent backend-i. Pul məbləğləri string kimi ötürülür.',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });
}
