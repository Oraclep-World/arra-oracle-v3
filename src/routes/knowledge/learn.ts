/**
 * POST /api/learn — record a learning pattern.
 */

import { Elysia } from 'elysia';
import { handleLearn } from '../../server/handlers.ts';
import { LearningIndexError } from '../../learn/index-rows.ts';
import { LearnBody } from './model.ts';

export const learnEndpoint = new Elysia()
  .post(
    '/learn',
    ({ body, set }) => {
      try {
        const data = (body ?? {}) as Record<string, any>;
        if (!data.pattern) {
          set.status = 400;
          return { error: 'Missing required field: pattern' };
        }
        return handleLearn(
          data.pattern,
          data.source,
          data.concepts,
          data.origin,
          data.project,
          data.cwd,
        );
      } catch (error) {
        // "File written, index missing" is recoverable and the caller is the only
        // one who can recover it — say so, with the exact next action. A bare 500
        // reads as "the write failed", which leads either to a reworded retry
        // (duplicate letter) or to giving up (a file no search will ever find:
        // there is no cron that reindexes FTS, and the vector cron embeds from
        // sqlite, so a missing row stays missing). Found by ora101, 2026-07-30.
        if (error instanceof LearningIndexError) {
          set.status = 503;
          return {
            error: error.message,
            file: error.sourceFile,
            id: error.docId,
            fileWritten: true,
            retrySafe: true,
            tip:
              'The learning file IS saved on disk; only its index rows are missing. ' +
              'POST the SAME pattern text again — the retry repairs the index and returns ' +
              'deduped:true. Do NOT reword it: that creates a second entry for one lesson.',
          };
        }
        set.status = 500;
        return { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
    {
      body: LearnBody,
      detail: {
        tags: ['knowledge'],
        menu: { group: 'hidden' },
        summary: 'Record a learning pattern',
      },
    },
  );
