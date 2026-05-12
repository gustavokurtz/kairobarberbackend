import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/e2e/.*\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          resolvePackageJsonExports: false,
        },
      },
    ],
  },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/support/jest-setup.ts'],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    // file-type v21+ is ESM-only; Jest CJS mode can't dynamic-import it.
    // This shim loads file-type via createRequire from inside the package dir,
    // bypassing the exports-map "type":"module" restriction.
    '^file-type$': '<rootDir>/test/support/file-type-cjs.js',
  },
  testTimeout: 120_000,
};

export default config;
