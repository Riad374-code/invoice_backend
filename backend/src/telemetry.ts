import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry trace export (OTLP/HTTP). Yalnız OTEL_EXPORTER_OTLP_ENDPOINT verilərsə işə düşür.
 * Instrumentasiyanın http/pg modullarını tuta bilməsi üçün BUNDAN SONRA (dinamik import ilə) yüklənməlidir.
 */
export function startTelemetry(endpoint: string): () => Promise<void> {
  const base = endpoint.replace(/\/$/, '');
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'lexaudit-api' }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  return () => sdk.shutdown();
}
