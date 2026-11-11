import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const image =
  'redis:8.2.3-alpine@sha256:08ad0b1d280850169a790dba1393ff7a90aef951fc19632cf4d3ce4f78e679ba';

// Disposable real Redis, no published port or network. The REST bridge is loopback only.
// All commands go through execFile argument arrays; never interpolate shell commands.
export async function startLocalRedis() {
  const name = `teer-quota-test-${randomUUID()}`;
  await exec('docker', ['run', '--detach', '--rm', '--network', 'none', '--name', name, image], {
    windowsHide: true,
  });
  async function command(args) {
    const { stdout } = await exec(
      'docker',
      ['exec', name, 'redis-cli', '--json', ...args.map(String)],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    if (stdout.startsWith('error:')) throw new Error(JSON.parse(stdout.slice(6)));
    return JSON.parse(stdout);
  }
  for (let i = 0; i < 40; i++) {
    try {
      if ((await command(['PING'])) === 'PONG') break;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await command(['PING']), 'PONG');
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const run = async (args) => {
        try {
          const raw = await command(args);
          const encode = (value) =>
            typeof value === 'string' && value !== 'OK'
              ? Buffer.from(value).toString('base64')
              : Array.isArray(value)
                ? value.map(encode)
                : value;
          return { result: req.headers['upstash-encoding'] === 'base64' ? encode(raw) : raw };
        } catch (error) {
          return {
            error:
              error instanceof Error && error.message.startsWith('NOSCRIPT')
                ? 'NOSCRIPT No matching script'
                : 'local redis command failed',
          };
        }
      };
      const result = req.url === '/pipeline' ? await Promise.all(input.map(run)) : await run(input);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    command,
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await exec('docker', ['stop', name], { windowsHide: true });
    },
  };
}
