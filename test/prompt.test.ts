/**
 * Тесты Prompt Builder: OpenAI messages/tools → DeepSeek prompt с DSML.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPromptAsync,
  PromptValidationError,
  type ToolChoice,
} from '../src/translate/prompt.js';
import type { OpenAiMessage, OpenAiTool, OpenAiToolCall } from '../src/translate/types.js';

/** Инструмент `bash` с JSON Schema параметров. */
const BASH_TOOL: OpenAiTool = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Выполняет shell-команду',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Команда для выполнения' },
        cwd: { type: 'string', description: 'Рабочий каталог' },
      },
      required: ['command'],
    },
  },
};

/** Сообщение пользователя. */
const USER_MESSAGE: OpenAiMessage = { role: 'user', content: 'привет' };

describe('buildPromptAsync', () => {
  it('без tools: только [USER], без DSML', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE] });
    expect(result.prompt).toContain('[USER]\nпривет');
    expect(result.prompt).not.toContain('DSML');
    expect(result.toolsInjected).toEqual([]);
  });

  it('с tools: добавляет DSML-инструкцию и список инструментов', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE], tools: [BASH_TOOL] });
    expect(result.prompt).toContain('<｜DSML｜tool_calls>');
    expect(result.prompt).toContain('Доступные инструменты:');
    expect(result.prompt).toContain('- bash: Выполняет shell-команду');
    expect(result.prompt).toContain('- command (string, required): Команда для выполнения');
    expect(result.prompt).toContain('- cwd (string, optional): Рабочий каталог');
    expect(result.toolsInjected).toEqual(['bash']);
  });

  it('system + user: system слит в начало prompt', () => {
    const messages: OpenAiMessage[] = [
      { role: 'system', content: 'Ты — тестовый ассистент.' },
      USER_MESSAGE,
    ];
    const result = buildPromptAsync({ messages });
    expect(result.prompt.startsWith('[SYSTEM]\nТы — тестовый ассистент.')).toBe(true);
    expect(result.prompt).toContain('[USER]\nпривет');
  });

  it('assistant с tool_calls превращается в DSML-блок', () => {
    const call: OpenAiToolCall = {
      id: 'call_1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"ls -la"}' },
    };
    const messages: OpenAiMessage[] = [
      USER_MESSAGE,
      { role: 'assistant', content: null, tool_calls: [call] },
    ];
    const result = buildPromptAsync({ messages, tools: [BASH_TOOL] });
    expect(result.prompt).toContain('[ASSISTANT]');
    expect(result.prompt).toContain('<｜DSML｜invoke name="bash">');
    expect(result.prompt).toContain('<｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>');
  });

  it('tool-результат форматируется как [TOOL_RESULT id=...]', () => {
    const messages: OpenAiMessage[] = [
      { role: 'tool', content: 'file.txt', tool_call_id: 'call_1' },
    ];
    const result = buildPromptAsync({ messages });
    expect(result.prompt).toContain('[TOOL_RESULT id=call_1]\nfile.txt');
  });

  it('toolChoice: none отключает DSML даже при tools', () => {
    const result = buildPromptAsync({
      messages: [USER_MESSAGE],
      tools: [BASH_TOOL],
      toolChoice: 'none',
    });
    expect(result.prompt).not.toContain('DSML');
    expect(result.toolsInjected).toEqual([]);
  });

  it('toolChoice: конкретная функция добавляет требование «обязательно»', () => {
    const toolChoice: ToolChoice = { type: 'function', function: { name: 'bash' } };
    const result = buildPromptAsync({
      messages: [USER_MESSAGE],
      tools: [BASH_TOOL],
      toolChoice,
    });
    expect(result.prompt).toContain('обязательно вызови инструмент `bash`');
    expect(result.toolsInjected).toEqual(['bash']);
  });

  it('toolChoice: required требует вызвать один из инструментов', () => {
    const result = buildPromptAsync({
      messages: [USER_MESSAGE],
      tools: [BASH_TOOL],
      toolChoice: 'required',
    });
    expect(result.prompt).toContain('обязательно вызови один из доступных инструментов');
  });

  it('toolChoice: auto не добавляет требование', () => {
    const result = buildPromptAsync({
      messages: [USER_MESSAGE],
      tools: [BASH_TOOL],
      toolChoice: 'auto',
    });
    expect(result.prompt).not.toContain('обязательно вызови');
  });

  it('пустой messages → PromptValidationError', () => {
    expect(() => buildPromptAsync({ messages: [] })).toThrow(PromptValidationError);
  });

  it('toolChoice на неизвестный инструмент → PromptValidationError', () => {
    expect(() =>
      buildPromptAsync({
        messages: [USER_MESSAGE],
        tools: [BASH_TOOL],
        toolChoice: { type: 'function', function: { name: 'unknown-tool' } },
      }),
    ).toThrow(PromptValidationError);
  });

  it('toolChoice: required без tools → PromptValidationError', () => {
    expect(() => buildPromptAsync({ messages: [USER_MESSAGE], toolChoice: 'required' })).toThrow(
      PromptValidationError,
    );
  });

  it('инструктирует отвечать текстом после результата инструмента', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE], tools: [BASH_TOOL] });
    expect(result.prompt).toContain('после получения результата инструмента');
    expect(result.prompt).toContain('Не оставляй ответ пустым');
  });

  it('учит использовать bash для нестандартных задач', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE], tools: [BASH_TOOL] });
    expect(result.prompt).toContain('используй `bash` для запуска соответствующего скрипта');
    expect(result.prompt).toContain('сразу вызывай `bash`');
  });

  it('содержит few-shot пример системной задачи (pyautogui)', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE], tools: [BASH_TOOL] });
    expect(result.prompt).toContain('pyautogui');
    expect(result.prompt).toContain('поводи мышью');
    expect(result.prompt).toContain('<｜DSML｜tool_calls>');
  });

  it('содержит few-shot для скриншота через PowerShell', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE], tools: [BASH_TOOL] });
    expect(result.prompt).toContain('screenshot.png');
    expect(result.prompt).toContain('CopyFromScreen');
    expect(result.prompt).toContain('System.Windows.Forms');
  });

  it('учит возвращать путь к файлу в текстовом ответе', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE], tools: [BASH_TOOL] });
    expect(result.prompt).toContain('Файл сохранён:');
    expect(result.prompt).toContain('Не пытайся вставить файл в чат');
  });

  it('учит проверять cwd через pwd/cd', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE], tools: [BASH_TOOL] });
    expect(result.prompt).toContain('выполни `pwd` (bash)');
    expect(result.prompt).toContain('`cd` (PowerShell)');
    expect(result.prompt).toContain('проверяй cwd');
  });

  it('требует включать вывод инструмента в ответ', () => {
    const result = buildPromptAsync({ messages: [USER_MESSAGE], tools: [BASH_TOOL] });
    expect(result.prompt).toContain('обязательно включи');
    expect(result.prompt).toContain('этот вывод');
    expect(result.prompt).toContain('Текущая директория:');
    expect(result.prompt).toContain('Не отвечай');
    expect(result.prompt).toContain('просто «Готово»');
  });

  it('tool-результат: сохраняет путь и помечает пустой content', () => {
    const withPath = buildPromptAsync({
      messages: [{ role: 'tool', content: 'C:\\path', tool_call_id: 'call_1' }],
    });
    expect(withPath.prompt).toContain('[TOOL_RESULT id=call_1]\nC:\\path');

    const empty = buildPromptAsync({
      messages: [{ role: 'tool', content: '', tool_call_id: 'call_2' }],
    });
    expect(empty.prompt).toContain('[TOOL_RESULT id=call_2]\n(empty)');
  });
});
