import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ApiError, toApiError, type ErrorResponse } from '../error.js';

function send(reply: FastifyReply, request: FastifyRequest, err: ApiError) {
  const body: ErrorResponse = {
    error: { code: err.code, message: err.message, requestId: request.id },
  };
  return reply.status(err.statusCode).send(body);
}

export default fp(async (app: FastifyInstance) => {
  app.setNotFoundHandler((request, reply) =>
    send(
      reply,
      request,
      ApiError.notFound(`Route ${request.method} ${request.url.split('?')[0]} not found`),
    ),
  );

  app.setErrorHandler((error: unknown, request, reply) => {
    const known = toApiError(error);
    if (known) {
      if (known.statusCode >= 500) request.log.error({ err: error }, 'request failed');
      return send(reply, request, known);
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const message = error.validation
        .map(
          (v) =>
            `${v.instancePath ? v.instancePath.slice(1).replaceAll('/', '.') : 'request'}: ${v.message}`,
        )
        .join('; ');
      return send(reply, request, ApiError.validation(message));
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response did not match its schema');
      return send(reply, request, ApiError.internal());
    }

    const e = error as { statusCode?: number; code?: string; message?: string };
    // Fastify-in öz 4xx xətaları (yanlış JSON, çox böyük body, media type…)
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return send(
        reply,
        request,
        ApiError.validation(
          e.message ?? 'Bad request',
          e.statusCode === 400 ? undefined : e.statusCode,
        ),
      );
    }

    // A-13: gözlənilməz/DB xətası → 5xx; daxili detal müştəriyə sızdırılmır.
    request.log.error({ err: error }, 'unhandled error');
    return send(reply, request, ApiError.internal());
  });
});
