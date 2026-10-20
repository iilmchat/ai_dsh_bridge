# Правила разработки AI DSH Bridge

**Версия правил:** 1.0.0
**Дата:** 2026-10-19
**Статус:** Действуют для всех изменений в репозитории `ai-dsh-bridge`.
**Связанные документы:** [DESIGN.md](DESIGN.md) — авторитетный дизайн,
[api-contract.json](api-contract.json) — контракт JSON/SSE,
[KNOWN_ISSUES.md](KNOWN_ISSUES.md) — реестр проблем,
[CHANGELOG.md](CHANGELOG.md) — история изменений.

Правила обязательны и для людей, и для AI-ассистентов. Если правило
приходится нарушить, это оформляется отдельным KI (см. § 2.2) с указанием
причины и срока исправления. Молчаливые исключения запрещены.

---

## 1. Базовые правила

### 1.1. JSDoc на русском языке

Публичные (экспортируемые) функции, классы, интерфейсы и нетривиальные
константы обязаны иметь JSDoc на русском. Английские технические термины
(`Bearer`, `SSE`, `PoW`) не переводятся. Комментарии должны объяснять
**зачем**, а не пересказывать код.

```ts
/**
 * Загружает и валидирует сохранённую сессию DeepSeek из auth.json.
 *
 * @param authFilePath Абсолютный путь к auth.json; файл лежит вне репозитория.
 * @returns Токен, cookie и `ds_session_id`, прошедшие Zod-валидацию.
 * @throws {AuthFileError} Если файл не читается или не соответствует схеме.
 */
export async function loadAuthAsync(authFilePath: string): Promise<AuthSession> {
  // ...
}
```

Внутренние однострочные пояснения — допустимы построчно (`//`), но не
заменяют JSDoc у экспортируемого API.

### 1.2. Суффикс `Async` у асинхронных I/O-функций

Любая функция, которая возвращает `Promise` и выполняет I/O (сеть, файлы,
CDP, таймеры), называется с суффиксом `Async`: `loadAuthAsync`,
`validateSessionAsync`, `solvePowAsync`, `requestCompletionAsync`,
`writeDebugArtifactAsync`. Чистые (синхронные) преобразования суффикса не
имеют: `buildPrompt`, `parseDsml`, `toSseChunk`, `normalizeDsml`.

Правило помогает визуально отличать «горячий» путь парсера от мест, где
возможны таймауты и отмена.

### 1.3. Строгий TypeScript не ослабляется

`tsconfig.json` включает `strict: true`, а также
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `verbatimModuleSyntax`. Эти флаги **не отключаются**
и не «обходятся» точечно без отдельного KI и обоснования. Понижение
строгости ради «чтобы собралось» — дефект, а не решение.

### 1.4. `any` запрещён; недоверенные данные — `unknown`

`any` запрещён в `src/` и `test/`. Для внешних данных используется
`unknown` с последующим сужением: Zod-схема, type guard, проверка полей.
Приведение типов (`as`) допустимо только после runtime-проверки, двойное
приведение (`as unknown as T`) — только в тестовых фикстурах.

```ts
// Плохо: any «протекает» из JSON.parse и отключает проверки.
const data = JSON.parse(text);
data.choices[0].message.tool_calls;

// Хорошо: unknown + type guard/narrowing.
const raw: unknown = JSON.parse(text);
if (!isRecord(raw) || !Array.isArray(raw.choices)) {
  throw new BridgeParseError('Ответ DeepSeek не содержит choices[]');
}
```

`@ts-ignore` и `@ts-expect-error` допустимы лишь с комментарием-причиной и
ссылкой на KI; «голый» `@ts-ignore` отклоняется на ревью.

### 1.5. Zod на всех границах

Все данные, приходящие извне процесса, проходят runtime-валидацию Zod.
Типы выводятся из схем (`z.infer`), а не дублируются вручную. Обязательные
границы:

| Граница | Где валидируется | Пример схемы |
|---|---|---|
| Переменные окружения | `src/config.ts` | `EnvSchema` |
| HTTP-запрос DSH | `POST /v1/chat/completions` | `chatCompletionRequestSchema` |
| `auth.json` | `src/auth/session.ts` | `authFileSchema` (strict) |
| Ответы DeepSeek (JSON) | `src/deepseek/client.ts` | `deepseekCompletionSchema` |
| PoW challenge | `src/deepseek/pow.ts` | `powChallengeSchema` |
| События/чанки SSE (обратная сборка) | `src/translate/sse.ts`, тесты | `chatCompletionChunkSchema` |

```ts
import { z } from 'zod';

// Все значения окружения — строки; число/булево приводится на границе.
const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3456),
  DEBUG: z.enum(['0', '1']).default('0'),
  DEBUG_DIR: z.string().min(1).default('~/.ai-dsh-bridge/debug'),
  DEEPSEEK_BASE_URL: z.url().default('https://chat.deepseek.com'),
  AUTH_FILE: z.string().min(1).default('~/.ai-dsh-bridge/auth.json'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

const env = EnvSchema.parse(process.env); // ZodError на некорректном окружении — падение на старте
export const config = { ...env, debug: env.DEBUG === '1' };
```

Нюансы:

- `auth.json` — `z.strictObject`: лишние поля означают рассинхрон версий,
  это ошибка, а не «шум».
- Тело запроса от DSH — обычный `z.object` (лишние ключи отбрасываются,
  чтобы не ломаться на новых полях OpenAI-совместимого клиента); при этом
  обязательные поля (`model`, `messages`, `stream`) проверяются строго.
- Ответы DeepSeek — валидируются только используемые поля; незнакомые
  поля не должны ронять парсинг (совместимость с изменениями API).
- Результат `JSON.parse` типизируется как `unknown`; распаковка — через
  `.safeParse()`.

### 1.6. Ошибки типизированы и не глотаются

- Не бросать строки: только наследники `Error` с машинным `code`.
- Ошибки внешних слоёв заворачиваются с контекстом (этап, URL-путь,
  `requestId`), но без секретов (см. § 5).
- `catch {}` без логирования и без пере-броса запрещён.
- Сообщения для клиента — безопасные и короткие; детали — в лог/debug.
- 401/403 от DeepSeek после неудачного refresh токена → 401 клиенту с
  текстом «Re-run webauth» (DESIGN § 8.1).

---

## 2. Документация

### 2.1. CHANGELOG в том же коммите

Любое изменение поведения, API или конфигурации отражается в
`docs/CHANGELOG.md` **тем же коммитом** в формате Keep a Changelog
(разделы `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`).
Незавершённые изменения — в `[Unreleased]`. Запись без CHANGELOG — повод
вернуть PR.

### 2.2. KI-XXX для любой проблемы

Найденная проблема (баг, ограничение, технический долг, отсутствующая
реализация) фиксируется в `docs/KNOWN_ISSUES.md` записью `KI-XXX` с
приоритетом, статусом, затронутыми файлами и планом. Номера не
переиспользуются; пропуски в нумерации допустимы. «Починю потом» без KI
не существует: либо KI, либо исправление сейчас.

### 2.3. DESIGN — для крупных фич

Крупная фича (новый слой, изменение контракта SSE, новый транспорт,
изменение формата промпта) сначала описывается в `docs/DESIGN.md`
(раздел и/или таблица этапов § 10), затем реализуется. Мелкие правки
(сообщение об ошибке, рефакторинг внутри модуля) изменения DESIGN не требуют.
Решения, меняющие договорённости, отмечаются ссылкой вида
`DESIGN § 5.3` в CHANGELOG и описании коммита.

### 2.4. Закрытие KI — точечный diff

PR/коммит, закрывающий KI, содержит **только** исправление и необходимые
тесты/документацию. Попутный рефакторинг, переформатирование и
«улучшения заодно» выносятся отдельно: иначе невозможно ни ревью, ни
откат. При закрытии: статус KI → `Fixed`, ссылка на коммит, запись в
CHANGELOG, при необходимости — regression-тест в `test/`.

### 2.5. Актуальность документации

При изменении статуса проекта обновляются: `README.md`,
`docs/GETTING_STARTED.md`, `docs/PROMPT_CURRENT.md` (метрики, список KI),
`docs/RELEASES.md` — перед релизом. Документ, описывающий несуществующее
поведение, считается дефектом.

### 2.6. Ссылки вместо пересказа

Вместо копирования разделов DESIGN — ссылка на него (`DESIGN § 5.3`).
Единственный источник истины для ID/полей JSON/SSE —
`docs/api-contract.json`; при расхождении правится контракт, затем код и
тесты.

---

## 3. Workflow

### 3.1. Один шаг — один коммит

Шаг — это логически завершённое изменение: «парсер разбирает
закрытый `invoke`» или «сессия обновляет токен по cookie». Этапы DESIGN
(§ 10) дробятся на шаги; смешивать несколько шагов в коммите запрещено.
WIP-коммиты допустимы только в личной ветке и не попадают в `main`
без squash.

### 3.2. Definition of Done

Перед коммитом в `main` обязательны все проверки:

```bash
pnpm typecheck   # tsc -p tsconfig.json --noEmit, ошибок нет
pnpm lint        # oxlint --type-aware src/ test/, замечаний нет
pnpm test        # vitest run, все тесты зелёные
pnpm build       # tsc -p tsconfig.build.json, 0 warnings
```

- `pnpm build` с **ноль warnings**; любое предупреждение TypeScript —
  блокер.
- `pnpm test` не имеет права быть «зелёным» за счёт `.skip`/`.todo` без
  KI; `passWithNoTests` — временная настройка каркаса, а не норма.
- Ручная smoke-проверка: `GET /health`, `GET /v1/models`, затем целевой
  сценарий этапа (DESIGN § 7.1).

### 3.3. Порядок проверок

`typecheck → lint → test → build`. Коммит, собранный «на глазок», не
считается завершённым: проверки запускает автор изменения, а не ревьюер.

### 3.4. Зависимости и окружение

- Только `pnpm` (`pnpm install`, `pnpm add`); `npm`/`yarn` запрещены,
  `pnpm-lock.yaml` коммитится вместе с изменением `package.json`.
- Node.js 22+; используются штатные API (`fetch`, `AbortSignal.timeout`,
  `node:crypto`, `node:fs/promises`). Полифиллы не добавляются.
- Добавление зависимости — отдельный коммит `chore(deps): ...` с
  обоснованием и проверкой лицензии (DESIGN § 4.2: MIT/Apache для
  PoW-порта).
- `.env`, `auth.json`, `dist/`, `node_modules/`, `*.log` — вне
  репозитория (см. `.gitignore`).

### 3.5. Ветки и интеграция

Ветка: `feat/KI-XXX-краткое-имя` или `fix/KI-XXX-краткое-имя`. В `main`
попадают только зелёные проверки § 3.2; hotfix — тем же путём, без
прямых push-обходов.

---

## 4. TypeScript / ESM

### 4.1. Расширение `.js` в относительных импортах

Проект — ESM (`"type": "module"`) с `module: "NodeNext"`: в относительных
импортах всегда указывается `.js`, даже если исходник `.ts`. Это касается
и тестов.

```ts
// Плохо — NodeNext не разрешит импорт.
import { parseDsml } from './dsml-parser';

// Хорошо.
import { parseDsml } from './dsml-parser.js';
import { loadAuthAsync } from '../auth/session.js';
```

### 4.2. `import type` и `verbatimModuleSyntax`

Типы импортируются/экспортируются только через `import type` /
`export type`, иначе `verbatimModuleSyntax` сохранит импорт в JS, где
соответствующих значений нет, — ошибка во время выполнения.

```ts
import type { ChatCompletionRequest, ToolCallDelta } from '../api/types.js';
import { buildPrompt } from '../translate/prompt.js';
```

### 4.3. Встроенные модули — через `node:`

```ts
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
```

### 4.4. AbortController и таймаут для каждого внешнего вызова

Запросы к DeepSeek, PoW-challenge и CDP выполняются с отменой и таймаутом;
«вечных» `fetch` без сигнала в проекте нет. Таймер очищается в `finally`.

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new BridgeTimeoutError('DeepSeek timeout')), 15_000);

try {
  const response = await fetch(`${baseUrl}/api/v0/chat/completion`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  if (!response.ok) throw new DeepSeekHttpError(response.status);
  return await response.text();
} finally {
  clearTimeout(timer);
}
```

Для комбинирования сигналов клиента и таймаута допускается
`AbortSignal.any([requestSignal, AbortSignal.timeout(ms)])` (Node 22);
явный `clearTimeout` предпочтителен, когда таймаут общий для нескольких
операций.

### 4.5. `Promise.allSettled` для независимых операций

Если операции независимы, но нужен отчёт о каждой (очистка ресурсов,
параллельная запись debug-артефактов, остановка нескольких клиентов) —
`Promise.allSettled`. `Promise.all` — только там, где любой отказ должен
прервать всю группу и частичный результат бессмысленен.

```ts
const results = await Promise.allSettled([
  cdpClient.closeAsync(),
  shutdownServerAsync(),
  writeDebugArtifactAsync(debugDir, 'shutdown.json', snapshot),
]);
for (const result of results) {
  if (result.status === 'rejected') {
    logger.warn({ err: result.reason }, 'Операция при остановке завершилась ошибкой');
  }
}
```

### 4.6. `noUncheckedIndexedAccess`

Индексный доступ возвращает `T | undefined`; проверка обязательна,
иначе компилятор (и ревью) не пропустит.

```ts
const chunks: DsmlChunk[] = parseDsml(text);
const first = chunks[0];
if (first === undefined) return; // пустой поток — валидный случай
useChunk(first);
```

### 4.7. `exactOptionalPropertyTypes`: поля опускаются, а не зануляются

Опциональное поле нельзя заполнить `undefined`. Для JSON это особенно
важно: в SSE-чанках отсутствие поля — часть контракта (см. § 7.1), а
`"id": null` ломает DSH. Собирайте объект только из присутствующих
полей; `JSON.stringify` не должен быть единственной защитой.

```ts
interface ToolCallFunctionDelta {
  arguments?: string;
  name?: string;
}

interface ToolCallDelta {
  function?: ToolCallFunctionDelta;
  id?: string;
  index: number;
  type?: 'function';
}

// Продолжение: только index и фрагмент аргументов. Никаких id/name/undefined.
const continuation: ToolCallDelta = { index, function: { arguments: fragment } };
```

### 4.8. Прочие соглашения

- Именованные экспорты; `export default` не используется.
- `readonly` для конфигураций и массивов, которые не должны меняться.
- `satisfies` для констант-справочников (список моделей, заголовки) —
  сохраняет литеральные типы.
- Публичный API модуля — минимум; внутренние типы не экспортируются.
- Никакой логики в `index.ts` сверх сборки приложения и запуска сервера.

---

## 5. Безопасность

### 5.1. Секреты — только `.env` и `auth.json`

Bearer-токен DeepSeek, cookie, `ds_session_id` и прочие учётные данные
хранятся исключительно в `~/.ai-dsh-bridge/auth.json` (путь задаётся
`AUTH_FILE`) и в локальном `.env`. Оба файла в `.gitignore`; в
репозитории допустим только `.env.example` с плейсхолдерами. `auth.json`
**всегда вне репозитория**: не копируется в `test/fixtures`, не
прикладывается к issue, не передаётся через переменные CI.

На POSIX `auth.json` создаётся с правами `0600`; на Windows доступ
ограничивается текущим пользователем. В логах и сообщениях об ошибках
секретов нет — даже в усечённом виде.

### 5.2. Промпты не логируются целиком

Полный текст промпта может содержать пользовательские данные и
результаты инструментов. В лог разрешено писать только метрики:

- количество сообщений и инструментов;
- суммарную длину в символах;
- SHA-256 хэш (первые 12 hex-символов) для корреляции запросов;
- `requestId` и модель.

```ts
function describePromptForLog(messages: readonly ChatMessage[]): Record<string, unknown> {
  const text = messages.map((m) => m.content ?? '').join('\n');
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return { messages: messages.length, chars: text.length, sha256_12: digest };
}
```

### 5.3. Токены, cookie и заголовки — не логируются

`Authorization`, `Cookie`, `x-ds-pow-response`, `ds_session_id` не
попадают ни в `stdout`, ни в `pino`, ни в стек ошибок. Логгер настраивается
с redaction (`authorization`, `cookie`, `set-cookie`, `x-ds-pow-response`).
PoW-ответ и cookies не выводятся даже частично — только факт «получен/не
получен».

### 5.4. «Сырые» ответы DeepSeek — только debug-каталог и только DEBUG=1

Необработанные тела ответов DeepSeek (HTML/JSON/SSE) пишутся только в
`~/.ai-dsh-bridge/debug/` (переменная `DEBUG_DIR`), и только при
`DEBUG=1`. Путь по умолчанию — вне репозитория; конфигурация обязана
отклонять `DEBUG_DIR` внутри рабочей копии. `DEBUG=0` —
значение по умолчанию. Debug-файлы никогда не коммитятся и не
прикладываются к задачам; перед коммитом проверяется `git status`.

Имя файла: `YYYYMMDD-HHmmss-<requestId>-<kind>.json`. В артефактах нет
заголовков авторизации; cookie вырезаются.

### 5.5. Ошибки наружу — без внутренних деталей

Клиенту возвращается безопасное сообщение и код; стек, URL с токеном,
сырое тело DeepSeek — только в лог уровня `debug`/`error` без секретов и,
при необходимости, в debug-артефакт (§ 5.4). Запрещено возвращать
DSH содержимое `auth.json` или заголовков.

### 5.6. Зависимости и лицензии

Новые зависимости добавляются с обоснованием; для заимствованного кода
(PoW-решатель, DSML-нормализатор) проверяется совместимая лицензия
(MIT/Apache) и фиксируется источник в CHANGELOG. Копирование кода без
указания источника и лицензии запрещено.

---

## 6. Git

### 6.1. Типы коммитов

Используется Conventional Commits со следующими типами:

| Тип | Назначение |
|---|---|
| `feat` | Новая функциональность |
| `fix` | Исправление дефекта |
| `docs` | Только документация |
| `test` | Тесты и фикстуры |
| `chore` | Сборка, зависимости, служебные файлы |
| `refactor` | Изменение структуры без изменения поведения |
| `security` | Исправление уязвимости/утечки секретов |
| `perf` | Оптимизация производительности |

Формат: `<type>(<scope>): <краткое описание>` — императив, до 72 символов.
Scope: `api`, `auth`, `deepseek`, `translate`, `sse`, `pow`, `config`,
`deps`, `docs`. Тело — «почему» и «как», ссылки на KI и DESIGN.

```text
fix(sse): не дублировать id/name в continuation-чанках

DSH перезаписывает идентичность вызова при наличии полей, даже пустых,
из-за чего возникал UNKNOWN_TOOL. Поля id/name/type теперь эмитируются
только в первом чанке для каждого index.

Refs: KI-006, DESIGN § 5.3
```

### 6.2. Нейтральный автор

Коммиты и код не содержат персональных атрибуций, упоминаний AI-ассистента
и «подписей» в трейлерах. Автор — нейтральная проектная идентичность;
глобальный `git config user.*` не меняется без необходимости. Секреты,
абсолютные пути разработчика и локальные настройки в коммиты не попадают.

### 6.3. `--force-with-lease` — только по согласованию

Переписывание опубликованной истории допускается только по явному
согласованию с владельцем ветки и только `--force-with-lease`. `git push
--force` в `main` запрещён. Откат уже опубликованного изменения —
`git revert`, а не переписывание истории.

### 6.4. Гигиена коммитов

Один коммит — одна задача/KI. Не коммитятся `node_modules/`, `dist/`,
`.env`, `auth.json`, `*.log`, debug-артефакты. Сгенерированные файлы —
только если это часть контракта (например, обновлённый
`docs/api-contract.json`).

---

## 7. Специфика AI DSH Bridge

### 7.1. Контракт SSE: `id`/`name` только в первом чанке

Для каждого `index` вызова инструмента поля `id`, `type` и
`function.name` отправляются DSH **ровно один раз** — в первом чанке.
Во всех последующих чанках эти поля **отсутствуют** (не `""` и не
`null`). Причина: DSH проверяет `!== undefined` и при пустом/`null`
значении перезаписывает корректную идентичность вызова, что приводит к
`UNKNOWN_TOOL` (DESIGN § 5.3, § 11).

Корректный поток:

```text
// Чанк 1: идентичность + начало аргументов
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"bash","arguments":""}}]}}]}

// Чанк 2: только фрагмент аргументов (id и name ОТСУТСТВУЮТ)
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]}}]}

// Чанк 3: продолжение аргументов
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls -la\"}"}}]}}]}

// Чанк 4: завершение
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
```

Обязательные инварианты:

1. `index` присутствует в каждом чанке `tool_calls` и не меняется.
2. `id`, `type`, `function.name` — только в первом чанке данного `index`.
3. Пустые `""`/`null` для `id` и `name` запрещены в любых чанках.
4. `function.arguments` — строка; пустая строка допустима только в первом
   чанке (начало накопления). Continuation-чанк без непустого фрагмента
   не отправляется.
5. Если у вызова нет аргументов, в первом чанке передаётся `"{}"`, а не
   пустая строка.
6. Для нескольких вызовов — отдельный `index` и собственный первый чанк
   для каждого; порядок идентичностей не переиспользуется.

Эти инварианты должны быть закреплены тестом `test/sse-tool-calls.test.ts`,
который появится вместе с SseWriter на Этапе 6 (KI-006, KI-007): сначала
обновляются `docs/api-contract.json` и тест, затем код. До появления теста
контракт считается зафиксированным документально и не может считаться
проверенным автоматически.

### 7.2. Неполный DSML в конце потока — fail-safe

Если к завершению потока параметры вызова не закрыты/невалидны, вызов
**не выполняется**. Возвращается `finish_reason: "stop"`, диагностический
текст — в `content`; `tool_calls` в ответе отсутствуют.

```json
{
  "id": "chatcmpl-7f1c",
  "object": "chat.completion",
  "created": 1760900000,
  "model": "deepseek-web-chat",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "DSML parse error: аргументы вызова bash не завершены — вызов не выполнен. Повторите запрос."
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

В streaming-режиме то же правило: вместо чанков `tool_calls` клиент
получает `delta.content` с текстом ошибки и завершающий чанк с
`finish_reason: "stop"`. Частично собранный вызов отбрасывается целиком —
никогда не отдаём DSH «полувызов».

Смежные правила (DESIGN § 8.1–8.2):

- Неизвестный инструмент в DSML — `tool_calls` возвращаются как есть;
  DSH сам сформирует `UNKNOWN_TOOL` и передаст модели обратную связь.
- Пустой `invoke` (нет параметров) — вызов игнорируется, парсинг
  продолжается.
- Модель ответила обычным текстом без DSML — текст возвращается как
  `content`, `tool_calls` не синтезируются.
- `finish_reason: "tool_calls"` ставится только если есть хотя бы один
  полностью собранный и валидный вызов.

### 7.3. Нормализация DSML обязательна до парсинга

Перед разбором выполняется нормализация (DESIGN § 5.2): двойные
pipe-маркеры (`<｜｜DSML｜｜...>`), пробельные варианты структурных слов,
неявный `tool_calls` wrapper при `invoke` на верхнем уровне. Каждый новый
edge case из реального потока добавляется в нормализатор **вместе с
тестом** и записью KI/CHANGELOG. Экранирование маркеров внутри значений
параметров учитывается парсером; при сомнении — отказ от выполнения
(§ 7.2).

### 7.4. PoW: одноразовость и повторы

Challenge `DeepSeekHashV1` одноразовый и не кэшируется (DESIGN § 4.2).
PoW-ответ формируется под конкретный запрос и не переиспользуется.
При неудаче — до 3 попыток с новым challenge (DESIGN § 8.1); каждая
попытка логируется без содержимого challenge/ответа.

### 7.5. Debug только локально и только при DEBUG=1

Сырые ответы DeepSeek и полные дампы запросов — исключительно
`~/.ai-dsh-bridge/debug/` при `DEBUG=1` (§ 5.4). Они никогда не попадают
в git и в issue; в тестах используются только синтетические фикстуры с
фиктивными токенами.

### 7.6. `auth.json` вне репозитория

Путь по умолчанию — `~/.ai-dsh-bridge/auth.json`; файл создаёт `webauth`
(DESIGN § 3.1). В репозитории нет ни `auth.json`, ни его копий; тесты,
проверяющие загрузку сессии, используют временный каталог и фикстуру с
заведомо недействительными значениями.

### 7.7. Контракт — источник истины

`docs/api-contract.json` фиксирует поля `ChatCompletionResponse`
(`choices`, `created`, `id`, `model`, `object`, `usage`), вложенных
объектов (`Choice`, `Message`, `ToolCall`, `Function`, `Usage`), а также
состав SSE-чанка `chat.completion.chunk` и его `delta`. Изменение любого
поля — это изменение контракта: обновляются контракт, реализация и тест
в одном коммите. Расхождение «код ведёт себя иначе, чем контракт»
трактуется как дефект.

---

## 8. История изменений правил

| Версия | Дата | Изменение |
|---|---|---|
| 1.0.0 | 2026-10-19 | Initial: базовые правила, документация, workflow, TypeScript/ESM, безопасность, Git, специфика AI DSH Bridge |

Правила изменяются отдельным коммитом `docs(rules): ...` с обоснованием
и записью в этой таблице. Ужесточение правил — minor-версия; изменение,
требующее переработки существующего кода, — major-версия.
