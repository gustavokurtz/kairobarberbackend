import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().default(3000),
  APP_URL: Joi.string().uri().required(),
  APP_PUBLIC_URL: Joi.string().uri().required(),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),

  DATABASE_URL: Joi.string().uri().required(),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('7d'),

  EMAIL_PROVIDER: Joi.string().valid('console', 'resend').default('console'),
  EMAIL_FROM: Joi.string()
    .email({ tlds: { allow: false } })
    .required(),
  RESEND_API_KEY: Joi.string().when('EMAIL_PROVIDER', {
    is: 'resend',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),

  PASSWORD_HASH_TIME_COST: Joi.number().integer().min(2).default(3),
  PASSWORD_HASH_MEMORY_COST: Joi.number().integer().min(32768).default(65536),

  THROTTLE_TTL: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(10),

  STORAGE_PROVIDER: Joi.string().valid('console', 'r2').default('console'),
  R2_ACCOUNT_ID: Joi.string().when('STORAGE_PROVIDER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_ACCESS_KEY_ID: Joi.string().when('STORAGE_PROVIDER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_SECRET_ACCESS_KEY: Joi.string().when('STORAGE_PROVIDER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  R2_BUCKET: Joi.string().when('STORAGE_PROVIDER', {
    is: 'r2',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),

  SENTRY_DSN: Joi.string().uri().optional().allow(''),

  REDIS_URL: Joi.string().uri().required(),

  BILLING_PROVIDER: Joi.string().valid('console', 'mercadopago').default('console'),
  BILLING_TRIAL_DAYS: Joi.number().integer().min(0).max(60).default(14),
  BILLING_PAST_DUE_GRACE_DAYS: Joi.number().integer().min(0).max(60).default(7),
  BILLING_SYNC_CRON: Joi.string().default('0 6,18 * * *'),
  BILLING_TRIAL_CHECK_CRON: Joi.string().default('15 6 * * *'),
  BILLING_MRR_CENTS: Joi.number().integer().min(100).default(4990),

  MP_ACCESS_TOKEN: Joi.string().when('BILLING_PROVIDER', {
    is: 'mercadopago',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  MP_PLAN_AMOUNT_CENTS: Joi.number().integer().min(100).when('BILLING_PROVIDER', {
    is: 'mercadopago',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  MP_BILLING_FREQUENCY: Joi.string().valid('months').default('months'),
  MP_RETURN_URL: Joi.string()
    .uri()
    .when('BILLING_PROVIDER', {
      is: 'mercadopago',
      then: Joi.required(),
      otherwise: Joi.optional().allow(''),
    }),
  MP_API_BASE_URL: Joi.string().uri().default('https://api.mercadopago.com'),

  BILLING_NOW_OVERRIDE_MS: Joi.number().integer().optional(),

  // SaaS owner bootstrap (lido apenas pelo seed)
  SAAS_OWNER_EMAIL: Joi.string().email({ tlds: { allow: false } }).optional(),
  SAAS_OWNER_PASSWORD: Joi.string().min(10).optional(),
  SAAS_OWNER_NAME: Joi.string().min(2).max(80).optional(),
  ALLOW_PROD_SEED: Joi.string().valid('true', 'false').optional(),

  // AI Visagism (Fase 6)
  AI_VISAGISM_PROVIDER: Joi.string().valid('console', 'aisdk').default('console'),
  AI_VISAGISM_MONTHLY_QUOTA: Joi.number().integer().min(0).default(100),
  AI_VISAGISM_RETENTION_DAYS: Joi.number().integer().min(1).max(365).default(7),
  AI_VISAGISM_CLEANUP_CRON: Joi.string().default('0 3 * * *'),
  AI_VISAGISM_QUOTA_RESET_CRON: Joi.string().default('5 0 1 * *'),
  AI_VISAGISM_PHOTO_MAX_BYTES: Joi.number().integer().min(102400).default(5 * 1024 * 1024),
  AI_VISAGISM_PHOTO_MIN_DIMENSION: Joi.number().integer().min(64).default(256),
  AI_VISAGISM_CONSENT_MAX_AGE_SECONDS: Joi.number().integer().min(60).default(3600),
  AI_VISAGISM_GROQ_MODEL: Joi.string().default('meta-llama/llama-4-scout-17b-16e-instruct'),
  AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS: Joi.number().min(0).default(1),
  AI_VISAGISM_OPENAI_IMAGE_MODEL: Joi.string().default('gpt-image-1'),
  AI_VISAGISM_OPENAI_IMAGE_COST_CENTS: Joi.number().integer().min(0).default(4),
  GROQ_API_KEY: Joi.string().when('AI_VISAGISM_PROVIDER', {
    is: 'aisdk',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
  OPENAI_API_KEY: Joi.string().when('AI_VISAGISM_PROVIDER', {
    is: 'aisdk',
    then: Joi.required(),
    otherwise: Joi.optional().allow(''),
  }),
});

export type AppEnv = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  APP_URL: string;
  APP_PUBLIC_URL: string;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ACCESS_TTL: string;
  JWT_REFRESH_TTL: string;
  EMAIL_PROVIDER: 'console' | 'resend';
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;
  PASSWORD_HASH_TIME_COST: number;
  PASSWORD_HASH_MEMORY_COST: number;
  THROTTLE_TTL: number;
  THROTTLE_LIMIT: number;
  STORAGE_PROVIDER: 'console' | 'r2';
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  SENTRY_DSN?: string;
  REDIS_URL: string;
  BILLING_PROVIDER: 'console' | 'mercadopago';
  BILLING_TRIAL_DAYS: number;
  BILLING_PAST_DUE_GRACE_DAYS: number;
  BILLING_SYNC_CRON: string;
  BILLING_TRIAL_CHECK_CRON: string;
  BILLING_MRR_CENTS: number;
  MP_ACCESS_TOKEN?: string;
  MP_PLAN_AMOUNT_CENTS?: number;
  MP_BILLING_FREQUENCY: 'months';
  MP_RETURN_URL?: string;
  MP_API_BASE_URL: string;
  BILLING_NOW_OVERRIDE_MS?: number;
  SAAS_OWNER_EMAIL?: string;
  SAAS_OWNER_PASSWORD?: string;
  SAAS_OWNER_NAME?: string;
  ALLOW_PROD_SEED?: 'true' | 'false';
  AI_VISAGISM_PROVIDER: 'console' | 'aisdk';
  AI_VISAGISM_MONTHLY_QUOTA: number;
  AI_VISAGISM_RETENTION_DAYS: number;
  AI_VISAGISM_CLEANUP_CRON: string;
  AI_VISAGISM_QUOTA_RESET_CRON: string;
  AI_VISAGISM_PHOTO_MAX_BYTES: number;
  AI_VISAGISM_PHOTO_MIN_DIMENSION: number;
  AI_VISAGISM_CONSENT_MAX_AGE_SECONDS: number;
  AI_VISAGISM_GROQ_MODEL: string;
  AI_VISAGISM_GROQ_PRICE_PER_MTOK_CENTS: number;
  AI_VISAGISM_OPENAI_IMAGE_MODEL: string;
  AI_VISAGISM_OPENAI_IMAGE_COST_CENTS: number;
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
};
