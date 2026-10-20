/**
 * Unit-тесты диагностического e2e-tools: Prompt Builder + mock-поток с DSML.
 *
 * Живой e2e здесь не запускается (нужен auth.json) — только mock.
 */
import { describe, expect, it } from 'vitest';
import type { Auth } from '../src/config.js';
import type { DeepSeekEvent } from '../src/deepseek/client.js';
import type { ChatCompletionRequest } from '../src/deepseek/types.js';
import {
  formatLogTimestampWithSeconds,
  runE2EToolsAsync,
  type E2EToolsDependencies,
} from '../scripts/e2e-tools.js';

/** Сессия для mock. */
const TEST_AUTH: Auth = {
  dsSessionId: 'session-id',
  bearerToken: 'bearer-token',
  savedAt: '2026-10-20T00:00:00.000Z',
};

/** id mock-сессии. */
const SESSION_ID = '589bd06c-0000-4000-8000-000000000001';

/** Ответ модели с DSML-вызовом. */
const DSML_TEXT = `Я выполню команду.
<｜DSML｜tool_calls>
  <｜DSML｜invoke name="bash">
    <｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>
  </｜DSML｜invoke>
</｜DSML｜tool_calls>`;

/** Записанный лог. */
interface LogWrite {
  readonly path: string;
  readonly content: string;
}

/**
 * Создаёт deps с записью лога в память.
 * @param overrides Переопределения.
 * @param writes Массив записанных логов.
 */
const createDeps = (
  overrides: E2EToolsDependencies,
  writes: LogWrite[],
): E2EToolsDependencies => ({
  loadAuth: () => Promise.resolve(TEST_AUTH),
  validateSession: () => Promise.resolve(true),
  createChatSession: () => Promise.resolve({ id: SESSION_ID }),
  log: () => {},
  writeLog: (path, content) => {
    writes.push({ path, content });
    return Promise.resolve();
  },
  logDirectory: 'C:\\fake\\captures',
  date: new Date('2026-10-20T09:05:07Z'),
  ...overrides,
});

/** Создаёт mock `sendChat`, возвращающий заданный текст одним фрагментом. */
const createMockSendChat = (
  text: string,
  captured: { prompt?: string; sessionId?: string },
): NonNullable<E2EToolsDependencies['sendChat']> =>
  async function* mockSendChat(
    request: Omit<ChatCompletionRequest, 'chat_session_id'>,
    _auth: Auth,
    chatSessionId: string,
  ): AsyncGenerator<DeepSeekEvent> {
    captured.prompt = request.prompt;
    captured.sessionId = chatSessionId;
    yield { type: 'text', content: text };
    yield { type: 'status', status: 'FINISHED' };
    yield { type: 'close' };
  };

describe('runE2EToolsAsync', () => {
  it('--prompt-only собирает prompt без запроса к DeepSeek', async () => {
    const writes: LogWrite[] = [];
    let sendChatCalls = 0;
    const deps = createDeps(
      {
        promptOnly: true,
        sendChat: () => {
          sendChatCalls += 1;
          return {
            [Symbol.asyncIterator]: (): AsyncIterator<DeepSeekEvent> => ({
              next: (): Promise<IteratorResult<DeepSeekEvent>> =>
                Promise.resolve({ done: true, value: undefined }),
            }),
          };
        },
      },
      writes,
    );

    const result = await runE2EToolsAsync(deps);

    expect(sendChatCalls).toBe(0);
    expect(result.prompt).toContain('<｜DSML｜tool_calls>');
    expect(result.prompt).toContain('- bash: Выполняет shell-команду');
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([]);
    expect(writes[0]?.content).toContain('prompt-only');
    expect(writes[0]?.content).toContain('PROMPT (first 2000 chars)');
  });

  it('живой поток: собирает prompt, отправляет, парсит DSML → 1 tool_call', async () => {
    const writes: LogWrite[] = [];
    const captured: { prompt?: string; sessionId?: string } = {};
    const deps = createDeps({ sendChat: createMockSendChat(DSML_TEXT, captured) }, writes);

    const result = await runE2EToolsAsync(deps);

    expect(captured.sessionId).toBe(SESSION_ID);
    expect(captured.prompt).toContain('<｜DSML｜tool_calls>');
    expect(result.text).toContain('Я выполню команду.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.name).toBe('bash');
    expect(JSON.parse(result.toolCalls[0]?.function.arguments ?? '{}')).toEqual({
      command: 'ls -la',
    });
    expect(result.warnings).toEqual([]);

    const log = writes[0]?.content ?? '';
    expect(log).toContain('assembled text:');
    expect(log).toContain('tool_calls:');
    expect(log).toContain('"name": "bash"');
    expect(result.logPath).toMatch(/e2e-tools-2026-10-20-\d{2}-\d{2}-\d{2}\.log$/u);
  });

  it('ответ без DSML: tool_calls пуст, текст сохранён', async () => {
    const writes: LogWrite[] = [];
    const deps = createDeps(
      { sendChat: createMockSendChat('Привет! Чем могу помочь?', {}) },
      writes,
    );

    const result = await runE2EToolsAsync(deps);
    expect(result.text).toBe('Привет! Чем могу помочь?');
    expect(result.toolCalls).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('невалидный DSML: tool_calls пуст, warning в результате и логе', async () => {
    const writes: LogWrite[] = [];
    const broken = `<｜DSML｜tool_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">ls`;
    const deps = createDeps({ sendChat: createMockSendChat(broken, {}) }, writes);

    const result = await runE2EToolsAsync(deps);
    expect(result.toolCalls).toEqual([]);
    expect(result.warnings).toContain('unclosed invoke');
    expect(writes[0]?.content).toContain('warnings:');
  });

  it('имя лога содержит секунды', () => {
    expect(formatLogTimestampWithSeconds(new Date('2026-10-20T09:05:07Z'))).toMatch(
      /^2026-10-20-\d{2}-\d{2}-\d{2}$/u,
    );
  });
});
