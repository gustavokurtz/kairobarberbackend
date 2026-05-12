export const VISAGISM_PROVIDER = Symbol('VISAGISM_PROVIDER');

export const AI_VISAGISM_CLEANUP_SCHEDULER_KEY = 'ai-visagism-cleanup-scheduler';
export const AI_VISAGISM_QUOTA_RESET_SCHEDULER_KEY = 'ai-visagism-quota-reset-scheduler';

/** Máx por run do cron de cleanup. */
export const AI_VISAGISM_CLEANUP_BATCH_SIZE = 500;

/** TTL da signed URL do worker (download interno). */
export const AI_VISAGISM_INTERNAL_GET_TTL_SECONDS = 300;
