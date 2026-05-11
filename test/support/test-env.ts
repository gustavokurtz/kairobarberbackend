export function setTestEnv() {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.APP_URL = 'http://localhost';
  process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
  process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.JWT_REFRESH_TTL = '7d';
  process.env.EMAIL_PROVIDER = 'console';
  process.env.EMAIL_FROM = 'noreply@kairobarber.test';
  process.env.LOG_LEVEL = 'fatal';
}
