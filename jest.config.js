module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@actions/core$': '<rootDir>/__tests__/mocks/actions-core.ts',
    '^@actions/github$': '<rootDir>/__tests__/mocks/actions-github.ts',
    '^@actions/exec$': '<rootDir>/__tests__/mocks/actions-exec.ts',
  },
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 75,
      lines: 70,
      statements: 68,
    },
  },
};
