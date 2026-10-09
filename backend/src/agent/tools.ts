import { z } from 'zod';
import type { Db, Repos } from '../db/index.js';
import type { PermissionCode } from '../domain/index.js';
import type { ToolSpec } from '../llm/client.js';
import type { ObjectStorage } from '../storage/index.js';
import type { RagOcrClient } from '../ragocr/client.js';
import type { ModelServing } from '../models/client.js';
import type { SourceHit } from '../rag/citations.js';
import type { SearchRequest, SearchResult } from '../rag/search.js';

export type ToolRisk = 'read' | 'low-write' | 'moderate-write';

/** Bir söhbət növbəsi (turn) ərzində toplanan mənbələr: etiketlər [S1], [S2]… alətlər arasında ardıcıl davam edir. */
export class SourceAccumulator {
  readonly hits: SourceHit[] = [];
  add(h: Omit<SourceHit, 'label'>): SourceHit {
    const existing = this.hits.find((x) => x.id === h.id);
    if (existing) return existing;
    const hit = { ...h, label: `S${this.hits.length + 1}` };
    this.hits.push(hit);
    return hit;
  }
}

export interface ToolContext {
  /** Sessiyadan (JWT / təsdiq sorğusu). Model bunu NƏ görür, NƏ də dəyişə bilər. */
  companyId: string;
  userId: string;
  permissions: readonly string[];
  requestId: string;
  conversationId: string | null;
  repos: Repos;
  db: Db;
  search: (
    req: Omit<SearchRequest, 'companyId' | 'resourceTypes'> & {
      resourceTypes: SearchRequest['resourceTypes'];
    },
  ) => Promise<SearchResult>;
  sources: SourceAccumulator;
  models?: ModelServing | undefined;
  ragOcr?: RagOcrClient | undefined;
  storage?: ObjectStorage | undefined;
  /** Təsdiqdən sonra icrada: təsdiqi verən istifadəçi */
  approvedBy?: string | undefined;
  now: Date;
}

export interface ToolDef<A = unknown> {
  name: string;
  description: string;
  risk: ToolRisk;
  permission: PermissionCode;
  /** `.strict()` olmalıdır: modelin əlavə etdiyi `companyId` kimi sahələr rədd olunur. */
  args: z.ZodType<A>;
  /** Hələ backend-i olmayan alətlər qeyd olunur, amma modelə təqdim edilmir və icra olunmur. */
  available: boolean;
  handler: (ctx: ToolContext, args: A) => Promise<unknown>;
  /** Təsdiq tələb edən alətlər üçün insan oxuya bilən önbaxış. */
  preview?: (args: A) => string;
}

export function defineTool<A>(def: ToolDef<A>): ToolDef<unknown> {
  return def as unknown as ToolDef<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef<unknown>>();
  register(def: ToolDef<unknown>): void {
    if (this.tools.has(def.name)) throw new Error(`Tool ${def.name} already registered`);
    if (!/^[a-z][a-z0-9_.]*$/.test(def.name)) throw new Error(`Invalid tool name ${def.name}`);
    this.tools.set(def.name, def);
  }
  get(name: string): ToolDef<unknown> | undefined {
    return this.tools.get(name);
  }
  all(): ToolDef<unknown>[] {
    return [...this.tools.values()];
  }
  /** Modelə yalnız mövcud və İSTİFADƏÇİNİN İCAZƏSİ OLAN alətlər göstərilir (gateway yenə də yoxlayır). */
  specsFor(permissions: readonly string[]): ToolSpec[] {
    return this.all()
      .filter((t) => t.available && permissions.includes(t.permission))
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name.replaceAll('.', '__'),
          description: `[${t.risk}] ${t.description}`,
          parameters: z.toJSONSchema(t.args, { target: 'draft-7' }),
        },
      }));
  }
  /** OpenAI funksiya adlarında nöqtə olmur: `vat.calculate` ↔ `vat__calculate`. */
  static fromWireName(name: string): string {
    return name.replaceAll('__', '.');
  }
}
