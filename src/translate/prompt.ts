/**
 * Prompt Builder: OpenAI `messages[] + tools[]` → один prompt для DeepSeek.
 *
 * DeepSeek Web API не поддерживает `tool_calls` нативно, поэтому описания
 * инструментов внедряются в prompt DSML-инструкцией (DESIGN § 6.1). Модель
 * либо отвечает DSML-блоком (вызов), либо обычным текстом.
 */
import type { OpenAiMessage, OpenAiTool, OpenAiToolCall } from './types.js';

/** Ошибка валидации входа Prompt Builder. */
export class PromptValidationError extends Error {
  public override readonly name = 'PromptValidationError';

  public constructor(message: string) {
    super(message);
  }
}

/** Политика выбора инструмента (совместима с OpenAI `tool_choice`). */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly type: 'function'; readonly function: { readonly name: string } };

/** Вход Prompt Builder. */
export interface BuildPromptOptions {
  readonly messages: readonly OpenAiMessage[];
  readonly tools?: readonly OpenAiTool[] | undefined;
  readonly toolChoice?: ToolChoice | undefined;
}

/** Результат Prompt Builder. */
export interface BuildPromptResult {
  /** Готовый prompt для `POST /api/v0/chat/completion`. */
  readonly prompt: string;
  /** Имена инструментов, реально внедрённых в prompt (для отладки). */
  readonly toolsInjected: readonly string[];
}

/** Открывающий/закрывающий теги DSML. */
const DSML_CALLS_OPEN = '<｜DSML｜tool_calls>';
const DSML_CALLS_CLOSE = '</｜DSML｜tool_calls>';

/** Проверяет, что значение — объект (type guard для `unknown`). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Разбирает строку аргументов инструмента (JSON) в объект.
 * При некорректном JSON сохраняет сырое значение как `arguments`.
 * @param raw Строка аргументов из `tool_calls[].function.arguments`.
 */
const parseToolArguments = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Ниже вернём сырое значение.
  }
  return { arguments: raw };
};

/**
 * Рендерит один параметр DSML-вызова.
 * @param name Имя параметра.
 * @param value Значение.
 */
const renderParameter = (name: string, value: unknown): string => {
  const stringValue = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return `    <｜DSML｜parameter name="${name}" string="true">${stringValue}</｜DSML｜parameter>`;
};

/**
 * Рендерит историю `tool_calls` assistant'а в DSML-блок (DESIGN § 6.2).
 * @param calls Вызовы инструментов из сообщения assistant.
 */
const renderToolCallsBlock = (calls: readonly OpenAiToolCall[]): string => {
  const lines: string[] = [DSML_CALLS_OPEN];
  for (const call of calls) {
    lines.push(`  <｜DSML｜invoke name="${call.function.name}">`);
    for (const [name, value] of Object.entries(parseToolArguments(call.function.arguments))) {
      lines.push(renderParameter(name, value));
    }
    lines.push('  </｜DSML｜invoke>');
  }
  lines.push(DSML_CALLS_CLOSE);
  return lines.join('\n');
};

/**
 * Рендерит описание одного инструмента (имя, описание, параметры).
 * @param tool Инструмент OpenAI.
 */
const renderToolDescription = (tool: OpenAiTool): string => {
  const name = tool.function.name;
  const description = tool.function.description ?? '';
  const header = description === '' ? `- ${name}` : `- ${name}: ${description}`;
  const lines: string[] = [header];

  const parameters = tool.function.parameters;
  const properties = parameters === undefined ? undefined : parameters['properties'];
  if (!isRecord(properties)) {
    return lines.join('\n');
  }
  const requiredRaw = parameters === undefined ? undefined : parameters['required'];
  const requiredNames = Array.isArray(requiredRaw)
    ? requiredRaw.filter((item): item is string => typeof item === 'string')
    : [];
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return lines.join('\n');
  }

  lines.push('  Параметры:');
  for (const [paramName, schema] of entries) {
    const type = isRecord(schema) && typeof schema['type'] === 'string' ? schema['type'] : 'unknown';
    const flag = requiredNames.includes(paramName) ? 'required' : 'optional';
    const paramDescription =
      isRecord(schema) && typeof schema['description'] === 'string' ? schema['description'] : '';
    const suffix = paramDescription === '' ? '' : `: ${paramDescription}`;
    lines.push(`    - ${paramName} (${type}, ${flag})${suffix}`);
  }
  return lines.join('\n');
};

/**
 * Формирует требование по `toolChoice` (для секции инструкции).
 * @param toolChoice Политика выбора инструмента.
 */
const buildToolRequirement = (toolChoice: ToolChoice): string => {
  if (toolChoice === 'required') {
    return '\n\nВ этом ответе обязательно вызови один из доступных инструментов.';
  }
  if (typeof toolChoice === 'object') {
    return `\n\nВ этом ответе обязательно вызови инструмент \`${toolChoice.function.name}\`.`;
  }
  return '';
};

/**
 * Формирует DSML-инструкцию со списком инструментов (DESIGN § 6.1).
 * @param tools Инструменты для внедрения.
 * @param toolChoice Политика выбора.
 */
const buildDsmlInstruction = (tools: readonly OpenAiTool[], toolChoice: ToolChoice): string => {
  const toolsBlock = tools.map(renderToolDescription).join('\n');
  return `Ты — ассистент. Если тебе нужно вызвать инструмент, ответь СТРОГО в формате DSML:

${DSML_CALLS_OPEN}
  <｜DSML｜invoke name="TOOL_NAME">
    <｜DSML｜parameter name="PARAM_NAME" string="true">PARAM_VALUE</｜DSML｜parameter>
  </｜DSML｜invoke>
${DSML_CALLS_CLOSE}

Если вызов не нужен — отвечай обычным текстом, без DSML.

Доступные инструменты:
${toolsBlock}${buildToolRequirement(toolChoice)}

Важно: после получения результата инструмента (сообщение с ролью tool)
ОБЯЗАТЕЛЬНО ответь пользователю текстом, подтверждающим выполнение.
Не оставляй ответ пустым.

Важно: если для задачи нет специализированного инструмента (например,
управления мышью, работы с буфером обмена, скриншотов), но доступен
\`bash\` — используй \`bash\` для запуска соответствующего скрипта (Python,
PowerShell и т.д.). Не отвечай текстом "я проверю доступные инструменты" —
сразу вызывай \`bash\`.

Пример: если пользователь просит «поводи мышью», а специализированного
инструмента нет, но есть \`bash\`, ответь так:

${DSML_CALLS_OPEN}
  <｜DSML｜invoke name="bash">
    <｜DSML｜parameter name="command" string="true">python -c "import pyautogui; [pyautogui.moveTo(100, 100)]"</｜DSML｜parameter>
  </｜DSML｜invoke>
${DSML_CALLS_CLOSE}

Важно: если результат инструмента — это файл (изображение, документ, архив),
ответь текстом с путём к сохранённому файлу (например, «Файл сохранён:
C:\\path\\to\\file.png»). Не пытайся вставить файл в чат или описать его
содержимое, если у тебя нет возможности его увидеть.`;
};

/**
 * Превращает OpenAI-запрос (`messages` + `tools`) в один prompt для DeepSeek.
 *
 * `system`-сообщения сливаются с DSML-инструкцией в один блок `[SYSTEM]` в
 * начале prompt'а: DeepSeek Web принимает только одну строку `prompt`, а
 * инструкция должна иметь приоритет над историей. `toolChoice: 'none'`
 * отключает внедрение инструментов; `'required'`/конкретная функция
 * добавляют требование обязательно вызвать инструмент.
 *
 * @param options Сообщения, инструменты и политика выбора.
 * @returns Prompt и имена внедрённых инструментов.
 * @throws PromptValidationError если `messages` пуст или `toolChoice`
 * несовместим с `tools`.
 */
export const buildPromptAsync = (options: BuildPromptOptions): BuildPromptResult => {
  const { messages, tools, toolChoice } = options;
  if (messages.length === 0) {
    throw new PromptValidationError('messages пуст: Prompt Builder требует хотя бы одно сообщение');
  }

  const hasTools = tools !== undefined && tools.length > 0;
  const requiresTools = toolChoice === 'required' || typeof toolChoice === 'object';
  if (requiresTools && !hasTools) {
    throw new PromptValidationError('toolChoice требует непустой список tools');
  }
  if (typeof toolChoice === 'object') {
    const requestedName = toolChoice.function.name;
    const exists =
      tools !== undefined && tools.some((tool) => tool.function.name === requestedName);
    if (!exists) {
      throw new PromptValidationError(
        `toolChoice указывает на неизвестный инструмент: ${requestedName}`,
      );
    }
  }

  const injectTools = hasTools && toolChoice !== 'none';
  const toolsInjected = injectTools && tools !== undefined ? tools.map((tool) => tool.function.name) : [];
  const dsmlInstruction =
    injectTools && tools !== undefined
      ? buildDsmlInstruction(tools, toolChoice ?? 'auto')
      : undefined;

  /** Блоки системной части: сначала system-сообщения, затем DSML-инструкция. */
  const systemContents: string[] = [];
  for (const message of messages) {
    if (message.role !== 'system') {
      continue;
    }
    const content = message.content ?? '';
    if (content !== '') {
      systemContents.push(content);
    }
  }
  if (dsmlInstruction !== undefined) {
    systemContents.push(dsmlInstruction);
  }

  const blocks: string[] = [];
  if (systemContents.length > 0) {
    blocks.push(`[SYSTEM]\n${systemContents.join('\n\n')}`);
  }

  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'user') {
      blocks.push(`[USER]\n${message.content ?? ''}`);
      continue;
    }
    if (message.role === 'tool') {
      blocks.push(`[TOOL_RESULT id=${message.tool_call_id ?? 'unknown'}]\n${message.content ?? ''}`);
      continue;
    }

    const content = message.content ?? '';
    const calls = message.tool_calls ?? [];
    if (calls.length > 0) {
      const parts: string[] = [];
      if (content !== '') {
        parts.push(content);
      }
      parts.push(renderToolCallsBlock(calls));
      blocks.push(`[ASSISTANT]\n${parts.join('\n\n')}`);
      continue;
    }
    blocks.push(`[ASSISTANT]\n${content}`);
  }

  return { prompt: blocks.join('\n\n'), toolsInjected };
};
