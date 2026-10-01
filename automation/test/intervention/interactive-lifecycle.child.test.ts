import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function rebind(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

describe('interactive lifecycle child process', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('cleans up and releases its port on %s', async (signal, expectedCode) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'interactive-child-'));
    const evidencePath = path.join(directory, 'events.jsonl');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/interactive-lifecycle-child.ts', evidencePath],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (value) => (stdout += String(value)));
    child.stderr.setEncoding('utf8').on('data', (value) => (stderr += String(value)));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const inspect = (value: Buffer | string) => {
          const match = String(value).match(/READY (\d+)/);
          if (match) resolve(Number(match[1]));
        };
        child.stdout.on('data', inspect);
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`child exited before ready: ${code}`)));
      });
      child.kill(signal);
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(code).toBe(expectedCode);
      await rebind(port);
      const evidence = await readFile(evidencePath, 'utf8');
      expect(evidence).toContain('shutdown_signal_received');
      expect(evidence).toContain('operator_server_stopped');
      expect(stdout).not.toContain('#');
      expect(stderr).not.toContain('Bearer ');
      expect(evidence).not.toContain('Bearer ');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });
});
