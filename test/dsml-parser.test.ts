/**
 * Тесты DSML-парсера (non-streaming): извлечение tool_calls из текста,
 * нормализация, fail-safe на незакрытых блоках, уникальность id.
 */
import { describe, expect, it } from 'vitest';
import { normalizeDsml, parseDsml } from '../src/translate/dsml-parser.js';

/** Маркер DSML. */
const MARKER = '<｜DSML｜';

/** Обёртка tool_calls. */
const wrap = (inner: string): string => `${MARKER}tool_calls>${inner}</｜DSML｜tool_calls>`;

/** Invoke. */
const invoke = (name: string, inner: string): string =>
  `${MARKER}invoke name="${name}">${inner}</｜DSML｜invoke>`;

/** Параметр. */
const param = (name: string, value: string, stringType = true): string =>
  `${MARKER}parameter name="${name}"${stringType ? ' string="true"' : ''}>${value}</｜DSML｜parameter>`;

/** Проверяет, что значение — объект (type guard для `unknown`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Безопасно разбирает `arguments` в объект. */
const parseArgs = (raw: string | undefined): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(raw ?? '{}');
  if (!isRecord(parsed)) {
    throw new Error('arguments не является JSON-объектом');
  }
  return parsed;
};

/** Разбор `arguments` вызова. */
const argsOf = (callIndex = 0): Record<string, unknown> => {
  const result = parseDsml(
    wrap(invoke('bash', param('command', 'ls -la'))),
  );
  const call = result.tool_calls[callIndex];
  if (call === undefined) {
    throw new Error('tool_call не найден');
  }
  return parseArgs(call.function.arguments);
};

describe('parseDsml', () => {
  it('обычный текст без DSML: tool_calls пуст, текст сохранён', () => {
    const result = parseDsml('Привет! Чем могу помочь?');
    expect(result.tool_calls).toEqual([]);
    expect(result.text).toBe('Привет! Чем могу помочь?');
    expect(result.warnings).toEqual([]);
  });

  it('один invoke с одним параметром', () => {
    const result = parseDsml(wrap(invoke('bash', param('command', 'ls -la'))));
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]?.function.name).toBe('bash');
    expect(result.text).toBe('');
    expect(argsOf()).toEqual({ command: 'ls -la' });
  });

  it('один invoke с двумя параметрами', () => {
    const inner = param('command', 'ls -la') + param('cwd', '/tmp');
    const result = parseDsml(wrap(invoke('bash', inner)));
    expect(result.tool_calls).toHaveLength(1);
    expect(JSON.parse(result.tool_calls[0]?.function.arguments ?? '{}')).toEqual({
      command: 'ls -la',
      cwd: '/tmp',
    });
  });

  it('два invoke → два tool_calls', () => {
    const inner = invoke('bash', param('command', 'ls')) + invoke('read_file', param('path', 'a.txt'));
    const result = parseDsml(wrap(inner));
    expect(result.tool_calls).toHaveLength(2);
    expect(result.tool_calls.map((call) => call.function.name)).toEqual(['bash', 'read_file']);
  });

  it('DSML + текст до/после: текст сохранён, DSML удалён', () => {
    const text = `до\n${wrap(invoke('bash', param('command', 'ls')))}после`;
    const result = parseDsml(text);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.text).toContain('до');
    expect(result.text).toContain('после');
    expect(result.text).not.toContain('DSML');
  });

  it('двойные pipe-маркеры нормализуются', () => {
    const text = `<｜｜DSML｜｜tool_calls>${invoke('bash', param('command', 'ls'))}</｜DSML｜tool_calls>`;
    expect(normalizeDsml(text)).toContain(`${MARKER}tool_calls>`);
    const result = parseDsml(text);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]?.function.name).toBe('bash');
  });

  it('пробельное `<｜DSML｜ calls>` нормализуется в wrapper', () => {
    const text = `<｜DSML｜ calls>${invoke('bash', param('command', 'ls'))}</｜DSML｜tool_calls>`;
    const result = parseDsml(text);
    expect(result.tool_calls).toHaveLength(1);
  });

  it('пропущен wrapper: invoke на верхнем уровне парсится + warning', () => {
    const result = parseDsml(`текст ${invoke('bash', param('command', 'ls'))}`);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.warnings).toContain('missing tool_calls wrapper');
  });

  it('незакрытый параметр: вызов не создаётся + warning', () => {
    const broken = `${MARKER}invoke name="bash">${MARKER}parameter name="command" string="true">ls -la</｜DSML｜invoke>`;
    const result = parseDsml(wrap(broken));
    expect(result.tool_calls).toHaveLength(0);
    expect(result.warnings).toContain('unclosed parameter');
  });

  it('незакрытый invoke: вызов не создаётся + warning', () => {
    const broken = `${MARKER}invoke name="bash">${param('command', 'ls')}`;
    const result = parseDsml(wrap(broken));
    expect(result.tool_calls).toHaveLength(0);
    expect(result.warnings).toContain('unclosed invoke');
  });

  it('параметр без name: вызов не создаётся + warning', () => {
    const broken = invoke('bash', `${MARKER}parameter string="true">foo</｜DSML｜parameter>`);
    const result = parseDsml(wrap(broken));
    expect(result.tool_calls).toHaveLength(0);
    expect(result.warnings).toContain('parameter without name');
  });

  it('пустой invoke → arguments "{}"', () => {
    const result = parseDsml(wrap(invoke('bash', '')));
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]?.function.arguments).toBe('{}');
  });

  it('string="true" оставляет значение строкой', () => {
    const result = parseDsml(wrap(invoke('bash', param('command', '42'))));
    const args = parseArgs(result.tool_calls[0]?.function.arguments);
    expect(args['command']).toBe('42');
  });

  it('без string значение парсится как JSON (число/boolean)', () => {
    const result = parseDsml(
      wrap(invoke('tool', `${param('count', '42', false)}${param('enabled', 'true', false)}`)),
    );
    const args = parseArgs(result.tool_calls[0]?.function.arguments);
    expect(args['count']).toBe(42);
    expect(args['enabled']).toBe(true);
  });

  it('DSML-маркер внутри значения → fail-safe, вызов не создаётся', () => {
    const broken = invoke(
      'bash',
      `${MARKER}parameter name="x">${MARKER}parameter name="y">foo</｜DSML｜parameter>`,
    );
    const result = parseDsml(wrap(broken));
    expect(result.tool_calls).toHaveLength(0);
    expect(result.warnings).toContain('DSML marker inside parameter value');
  });

  it('arguments — валидный JSON', () => {
    const result = parseDsml(wrap(invoke('bash', param('command', 'echo "hi"'))));
    const raw = result.tool_calls[0]?.function.arguments ?? '';
    expect(() => JSON.parse(raw)).not.toThrow();
    const args = parseArgs(raw);
    expect(args['command']).toBe('echo "hi"');
  });

  it('несколько wrapper-блоков → все вызовы', () => {
    const first = wrap(invoke('bash', param('command', 'ls')));
    const second = wrap(invoke('read_file', param('path', 'b.txt')));
    const result = parseDsml(`${first}\n${second}`);
    expect(result.tool_calls).toHaveLength(2);
  });

  it('обрезает одиночный закрывающий тег из текста', () => {
    const result = parseDsml('Привет</｜DSML｜tool_calls>');
    expect(result.text).toBe('Привет');
    expect(result.tool_calls).toEqual([]);
  });

  it('вырезает незакрытый invoke целиком (мусор не попадает в text)', () => {
    const result = parseDsml('<｜DSML｜invoke name="bash">незакрытый');
    expect(result.text).toBe('');
    expect(result.tool_calls).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('parseDsml: уникальность id', () => {
  it('100 разборов дают разные id', () => {
    const input = wrap(invoke('bash', param('command', 'ls')));
    const ids = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const result = parseDsml(input);
      const id = result.tool_calls[0]?.id;
      expect(id).toMatch(/^call_[0-9a-z]{12}$/u);
      if (id !== undefined) {
        ids.add(id);
      }
    }
    expect(ids.size).toBe(100);
  });
});
