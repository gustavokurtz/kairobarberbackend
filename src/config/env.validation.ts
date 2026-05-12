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
};
