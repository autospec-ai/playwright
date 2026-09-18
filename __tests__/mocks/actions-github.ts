export const context = {
  eventName: 'push',
  payload: {} as Record<string, unknown>,
  ref: 'refs/heads/main',
  repo: { owner: 'test', repo: 'test' },
};
export const getOctokit = jest.fn();
