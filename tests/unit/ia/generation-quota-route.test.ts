import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  usage: vi.fn(),
  stream: vi.fn(),
  persist: vi.fn(),
  validate: vi.fn(),
}));
vi.mock('@/lib/ia/server-context', () => ({
  resolveIaContext: async () => ({
    ok: true,
    ctx: {
      userId: 'synthetic-user',
      merchantAccountId: 'synthetic-tenant',
      role: 'owner',
      supabase: {},
    },
  }),
}));
vi.mock('@/lib/ia/generation-quota', () => ({
  reserveIaGeneration: mocks.reserve,
  recordIaGenerationUsage: mocks.usage,
}));
vi.mock('@/lib/ia/rate-limit', () => ({
  checkToolRateLimit: async () => ({ ok: true, count: 0 }),
}));
vi.mock('@/lib/ia/conversation', () => ({
  validateConversation: mocks.validate,
  persistMessage: mocks.persist,
  touchConversation: vi.fn(),
}));
vi.mock('@/lib/ia/ai-tools', () => ({ buildAiToolSet: () => ({}) }));
vi.mock('@/lib/ia/system-prompt', () => ({ buildSystemPrompt: () => 'synthetic' }));
vi.mock('@ai-sdk/groq', () => ({ groq: () => ({}) }));
vi.mock('ai', () => ({
  streamText: mocks.stream,
  stepCountIs: () => 5,
  convertToModelMessages: async () => [],
}));
import { POST } from '@/app/api/assistant/chat/route';

const request = () =>
  new Request('http://127.0.0.1/api/assistant/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: 'synthetic-conversation',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Bonjour' }] }],
    }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.reserve.mockResolvedValue({ ok: true });
  mocks.validate.mockResolvedValue('synthetic-conversation');
  mocks.usage.mockResolvedValue(true);
  mocks.stream.mockReturnValue({
    toUIMessageStreamResponse: () => new Response('synthetic-stream'),
  });
});
describe('generation reservation before provider use', () => {
  it.each([
    ['unavailable', 503],
    ['limited', 429],
  ] as const)('%s blocks all provider and message writes', async (reason, status) => {
    mocks.reserve.mockResolvedValue({ ok: false, reason });
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: `generation_${reason}` });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    if (status === 429) expect(response.headers.get('retry-after')).toBe('60');
  });
  it('invalid conversation never reserves or calls provider', async () => {
    mocks.validate.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it('successful stream reserves first and records total known usage once', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stream.mock.invocationCallOrder[0],
    );
    const options = mocks.stream.mock.calls[0][0];
    await options.onFinish({ text: 'Bonjour', totalUsage: { inputTokens: 13, outputTokens: 7 } });
    expect(mocks.usage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'synthetic-user', merchantAccountId: 'synthetic-tenant' }),
      { failed: false, inputTokens: 13, outputTokens: 7 },
    );
  });
  it('provider error consumes reservation and does not count a subsequent finish twice', async () => {
    await POST(request());
    const options = mocks.stream.mock.calls[0][0];
    await options.onError({ error: new Error('synthetic provider error') });
    await options.onFinish({ text: '', totalUsage: {} });
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    expect(mocks.usage).toHaveBeenCalledWith(expect.anything(), { failed: true });
  });
});
