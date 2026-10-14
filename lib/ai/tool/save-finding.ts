import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { tool } from 'ai';
import { z } from 'zod';
import type { FindingRecord, FindingRepository } from '../lib/types.js';
import { verifySourceDirect } from './verify-source.js';

/** Create once per server process. Database credentials must never reach client JS. */
export function createNeonFindingRepository(databaseUrl: string): FindingRepository {
  const sql = neon(databaseUrl);
  return {
    async upsert(record) {
      const rows = await sql`
        INSERT INTO research_findings (
          user_id, research_id, fingerprint, paper_id, doi, paper_title,
          source_url, claim, evidence_text, evidence_locator, notes, source_check
        ) VALUES (
          ${record.userId}, ${record.researchId}, ${record.fingerprint},
          ${record.paperId}, ${record.doi}, ${record.paperTitle},
          ${record.sourceUrl}, ${record.claim}, ${record.evidenceText},
          ${record.evidenceLocator}, ${record.notes}, ${JSON.stringify(record.sourceCheck)}::jsonb
        )
        ON CONFLICT (user_id, research_id, fingerprint)
        DO UPDATE SET
          evidence_text = EXCLUDED.evidence_text,
          evidence_locator = EXCLUDED.evidence_locator,
          notes = EXCLUDED.notes,
          source_check = EXCLUDED.source_check,
          updated_at = now()
        RETURNING id::text AS id, created_at::text AS created_at,
                  updated_at::text AS updated_at
      `;
      const row = rows[0];
      if (!row) throw new Error('Neon upsert did not return a row');
      return {
        id: String(row.id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      };
    },
  };
}

/** Scope is server-injected; never let an LLM decide tenant/user or research ownership. */
export function createSaveFindingTool(opts: {
  repository: FindingRepository;
  userId: string;
  researchId: string;
  openAlexApiKey?: string;
  fetchImpl?: typeof fetch;
}) {
  if (!opts.userId.trim() || !opts.researchId.trim()) {
    throw new Error('Authenticated userId and authorized researchId are required');
  }
  return tool({
    description:
      'Persist one traceable research finding to the current authorized research project in Neon. Revalidates paper metadata before saving. The cited text and claim are NOT automatically fact-checked; use a real document passage and locator.',
    inputSchema: z.object({
      paperTitle: z.string().trim().min(3).max(600),
      doi: z.string().max(300).optional(),
      openAlexId: z.string().max(32).optional(),
      claim: z.string().trim().min(10).max(3000).describe('One atomic, qualified finding'),
      evidenceText: z.string().trim().min(10).max(3000)
        .describe('Exact, attributable source excerpt; never fabricate'),
      evidenceLocator: z.string().trim().min(2).max(300)
        .describe('Where evidence appears: abstract, page 7, section 3.2, etc.'),
      notes: z.string().max(1500).optional(),
    }).refine((x) => Boolean(x.doi || x.openAlexId), 'Provide doi or openAlexId'),
    execute: async (input, ctx) => {
      const verified = await verifySourceDirect({
        doi: input.doi,
        openAlexId: input.openAlexId,
        expectedTitle: input.paperTitle,
      }, {
        fetchImpl: opts.fetchImpl,
        openAlexApiKey: opts.openAlexApiKey,
        signal: ctx.abortSignal,
      });
      if (verified.status !== 'verified' || !verified.title || !verified.url) {
        return {
          saved: false as const,
          reason: verified.detail,
          verification: verified,
        };
      }

      const key = verified.doi ?? input.openAlexId ?? verified.title;
      const fingerprint = createHash('sha256')
        .update(`${key.toLowerCase()}\n${input.claim.trim().toLowerCase()}`)
        .digest('hex');
      const record: FindingRecord = {
        userId: opts.userId,
        researchId: opts.researchId,
        fingerprint,
        paperId: input.openAlexId ?? null,
        doi: verified.doi,
        paperTitle: verified.title,
        sourceUrl: verified.url,
        claim: input.claim.trim(),
        evidenceText: input.evidenceText.trim(),
        evidenceLocator: input.evidenceLocator.trim(),
        notes: input.notes?.trim() || null,
        sourceCheck: verified,
      };
      try {
        const saved = await opts.repository.upsert(record);
        return {
          saved: true as const,
          findingId: saved.id,
          researchId: opts.researchId,
          sourceMetadataVerified: true as const,
          claimSupportVerified: false as const,
          sourceUrl: record.sourceUrl,
          ...saved,
        };
      } catch {
        return {
          saved: false as const,
          // Do not expose SQL/connection details to the LLM or end user.
          reason: 'Database write failed; inspect server logs and retry.',
          verification: verified,
        };
      }
    },
  });
}
