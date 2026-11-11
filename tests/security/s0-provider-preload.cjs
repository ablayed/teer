// Process-local provider double. Only used by the isolated S0 harness, never loaded by the app.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'api.groq.com' && url.pathname === '/openai/v1/chat/completions') {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const send = (content, finish_reason = null) =>
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: 'synthetic',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'llama-3.3-70b-versatile',
                choices: [{ index: 0, delta: { content }, finish_reason }],
              })}\n\n`,
            ),
          );
        send('Bonjour ');
        setTimeout(() => {
          send(`LOCAL_STREAM_END_${Date.now()}`);
          send('', 'stop');
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }, 500);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('S0 harness forbids non-local provider requests');
  }
  return originalFetch(input, init);
};
