# AI DSH Bridge — руководство по началу работы

**Версия:** 0.5.0 (scaffold)
**Дата:** 2026-10-19
**Связанные документы:** [DESIGN.md](./DESIGN.md), [ARCHITECTURE.md](./ARCHITECTURE.md), [RULES.md](./RULES.md), [KNOWN_ISSUES.md](./KNOWN_ISSUES.md)

> **Что уже работает в v0.5.0.** `GET /health`, `GET /v1/models`,
> `pnpm webauth`, клиент DeepSeek с PoW, Prompt Builder, DSML-парсер и
> `POST /v1/chat/completions` в обоих режимах: `stream: false` (JSON) и
> `stream: true` (OpenAI SSE с `tool_calls`).

---

## 0. Матрица готовности шагов

| Шаг руководства | Что проверяет | Статус в v0.5.0 |
|---|---|---|
| §1–2. Требования и установка | Node.js 22+, pnpm, зависимости | ✅ доступно |
| §4. Запуск каркаса | `pnpm dev`, `/health`, `/v1/models` | ✅ доступно |
| §3. Аутентификация | `pnpm webauth`, `~/.ai-dsh-bridge/auth.json` | ✅ доступно (0.2.0) |
| §5. Настройка DSH | Custom Provider в DSH | ⚠️ список моделей доступен; ответы — после подключения `/v1/chat/completions` |
| §6.1. Простой чат | `content`-стриминг реального ответа | ⏳ после подключения L2/L3 к фасаду (KI-002) |
| §6.2. Tool-call цикл | `tool_calls` → `bash` → `role: tool` | ⏳ после этапов 4–7 |
| §7. Troubleshooting | Диагностика типовых ошибок | ✅/⚠️ по мере готовности |
| §4.5. Живой e2e DeepSeek | `pnpm e2e:deepseek` | ⏳ запускает пользователь (нужен `auth.json`) |
| §4.6. DSML с tools | `pnpm e2e:tools [--prompt-only]` | ⏳ запускает пользователь; `--prompt-only` — без сети |
| §10. Захват запросов DeepSeek | Инструкция для Этапа 0 | ✅ захваты 2026-10-19 в `docs/captures/` |

---

## 1. Требования

| Компонент | Минимум | Проверка | Примечание |
|---|---|---|---|
| Node.js | 22.0.0 (`engines` в `package.json`) | `node -v` | Нужен `fetch`, `AbortSignal`, ESM |
| pnpm | 9.x | `pnpm -v` | Проект использует `pnpm-lock.yaml` |
| Chrome / Chromium | Актуальный стабильный | `chrome://version` | Нужен только для `pnpm webauth` |
| DeepSeek-аккаунт | Действующий | — | Вход выполняется вручную в браузере |
| Свободные порты | `3456`, `9222` | см. §7 | `3456` — шлюз, `9222` — CDP при `webauth` |
| ОС | Windows 10/11, macOS, Linux | — | Команды ниже даны для PowerShell и bash |

Дополнительно: для клонирования репозитория нужен Git; для работы шлюза
интернет требуется только на этапе обращений к `chat.deepseek.com`.

---

## 2. Установка

```powershell
git clone <url-репозитория> "$HOME\ai_dsh_bridge"
cd "$HOME\ai_dsh_bridge"
pnpm install
```

```bash
git clone <url-репозитория> ai_dsh_bridge
cd ai_dsh_bridge
pnpm install
```

Проверка типов (необязательно, но полезно при первом запуске):

```powershell
pnpm typecheck
```

Файл `.env.example` — справочник рекомендуемых значений переменных
окружения. `.env` и `auth.json` перечислены в `.gitignore` и не должны
попадать в репозиторий.

> **Важно (v0.1.2).** `.env` опционален: скрипты `pnpm dev`, `pnpm start` и
> `pnpm webauth` запускаются с `--env-file-if-exists=.env`, поэтому без
> файла применяются значения по умолчанию из `src/config.ts` (§8).
> Скопируйте `.env.example` → `.env` (`Copy-Item .env.example .env`; bash:
> `cp .env.example .env`), если нужны нестандартные порт/пути. Переменные
> оболочки имеют приоритет над `.env`.

---

## 3. Аутентификация (`webauth`)

> ✅ **Доступно с v0.2.0.** `pnpm webauth` запускает Chrome с CDP :9222
> (или подключается к уже запущенному), ждёт входа и сохраняет
> `~/.ai-dsh-bridge/auth.json` с правами 0600. Таймаут — 5 минут.

`webauth` — одноразовый захват браузерной сессии DeepSeek:

1. Запустите `pnpm webauth`.
2. Скрипт запускает Chrome с `--remote-debugging-port=9222` (если браузер
   ещё не запущен) и открывает `https://chat.deepseek.com`.
3. Войдите в аккаунт вручную и дождитесь, пока `webauth` зафиксирует сессию
   (следуйте подсказкам в консоли).
4. Скрипт сохраняет данные в `~/.ai-dsh-bridge/auth.json` (путь можно
   изменить через `AUTH_FILE`).

**Что сохраняется** (ожидаемая структура; точный набор полей фиксируется
`authFileSchema` на этапе 2):

```json
{
  "token": "<Bearer-токен DeepSeek>",
  "ds_session_id": "<идентификатор сессии из cookie>",
  "cookies": "<cookie-строка для upstream-запросов>",
  "savedAt": "2026-10-19T13:00:00.000Z"
}
```

Правила хранения:

- файл лежит **вне репозитория** — в `~/.ai-dsh-bridge/`;
- на POSIX права `0600`, на Windows доступ ограничен текущим пользователем;
- `auth.json` нельзя копировать в `test/fixtures`, прикладывать к issue или
  логировать;
- токен и cookie не выводятся в логи даже частично (RULES §5.3);
- при истечении сессии повторите `pnpm webauth`.

> **Безопасность.** Использование веб-интерфейса в обход официального API
> может нарушать условия DeepSeek. Рекомендуется отдельный аккаунт; проект
> не гарантирует сохранность аккаунта (DESIGN §11).

---

## 4. Запуск и проверка каркаса

### 4.1. Запуск dev-сервера

```powershell
pnpm dev
```

Ожидаемый вывод (Fastify/pino; значения `time`, `pid`, `hostname`
различаются):

```text
{"level":30,"time":1760886000000,"pid":12345,"hostname":"dev","msg":"Server listening at http://127.0.0.1:3456"}
{"level":30,"time":1760886000100,"pid":12345,"hostname":"dev","msg":"AI DSH Bridge v0.5.0 listening on http://127.0.0.1:3456"}
```

Сервер слушает **только loopback** (`127.0.0.1`). Порт берётся из `PORT`
(`.env` или окружение), по умолчанию `3456`. Остановка — `Ctrl+C`
(реализован graceful shutdown по `SIGINT`/`SIGTERM`).

> **Порт 3456 занят?** Задайте другой порт в `.env` (`PORT=3457`) или в
> оболочке: `$env:PORT = '3457'; pnpm dev` (bash: `PORT=3457 pnpm dev`).
> Тогда в DSH укажите `openaiURL: http://localhost:3457/v1/chat/completions`
> (§5.1). Не занимайте чужой порт и не останавливайте чужие процессы.

### 4.2. Проверка `GET /health`

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:3456/health' | ConvertTo-Json -Depth 4
```

```bash
curl -s http://127.0.0.1:3456/health
```

Ожидаемый ответ:

```json
{
  "status": "ok",
  "version": "0.5.0",
  "uptime_sec": 12
}
```

### 4.3. Проверка `GET /v1/models`

```powershell
(Invoke-RestMethod -Uri 'http://127.0.0.1:3456/v1/models').data |
  Format-Table id, object, owned_by
```

```bash
curl -s http://127.0.0.1:3456/v1/models
```

Ожидаемый ответ:

```json
{
  "object": "list",
  "data": [
    { "id": "deepseek-web-chat", "object": "model", "created": 0, "owned_by": "deepseek-web" },
    { "id": "deepseek-web-reasoner", "object": "model", "created": 0, "owned_by": "deepseek-web" }
  ]
}
```

### 4.4. Проверка `POST /v1/chat/completions` (JSON и SSE)

В v0.5.0 работают оба режима — при наличии `auth.json` (иначе `401`).

Non-streaming (`stream: false`):

```powershell
$body = '{"model":"deepseek-web-chat","messages":[{"role":"user","content":"ping"}],"stream":false}'
curl.exe -s -i -X POST http://127.0.0.1:3456/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d $body
```

Ожидаемый статус — `HTTP/1.1 200 OK`, тело в формате OpenAI:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "…" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 42, "total_tokens": 42 }
}
```

При `tools` и DSML-ответе модели будет `finish_reason: "tool_calls"` и
`message.tool_calls[]`.

Streaming (`stream: true`):

```powershell
$body = '{"model":"deepseek-web-chat","messages":[{"role":"user","content":"ping"}],"stream":true}'
curl.exe -sN -X POST http://127.0.0.1:3456/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d $body
```

Ответ — `text/event-stream`: чанки `data: {"object":"chat.completion.chunk",...}`
с `delta.role`/`delta.content`, для инструментов — `delta.tool_calls`
(`id`/`name` только в первом чанке, далее только фрагменты `arguments`),
финальный `finish_reason` и `data: [DONE]`. DSH по умолчанию использует
именно этот режим.

### 4.5. Проверка подключения к DeepSeek (e2e)

После `pnpm webauth` запустите:

```powershell
pnpm e2e:deepseek
# для отладки (все события + заголовки): pnpm e2e:deepseek -- --verbose
```

Ожидание в консоли: `[8] E2E OK` и `[7] Assembled text: "..."` (например,
`"Привет! Чем могу помочь?"`). Лог пишется в
`docs/captures/e2e-<YYYY-MM-DD-HH-mm>.log` (секреты заменены на
`<REDACTED>`; файл исключён из git через `*.log`).

Если ошибка:

- `AuthNotFoundError` → выполните `pnpm webauth`.
- `AuthExpiredError` → сессия истекла, повторите `pnpm webauth`.
- `40301` → PoW не принят: сохраните `docs/captures/e2e-<date>.log` и
  пришлите разработчику.
- сеть/таймаут → проверьте интернет и `GET /health`; лог с ошибкой
  сохраняется автоматически.

### 4.6. Проверка DSML с tools

После `pnpm webauth` и `pnpm e2e:deepseek`:

```powershell
pnpm e2e:tools -- --verbose
# только prompt, без запроса к DeepSeek: pnpm e2e:tools -- --prompt-only
```

Скрипт выведет prompt (первые 2000 символов), ответ модели и извлечённые
`tool_calls` (если модель решила вызвать `bash`); `warnings` — если DSML
невалиден. Лог сохраняется в `docs/captures/e2e-tools-*.log` (секреты
редактируются, файл исключён из git через `*.log`).

> Это диагностический шаг: цель — увидеть, как модель генерирует DSML при
> наличии tools, а не готовый фасад.

---

## 5. Настройка DSH (Custom Provider)

> ⚠️ **Статус.** Провайдер и список моделей можно добавить уже сейчас
> (`GET /v1/models` работает). Шлюз поддерживает и `stream:false`, и
> `stream:true` (SSE с `tool_calls`, K2/0.5.0), поэтому DSH может
> использовать его как Custom Provider; сквозной tool-call цикл подтверждён
> живым e2e DSH (`bash` выполнен, результат возвращён в модель).

> Если шлюз запущен не на `3456` (см. §4.1), замените порт в `openaiURL`,
> например `http://localhost:3457/v1/chat/completions`.

### 5.1. Через Web UI DSH

1. Откройте DSH → **Settings → Models → Add Custom Provider**
   (в некоторых сборках — «Add a custom provider»).
2. Заполните поля:
   - **Provider** — `deepseek-web` (произвольное имя);
   - **Base URL / openaiURL** — `http://localhost:3456/v1/chat/completions`
     (именно полный URL эндпоинта, а не префикс `/v1` — DESIGN §7.2);
   - **API Key** — любая непустая строка, например `sk-dummy` (шлюз ключ
     не проверяет, аутентификация встроена в сессию DeepSeek);
   - **Model** — `deepseek-web-chat`; при необходимости добавьте
     `deepseek-web-reasoner`.
3. Нажмите **Fetch available models**, чтобы DSH обратился к
   `GET /v1/models`, либо добавьте модель вручную.
4. Сохраните провайдера и выберите `deepseek-web-chat` для сессии.

### 5.2. Через конфигурацию DSH

Если DSH настроен файлом `settings.yaml` (DESIGN §7.2):

```yaml
llm-pi-ai:
  providers:
    deepseek-web:
      flavor: custom
      openaiURL: http://localhost:3456/v1/chat/completions
      apiKeyEnv: DEEPSEEK_WEB_DUMMY  # любая непустая строка
      models:
        - deepseek-web-chat
        # - deepseek-web-reasoner
```

`apiKeyEnv` указывает на переменную окружения, из которой DSH берёт
«ключ». Она может содержать любую непустую строку (`sk-dummy`,
`DEEPSEEK_WEB_DUMMY=...`). Шлюз эту переменную не читает и не проверяет.

> **Если DSH не подключается к `localhost`.** Шлюз слушает `127.0.0.1`.
> На некоторых системах `localhost` сначала разрешается в IPv6 (`::1`).
> Если соединение отклоняется, укажите в настройке полный URL с `127.0.0.1`:
> `http://127.0.0.1:3456/v1/chat/completions`.

---

## 6. Проверка сквозного сценария

### 6.1. Простой чат

> ⏳ **После этапов 2–3** (аутентификация → клиент DeepSeek + PoW).

1. Убедитесь, что `pnpm webauth` уже выполнялся и сессия сохранена.
2. Запустите `pnpm dev` и убедитесь, что `/health` отвечает `ok`.
3. В DSH выберите модель `deepseek-web-chat` и отправьте сообщение,
   например: «Привет! Ответь одним предложением».
4. Ожидаемо: ответ приходит потоком (SSE), в конце — `finish_reason:
   "stop"` и `data: [DONE]`.

### 6.2. Tool-call цикл (`bash`)

> ⏳ **После этапов 4–7** (DSML-инъекция, парсер, SSE `tool_calls`,
> полный цикл).

1. В DSH попросите выполнить команду: «Выполни `pwd` через bash и покажи
   вывод».
2. Ожидаемый поток:
   - первый чанк `tool_calls`: `index: 0`, `id: "call_..."`,
     `type: "function"`, `function.name: "bash"`, `function.arguments: ""`;
   - последующие чанки: только `index` и фрагменты `function.arguments`
     (**без** `id` и `name`);
   - чанк с `finish_reason: "tool_calls"`, затем `data: [DONE]`;
   - DSH исполняет `bash` и присылает второй запрос с `role: "tool"` и
     `tool_call_id`;
   - шлюз выполняет новый PoW-challenge, получает финальный текстовый
     ответ и отдаёт `finish_reason: "stop"`.
3. Признак успеха: DSH показывает результат команды, в интерфейсе нет
   `UNKNOWN_TOOL`.

### 6.3. Что смотреть в логах

- старт сервера: `AI DSH Bridge v0.5.0 listening on ...`;
- `requestId` запроса и модель;
- статус upstream-ответа и длительность PoW (ориентир 100–500 мс);
- число распознанных `tool_calls` и `finish_reason`;
- счётчики retry (PoW, сетевые ошибки).

При `DEBUG=1` «сырые» ответы DeepSeek сохраняются в `DEBUG_DIR`
(`~/.ai-dsh-bridge/debug` по умолчанию) с именем вида
`YYYYMMDD-HHmmss-<requestId>-<kind>.json`. В лог не попадают токены,
cookie, заголовки авторизации и полные промпты (RULES §5).

Для подробного вывода:

```powershell
$env:LOG_LEVEL = 'debug'
$env:DEBUG = '1'
pnpm dev
```

---

## 7. Troubleshooting

| Симптом | Вероятная причина | Действие |
|---|---|---|
| `pnpm dev` завершается с `ZodError` / `Failed to start AI DSH Bridge` | Некорректная переменная окружения (`PORT`, `DEBUG`, `LOG_LEVEL`, `DEEPSEEK_BASE_URL`) | Проверьте значения по таблице §8; `DEBUG` принимает только `0`/`1`, `LOG_LEVEL` — уровни pino |
| `EADDRINUSE` на порту 3456 | Порт занят другим процессом | Остановите процесс или задайте другой `PORT` (например, `PORT=3457` в `.env`) |
| `curl`/`Invoke-RestMethod` — `connection refused` | Сервер не запущен или клиент идёт на `::1` | Запустите `pnpm dev`; используйте `http://127.0.0.1:3456` |
| DSH «не отвечает» / таймаут запроса | Шлюз не запущен, сессия не получена, занят порт 3456 | Проверьте `pnpm dev`, `GET /health`, порт 3456 и сессию Chrome (§3, §4) |
| `501 Not implemented` на `/v1/chat/completions` | Установлена версия <0.5.0 | Обновите проект: в 0.5.0 `stream:true` реализован |
| `pnpm webauth` — «файл не найден» | Установлен старый релиз (<0.2.0) | Обновите проект: в v0.2.0 `src/auth/webauth.ts` присутствует |
| `401` с текстом «Re-run webauth» | Сессия DeepSeek истекла/невалидна | Повторите `pnpm webauth`; проверьте `AUTH_FILE` |
| `UNKNOWN_TOOL` в DSH | В continuation-чанках переданы `id`/`name` (пустая строка или `null`) | Проверьте SSE-поток при `DEBUG=1`; исправьте SseWriter: `id`/`name` только в первом чанке (RULES §7.1, ARCHITECTURE §5.5) |
| `PoW failed` / таймауты challenge | Рассинхронизация часов, временный сбой upstream | Повторите запрос; синхронизируйте время; проверьте `DEEPSEEK_BASE_URL`; при повторении — KI |
| Upstream `403` / `429` | Ограничения или блокировка аккаунта | Подождите, повторите позже; используйте отдельный аккаунт |
| DSH не видит модели («Fetch available models» падает) | Шлюз не запущен или указан неполный URL | Проверьте `GET /v1/models` вручную; `openaiURL` — полный URL эндпоинта |
| Ответ оборвался / пустой `content` | Ошибка разбора DSML или fail-safe | Включите `DEBUG=1`, изучите дамп; при неполных аргументах вызов намеренно не выполняется (ARCHITECTURE §5.3) |
| `pnpm webauth` не открывает Chrome/падает CDP | Chrome уже запущен без отладочного порта или порт 9222 занят | Закройте все окна Chrome, проверьте порт 9222, повторите |
| `auth.json` прочитан другим пользователем | Неверные права | POSIX: `chmod 600`; Windows: ограничьте ACL текущим пользователем |

Диагностика порта в PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 3456 -State Listen -ErrorAction SilentlyContinue
```

Диагностика CDP-порта:

```powershell
curl.exe -s http://127.0.0.1:9222/json/version
```

Если проблема воспроизводится стабильно — зафиксируйте её в
[KNOWN_ISSUES.md](./KNOWN_ISSUES.md) по формату `KI-XXX` (RULES §2.2).

---

## 8. Переменные окружения

Значения по умолчанию соответствуют `src/config.ts` и `.env.example`.
Неизвестные значения не «подхватываются молча»: конфигурация валидируется
Zod-схемой на старте. С v0.1.2 `.env` опционален и загружается нативно
через `--env-file-if-exists=.env` (см. §2); переменные оболочки имеют
приоритет над файлом.

| Переменная | По умолчанию | Допустимые значения | Назначение |
|---|---|---|---|
| `PORT` | `3456` | Целое 1–65535 | Порт HTTP-сервера (loopback) |
| `DEBUG` | `0` | `0` или `1` | `1` — сохранять «сырые» ответы DeepSeek в `DEBUG_DIR` |
| `DEBUG_DIR` | `~/.ai-dsh-bridge/debug` | Путь; `~` раскрывается | Каталог debug-дампов (вне репозитория) |
| `DEEPSEEK_BASE_URL` | `https://chat.deepseek.com` | Валидный URL | Базовый URL upstream; менять только для отладки/зеркала |
| `AUTH_FILE` | `~/.ai-dsh-bridge/auth.json` | Путь; `~` раскрывается | Файл с сессией DeepSeek (`webauth`) |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | Уровень логирования Fastify/pino |

### 8.1. Как задать переменные

`pnpm dev`/`start` загружают `.env`, если он существует; переменные
оболочки имеют приоритет. Примеры для PowerShell:

```powershell
$env:PORT = '3456'
$env:LOG_LEVEL = 'debug'
$env:DEBUG = '1'
pnpm dev
```

Для bash:

```bash
PORT=3456 LOG_LEVEL=debug DEBUG=1 pnpm dev
```

Для cmd.exe:

```bat
set PORT=3456
set LOG_LEVEL=debug
pnpm dev
```

Переменные действуют в текущей сессии оболочки; после перезапуска их нужно
задать снова. `AUTH_FILE` и `DEBUG_DIR` можно задавать относительными
путями — они будут разрешены от текущего каталога.

---

## 9. Полезные команды

Все команды — из `package.json`; других CLI-флагов проект не вводит.

| Команда | Что делает | Статус в v0.5.0 |
|---|---|---|
| `pnpm dev` | Запуск с `tsx watch --env-file-if-exists=.env` | ✅ |
| `pnpm build` | Сборка TypeScript (`tsc -p tsconfig.build.json`) | ✅ |
| `pnpm start` | Запуск собранного `dist/index.js` (`--env-file-if-exists=.env`) | ✅ (после `pnpm build`) |
| `pnpm webauth` | Одноразовый захват сессии DeepSeek | ⏳ после этапа 2 |
| `pnpm typecheck` | Проверка типов без эмита | ✅ |
| `pnpm lint` | oxlint с type-aware проверками | ✅ |
| `pnpm test` | vitest (пока тестов нет — `--passWithNoTests`) | ✅ |
| `pnpm test:watch` | vitest в watch-режиме | ✅ |

Пример production-запуска:

```powershell
pnpm build
pnpm start
```

---

## 10. Захват запросов DeepSeek

Инструкция для человека (Этап 0, DESIGN §10). Скрипта нет: запросы
снимаются вручную через DevTools. Захваты от 2026-10-19 уже сохранены в
`docs/captures/`: `users-current`, `pow-challenge`, `chat-completion` и
`.sse`-поток.

1. Откройте Chrome → `chat.deepseek.com`, войдите в аккаунт.
2. DevTools → **Network** → фильтр `api/v0`.
3. Отправьте сообщение в чат.
4. Найдите запрос `chat/completion` (POST, статус 200).
5. Правый клик → **Copy → Copy as cURL (bash)**.
6. Сохраните результат в `docs/captures/YYYY-MM-DD-chat-completion.http`.
7. Вкладка **Response** → правый клик по `data:`-потоку → **Save all as
   HAR** или скопируйте SSE вручную →
   `docs/captures/YYYY-MM-DD-chat-completion.sse`.
8. Аналогично сохраните `create_pow_challenge` (POST, обычно перед
   completion) и `users/current` (GET при загрузке страницы) — файлы
   `YYYY-MM-DD-pow-challenge.http` и `YYYY-MM-DD-users-current.http`
   в `docs/captures/`.

Назначение и формат файлов — в
[docs/captures/README.md](captures/README.md).

> ⚠️ **Не коммитьте captures с реальным токеном.** В `.gitignore` уже есть
> `auth.json`, но captures содержат `Authorization: Bearer ...` и
> `Cookie: ...` — перед сохранением замените их на `<REDACTED>`. Паттерны
> `docs/captures/*.http` и `docs/captures/*.sse` дополнительно исключены
> из git; `README.md` и `.gitkeep` коммитятся.

---

## 11. Безопасность

- `auth.json` и `.env` — вне git (`.gitignore`); проверяйте `git status`
  перед коммитом.
- Не прикладывайте debug-дампы из `DEBUG_DIR` к issue: там могут быть
  пользовательские данные (RULES §5.4).
- Не публикуйте порт `3456` за пределы машины: шлюз не проверяет API-ключ.
- Используйте отдельный аккаунт DeepSeek; помните о риске блокировки
  (DESIGN §11).
- Логгер должен иметь redaction для `authorization`, `cookie`,
  `x-ds-pow-response` (RULES §5.3); не отключайте его.

---

## 12. Дальнейшие шаги

1. Прочитайте [ARCHITECTURE.md](./ARCHITECTURE.md) — как устроены L1–L4 и
   почему `id`/`name` отправляются только в первом чанке.
2. Сверьтесь с [DESIGN.md](./DESIGN.md) §10 — этапы 0–8.
3. Для разработки — [RULES.md](./RULES.md) (стиль, безопасность, workflow).
4. Известные ограничения и статус — [KNOWN_ISSUES.md](./KNOWN_ISSUES.md).
5. Начните Этап 0: снимите захваты по §10 в `docs/captures/` и сверьте
   формат DSML/SSE с DESIGN §5.
