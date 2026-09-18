const mockGetBooleanInput = jest.fn();
const mockGetInput = jest.fn();
const mockWarning = jest.fn();
const mockUploadTraces = jest.fn();
const mockBuildDiagnostics = jest.fn();
const mockWrite = jest.fn().mockResolvedValue(undefined);

jest.mock('@actions/core', () => ({
  getBooleanInput: mockGetBooleanInput,
  getInput: mockGetInput,
  warning: mockWarning,
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  summary: {
    addHeading: jest.fn().mockReturnThis(),
    addRaw: jest.fn().mockReturnThis(),
    write: mockWrite,
  },
}));
jest.mock('../src/utils/trace-uploader', () => ({
  TraceUploader: {
    uploadTraces: mockUploadTraces,
    buildFailureDiagnostics: mockBuildDiagnostics,
  },
}));

import { runPost } from '../src/post';

describe('post action', () => {
  beforeEach(() => {
    mockGetBooleanInput.mockReset();
    mockGetInput.mockReset();
    mockWarning.mockClear();
    mockUploadTraces.mockReset();
    mockBuildDiagnostics.mockReset();
    mockWrite.mockClear();
  });

  it('does nothing when trace capture is disabled', async () => {
    mockGetBooleanInput.mockReturnValue(false);
    await runPost();
    expect(mockUploadTraces).not.toHaveBeenCalled();
  });

  it('uploads diagnostics after later workflow steps and writes a summary', async () => {
    mockGetBooleanInput.mockReturnValue(true);
    mockGetInput.mockReturnValue('custom-results');
    mockUploadTraces.mockResolvedValue({ artifactName: 'traces-1', fileCount: 2 });
    mockBuildDiagnostics.mockResolvedValue('| Test | Trace |');

    await runPost();

    expect(mockUploadTraces).toHaveBeenCalledWith('custom-results');
    expect(mockBuildDiagnostics).toHaveBeenCalledWith('custom-results');
    expect(mockWrite).toHaveBeenCalled();
  });

  it('warns without replacing the test failure when upload fails', async () => {
    mockGetBooleanInput.mockReturnValue(true);
    mockUploadTraces.mockRejectedValue(new Error('upload failed'));
    await runPost();
    expect(mockWarning).toHaveBeenCalledWith('Trace upload failed (non-fatal): upload failed');
  });
});
