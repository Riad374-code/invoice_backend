import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TAX_TYPES, isLocalDate } from '../accounting/index.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';

const TaxRateSchema = z.object({
  id: z.uuid(),
  taxType: z.enum(TAX_TYPES),
  code: z.string(),
  /** Faizlə, string: "18" = 18% */
  ratePercent: z.string(),
  treatment: z.enum(['taxable', 'zero_rated', 'exempt']).nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  legalSourceId: z.uuid().nullable(),
  status: z.enum(['proposed', 'active']),
});

export default async function taxRateRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/tax-rates',
    {
      schema: {
        tags: ['vat'],
        summary: 'Vergi dərəcələri (tarixə görə qüvvədə olanlar)',
        description:
          'Dərəcələr məlumat bazasındadır və əməliyyat tarixinə görə seçilir. `date` verilərsə, həmin tarixdə qüvvədə olan dərəcələr qaytarılır.',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          taxType: z.enum(TAX_TYPES).optional(),
          date: z.string().optional(),
          status: z.enum(['proposed', 'active']).default('active'),
        }),
        response: { 200: z.array(TaxRateSchema), ...errorResponses(401, 403, 422) },
      },
      config: { permission: PERMISSIONS.VAT_READ },
    },
    async (request) => {
      const { taxType, date, status } = request.query;
      if (date !== undefined && !isLocalDate(date))
        throw ApiError.validation('date must be a valid YYYY-MM-DD date');
      const rates = await app.ctx.repos.taxRates.list({ taxType, effectiveOn: date, status });
      return rates.map((r) => ({
        id: r.id,
        taxType: r.taxType,
        code: r.code,
        ratePercent: r.ratePercent.toString(),
        treatment: r.treatment ?? null,
        validFrom: r.validFrom,
        validTo: r.validTo,
        legalSourceId: r.legalSourceId,
        status: r.status,
      }));
    },
  );
}
