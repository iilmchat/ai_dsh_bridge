# AI DSH Bridge — Design Document

**Версия:** 0.2 (Draft)
**Дата:** 2026-10-19
**Обновлено:** 2026-10-19 — по реальным захватам `chat.deepseek.com` (JSON Patch SSE, PoW, WAF)
**Статус:** Проектирование
**Проект:** AI DSH Bridge

---

## 1. Назначение и цели

**AI DSH Bridge** — локальный OpenAI-совместимый шлюз, который позволяет
**DeepSeek Harness (DSH)** использовать веб-интерфейс `chat.deepseek.com` в
качестве провайдера моделей. Шлюз не требует API-ключей: аутентификация
выполняется один раз через браузер, после чего запросы к DeepSeek выполняются
от имени авторизованной сессии.

### 1.1. Ключевые цели

| Цель | Описание |
|---|---|
| **OpenAI-совместимость** | DSH подключается как «Custom Provider» через `/v1/models` и `/v1/chat/completions` |
| **Корректный `tool_calls`** | Полный цикл: DSH присылает `tools` → шлюз эмулирует вызов → DSH выполняет инструмент → результат возвращается модели |
| **Устойчивый стриминг (SSE)** | Соблюдение спецификации OpenAI, исключающее `UNKNOWN_TOOL` из-за пустых `id`/`name` |
| **Автономная аутентификация** | Одноразовый `webauth` захватывает сессию; сервер работает без ручного вмешательства |
| **Обход PoW** | Автоматическое решение `DeepSeekHashV1` для каждого запроса |

### 1.2. Не-цели

- Поддержка других провайдеров (только `chat.deepseek.com`).
- Замена официального API DeepSeek.
- Мультиаккаунтность и балансировка нагрузки (на первом этапе).

---

## 2. Архитектура

### 2.1. Высокоуровневая схема

    ┌──────────────────────────────────────────────────────────────────┐
    │                     DeepSeek Harness (DSH)                       │
    │              Custom Provider: deepseek-web                       │
    └──────────────────────────┬───────────────────────────────────────┘
                               │ OpenAI-совместимый HTTP/SSE
                               │ POST /v1/chat/completions
                               │ GET  /v1/models
                               ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │                  AI DSH Bridge (Node.js/Fastify)                 │
    │  ┌────────────────────────────────────────────────────────────┐ │
    │  │ L1: OpenAI Facade (Fastify)                                │ │
    │  │     • /v1/models  → ["deepseek-web-chat", ...]             │ │
    │  │     • /v1/chat/completions → SSE / JSON                    │ │
    │  └────────────────────────┬───────────────────────────────────┘ │
    │                           │                                      │
    │  ┌────────────────────────▼───────────────────────────────────┐ │
    │  │ L2: Translation Layer                                     │ │
    │  │     • Prompt Builder (DSML injection)                     │ │
    │  │     • DSML Parser (streaming tokenizer)                   │ │
    │  │     • Tool Call Reconstructor → OpenAI `tool_calls`       │ │
    │  └────────────────────────┬───────────────────────────────────┘ │
    │                           │                                      │
    │  ┌────────────────────────▼───────────────────────────────────┐ │
    │  │ L3: DeepSeek Client                                       │ │
    │  │     • Session manager (Bearer, ds_session_id)             │ │
    │  │     • PoW solver (DeepSeekHashV1)                         │ │
    │  │     • Request builder (chat_session, prompt, files)       │ │
    │  └────────────────────────┬───────────────────────────────────┘ │
    │                           │                                      │
    │  ┌────────────────────────▼───────────────────────────────────┐ │
    │  │ L4: Transport                                             │ │
    │  │     • Прямой HTTP с корректными заголовками (основной)     │ │
    │  │     • CDP Executor (fallback)                             │ │
    │  └────────────────────────┬───────────────────────────────────┘ │
    └───────────────────────────┼──────────────────────────────────────┘
                                │ HTTPS / CDP
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │              Chrome (вкладка chat.deepseek.com)                  │
    │                 авторизованная сессия                            │
    └──────────────────────────────────────────────────────────────────┘

### 2.2. Обоснование транспортного слоя (L4)

Изначально предполагалось использовать **CDP** для выполнения `fetch` внутри
браузера. Однако анализ открытых проектов (`deepseek-web2api-free`,
`token-free-gateway`) показывает, что при наличии **корректного
Bearer-токена**, **cookie** и **решения PoW** запрос можно отправлять
**напрямую из Node.js**. Это значительно проще и надёжнее.

**Решение:** На первом этапе реализуем **прямой HTTP-транспорт**. CDP
остаётся как резервный вариант (fallback) на случай, если DeepSeek ужесточит
TLS-фингерпринтинг или потребует выполнения JS-контекста.

---

## 3. Аутентификация и сессия

### 3.1. `webauth` — одноразовый захват сессии

1. Запускает Chrome с `--remote-debugging-port=9222` (если ещё не запущен).
2. Открывает `https://chat.deepseek.com`.
3. Ждёт, пока пользователь войдёт вручную.
4. Через CDP или через прямой запрос извлекает:
   - `ds_session_id` из cookie.
   - **Bearer token** из `localStorage` (ключ `userToken`) или через
     `GET /api/v0/users/current`.
5. Сохраняет в `~/.ai-dsh-bridge/auth.json`.

**Фактические поля (из захвата 2026-10-19):**
- `ds_session_id` — из cookie (поле `Cookie`).
- Bearer token — из заголовка `Authorization: Bearer <token>`.
- WAF-токен — из cookie `aws-waf-token` (обязателен для запросов).

**Валидация:** `GET /api/v0/users/current` с заголовком
`Authorization: Bearer <token>` и cookie `ds_session_id`.

### 3.2. Валидация сессии

Перед каждым запросом шлюз проверяет токен через `GET /api/v0/users/current`.
При 401/403 — пытается обновить токен из cookie. Если не удаётся — возвращает
ошибку с просьбой повторить `webauth`.

---

## 4. Proof-of-Work (DeepSeekHashV1)

Каждый запрос к `POST /api/v0/chat/completion` требует заголовок
`x-ds-pow-response`.

### 4.1. Поток PoW

1. `POST /api/v0/chat/create_pow_challenge` — получение challenge
   (алгоритм `DeepSeekHashV1`, сложность).
2. Решение challenge через **порт WASM-решателя** DeepSeek (custom Keccak
   sponge).
3. Формирование base64-ответа и отправка в заголовке `x-ds-pow-response`.

**Challenge (ответ `POST /api/v0/chat/create_pow_challenge`):**

    {
      "algorithm": "DeepSeekHashV1",
      "challenge": "<hex>",
      "salt": "<hex>",
      "signature": "<hex>",
      "difficulty": 144000,
      "expire_at": <timestamp_ms>,
      "expire_after": 300000,
      "target_path": "/api/v0/file/upload_file"
    }

**Response (заголовок `x-ds-pow-response`):** Base64-encoded JSON:

    {
      "algorithm": "DeepSeekHashV1",
      "challenge": "<hex>",
      "salt": "<hex>",
      "answer": 105243,
      "signature": "<hex>",
      "target_path": "/api/v0/chat/completion"
    }

**WAF:** заголовки `x-hif-dliq` и `x-hif-leim` — обязательны для
прохождения WAF. Значения генерируются JS на клиенте; на первом этапе
можно **не отправлять их** (проверить, пропустит ли сервер) или
реализовать генерацию (сложно, отложить). Статус — KI-013.

### 4.2. Реализация

Используем готовый TypeScript-порт из `deepseek-web2api-free` или
`OmniRoute` (`deepseek-pow.ts` / `deepseek-pow-solver.cjs`). Лицензия должна
быть совместима (MIT/Apache).

**Кэширование:** Challenge одноразовый, кэшировать нельзя. Решение занимает
~100–500 мс в зависимости от сложности.

---

## 5. Слой трансляции: DSML и `tool_calls`

Это **ядро проекта**. Именно здесь решается проблема, из-за которой многие
шлюзы «ломают» DSH.

> **Фактическое открытие (захват 2026-10-19).** DeepSeek **не использует
> DSML** для обычного чата: ответ приходит SSE-потоком JSON Patch-подобных
> патчей (`{"v": "..."}`, `{"p": "...", "o": "APPEND", "v": "..."}`,
> `{"p": "response", "o": "BATCH", "v": [...]}`). Поэтому конвейер L2
> двухступенчатый: **сначала** из патчей собирается текст ответа, **затем**
> в нём ищутся DSML-маркеры. DSML остаётся нашим форматом для эмуляции
> `tool_calls` — нативного API для них у DeepSeek нет.

### 5.1. Почему DSML, а не обычный JSON в промпте

`token-free-gateway` внедряет `tools` как обычный текст и парсит ответ
обратно в `tool_calls`. Это работает, но **ненадёжно**: модель может ответить
в свободной форме, и парсер не найдёт вызов.

`deepseek-web2api-free` использует **DSML (DeepSeek Markup Language)** —
структурированный синтаксис, который модель генерирует предсказуемо:

    <｜DSML｜tool_calls>
      <｜DSML｜invoke name="bash">
        <｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>
      </｜DSML｜invoke>
    </｜DSML｜tool_calls>

**Решение:** Используем DSML. Это даёт чёткие маркеры для потокового
парсера. Модель генерирует DSML внутри обычного текста; парсер извлекает
его после сборки ответа из JSON-патчей (§ 5.3), а не из «сырых» чанков.

### 5.2. Проблемы реального мира и их решения

| Проблема | Симптом | Решение в AI DSH Bridge |
|---|---|---|
| **Двойные pipe-маркеры** | `<｜｜DSML｜｜ calls>` вместо `<｜DSML｜tool_calls>` | Нормализация: заменяем двойные pipe и пробельные структурные слова на канонические теги перед парсингом |
| **Пропущен открывающий wrapper** | Модель пишет `<｜DSML｜invoke ...>` без `<｜DSML｜tool_calls>` | Fail-safe: если видим `invoke` на верхнем уровне, обрабатываем как неявный wrapper |
| **Незакрытые/обрезанные параметры** | `{"url": "https://...` без закрывающей скобки | Инкрементальный парсер с «удерживанием» незавершённых значений до прихода следующего чанка |
| **Незакрытый `invoke` в конце потока** | Модель забыла `</｜DSML｜invoke>` | При `finish_reason: stop` — принудительное закрытие и валидация; если аргументы неполные — **не выполнять** вызов (fail-safe) |
| **DSML-маркеры внутри значений параметров** | В коде есть строка `<｜DSML｜parameter>` | Экранирование: парсер учитывает контекст значения; при сомнении — отказ от выполнения (лучше ошибка, чем неверный вызов) |

### 5.3. Потоковый конвейер: JSON Patch → текст → DSML

Парсер работает **инкрементально** и состоит из двух ступеней.

**Ступень 1. Сборка текста из JSON-патчей.** DeepSeek стримит не DSML, а
JSON Patch-подобные сообщения в `data:`-строках:

| Сообщение | Значение |
|---|---|
| `data: {"v": "текст"}` | append-фрагмент к текущему ответу |
| `data: {"v": {<response object>}}` | начальный полный объект ответа (первое сообщение потока) |
| `data: {"p": "response/fragments/-1/content", "o": "APPEND", "v": "..."}` | JSON Patch: дописать в последний фрагмент |
| `data: {"p": "response", "o": "BATCH", "v": [...]}` | батч-обновление полей ответа |
| `data: {"p": "response/status", "o": "SET", "v": "FINISHED"}` | JSON Patch: SET поля |

Служебные `event:` (`ready`, `update_session`, `title`, `close`)
игнорируются, кроме признака завершения (`status: FINISHED` / `close`).
Текст накапливается в буфере ответа: первое сообщение задаёт полный объект
`response` (фрагмент `RESPONSE` уже содержит первый текст), дальше приходят
append-фрагменты.

**Ступень 2. Поиск DSML в собранном тексте.** После каждого append-патча
буфер сканируется на маркеры `<｜DSML｜tool_calls>`/`<｜DSML｜invoke>`;
при обнаружении включается потоковый tokenizer.

**Состояния tokenizer'а (вторая ступень):**

    IDLE → SEEN_CALLS_OPEN → IN_INVOKE → IN_PARAMETER → VALUE → CLOSING → DONE

**Ключевое правило для SSE (предотвращение `UNKNOWN_TOOL`):**

> **`id` и `name` инструмента отправляются DSH ровно один раз — в первом
> чанке `tool_calls` для данного индекса. Во всех последующих чанках эти
> поля опускаются.**

Это критично, потому что DSH использует проверку `!== undefined`. Если
отправить `id: ""` или `name: null` в continuation-чанке, DSH перезапишет
корректную идентичность и получит `UNKNOWN_TOOL`.

**Пример корректного SSE-потока `tool_calls`:**

    // Чанк 1: идентичность + начало аргументов
    data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"bash","arguments":""}}]}}]}

    // Чанк 2: только фрагмент аргументов (id и name ОТСУТСТВУЮТ)
    data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]}}]}

    // Чанк 3: продолжение аргументов
    data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls -la\"}"}}]}}]}

    // Чанк 4: завершение
    data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

**Порядок проверки:** парсер сначала проверяет, не является ли ответ
обычным текстом; если DSML-маркеров нет — собранный текст возвращается как
`content` без `tool_calls`.

### 5.4. Реконструкция `tool_calls` (non-streaming)

Для non-streaming режима собираем полный ответ, парсим DSML, формируем массив
`tool_calls` и возвращаем в стандартном формате OpenAI:

    {
      "choices": [{
        "message": {
          "role": "assistant",
          "content": null,
          "tool_calls": [{
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "bash",
              "arguments": "{\"command\":\"ls -la\"}"
            }
          }]
        },
        "finish_reason": "tool_calls"
      }]
    }

---

## 6. Prompt Builder: внедрение `tools` в DeepSeek

### 6.1. Формат системной инструкции

DSH присылает `tools[]` в формате OpenAI. Мы преобразуем их в
DSML-инструкцию:

    [SYSTEM]
    Ты — агент. Если тебе нужно использовать инструмент, ответь СТРОГО в формате DSML:

    <｜DSML｜tool_calls>
      <｜DSML｜invoke name="TOOL_NAME">
        <｜DSML｜parameter name="PARAM_NAME" string="true">PARAM_VALUE</｜DSML｜parameter>
      </｜DSML｜invoke>
    </｜DSML｜tool_calls>

    Доступные инструменты:
    - bash: Выполняет shell-команду. Параметры: command (string, required)
    - read_file: Читает файл. Параметры: path (string, required)
    ...

### 6.2. История диалога

DSH присылает историю `messages`, включая предыдущие `tool_calls` и
результаты инструментов (`role: "tool"`). Prompt Builder преобразует их в
текст:

- `assistant` с `tool_calls` → DSML-блок.
- `tool` с результатом → текстовый блок `[TOOL RESULT: call_id] ...`.

Это позволяет модели видеть полный цикл и корректно продолжать рассуждение.

### 6.3. Тело запроса `POST /api/v0/chat/completion`

Prompt Builder формирует `prompt` (системная инструкция + история) и
отправляет его в теле запроса:

    {
      "chat_session_id": "<uuid>",
      "parent_message_id": null,
      "model_type": "default",
      "prompt": "<текст с DSML-инструкцией>",
      "ref_file_ids": [],
      "thinking_enabled": false,
      "search_enabled": true,
      "action": null,
      "preempt": false
    }

`chat_session_id` — **не случайный UUID**: DeepSeek Web API требует, чтобы
сессия была создана заранее через `POST /api/v0/chat_session/create`
(ответ: `{"code":0,"data":{"biz_data":{"chat_session":{"id":"<uuid>"}}}}`).
Без этого `/chat/completion` возвращает JSON-ошибку вместо SSE.
`parent_message_id`/`action` — `null` на первом turn; для продолжения
используется id предыдущего ответа. `model_type`: `default` (chat) или
`reasoner`; `thinking_enabled`/`search_enabled` включают режимы
рассуждения/поиска. Схемы — `src/deepseek/types.ts`; создание сессии —
`createChatSessionAsync(auth)` в `src/deepseek/client.ts`.

---

## 7. OpenAI Facade (L1)

### 7.1. Эндпоинты

| Метод | Путь | Описание |
|---|---|---|
| `GET` | `/v1/models` | Список моделей: `["deepseek-web-chat", "deepseek-web-reasoner"]` |
| `POST` | `/v1/chat/completions` | Основной эндпоинт (streaming / non-streaming) |
| `GET` | `/health` | Проверка живости |

### 7.2. Конфигурация DSH

В `settings.yaml` DSH или через Web UI (Settings → Models → Add a custom
provider):

    llm-pi-ai:
      providers:
        deepseek-web:
          flavor: custom
          openaiURL: http://localhost:3456/v1/chat/completions
          apiKeyEnv: DEEPSEEK_WEB_DUMMY  # любая непустая строка
          models:
            - deepseek-web-chat

**Важно:** DSH ожидает, что `openaiURL` — это **полный URL** эндпоинта, а
не базовый префикс. Также при добавлении провайдера можно нажать «Fetch
available models», и DSH обратится к `GET /v1/models`.

### 7.3. API-ключ

Шлюз **не проверяет** API-ключ. Аутентификация уже встроена в сессию
DeepSeek. DSH всё равно требует непустое значение — передаём любую строку
(например, `sk-dummy`).

---

## 8. Обработка ошибок и устойчивость

### 8.1. Ошибки DeepSeek

| Ситуация | Действие |
|---|---|
| 401/403 от DeepSeek | Попытка refresh токена; если не удалось — 401 клиенту с сообщением «Re-run webauth» |
| PoW challenge failed | Повторная попытка (до 3 раз) с новым challenge |
| Сетевая ошибка | Retry с экспоненциальной задержкой |
| Модель вернула не-DSML текст | Возврат как обычный `content` (без `tool_calls`) |

### 8.2. Ошибки парсинга DSML

| Ситуация | Действие |
|---|---|
| Незакрытый параметр в конце потока | **Не выполнять** вызов; вернуть `finish_reason: stop` с текстом ошибки в `content` |
| Неизвестный инструмент в DSML | Вернуть `tool_calls` как есть; DSH сам сгенерирует `UNKNOWN_TOOL` и передаст модели обратную связь |
| Пустой `invoke` (нет параметров) | Игнорировать вызов, продолжить парсинг |

---

## 9. Структура проекта

    ai-dsh-bridge/
    ├── src/
    │   ├── index.ts              # Точка входа, запуск Fastify
    │   ├── config.ts             # Загрузка auth.json, настройки
    │   ├── auth/
    │   │   ├── webauth.ts        # Одноразовый захват сессии
    │   │   └── session.ts        # Валидация и refresh
    │   ├── deepseek/
    │   │   ├── client.ts         # HTTP-клиент к chat.deepseek.com
    │   │   ├── pow.ts            # DeepSeekHashV1 solver
    │   │   └── types.ts
    │   ├── translate/
    │   │   ├── prompt.ts         # Prompt Builder (DSML injection)
    │   │   ├── dsml-parser.ts    # Потоковый DSML tokenizer
    │   │   ├── tool-reconstructor.ts  # → OpenAI tool_calls
    │   │   └── sse.ts            # Генерация SSE-чанков
    │   ├── api/
    │   │   ├── models.ts         # GET /v1/models
    │   │   └── completions.ts    # POST /v1/chat/completions
    │   └── transport/
    │       ├── http.ts           # Прямой HTTP (основной)
    │       └── cdp.ts            # CDP fallback (опционально)
    ├── test/
    │   ├── dsml-parser.test.ts
    │   ├── sse-tool-calls.test.ts
    │   └── e2e.test.ts
    ├── package.json
    ├── tsconfig.json
    └── README.md

---

## 10. Этапы реализации

| Этап | Содержание | Результат |
|---|---|---|
| **0. Исследование** | Захват реального запроса/ответа DeepSeek через DevTools; проверка формата стриминга (JSON Patch, не DSML) | `docs/captures/*.http`, `*.sse` (захваты 2026-10-19) |
| **1. Каркас** | Fastify + `/v1/models` + заглушка `/v1/chat/completions` | Шлюз отвечает на `/v1/models` |
| **2. Аутентификация** | `webauth`, `auth.json`, валидация сессии | Токен получен и проверен |
| **3. DeepSeek Client** | Прямой HTTP-запрос к `/api/v0/chat/completion` с PoW | Простой чат работает |
| **4. Prompt Builder** | Внедрение `tools` как DSML | Модель генерирует DSML |
| **5. DSML Parser (non-streaming)** | Парсинг полного ответа → `tool_calls` | `tool_calls` в JSON |
| **6. SSE Streaming** | Потоковый парсер + корректные чанки (без пустых `id`/`name`) | DSH выполняет инструмент |
| **7. Полный цикл** | DSH → tool_call → bash → результат → второй turn | Сквозной сценарий работает |
| **8. Устойчивость** | Обработка edge cases DSML, retry, логирование | Стабильная работа |

---

## 11. Критические риски и митигация

| Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|
| **Изменение API DeepSeek** | Высокая | Высокое | Абстракция клиента; быстрый патч после реверса |
| **Нестабильный DSML** | Высокая | Среднее | Многоуровневый парсер с fail-safe; логирование «сырых» ответов для анализа |
| **PoW solver устареет** | Средняя | Высокое | Изоляция в отдельном модуле; возможность обновления |
| **Бан аккаунта DeepSeek** | Средняя | Высокое | Предупреждение в README; рекомендация использовать отдельный аккаунт |
| **`UNKNOWN_TOOL` из-за SSE** | Низкая (при нашем контроле) | Критическое | Строгий контракт: `id`/`name` только в первом чанке; тесты на это |

---

## 12. Ссылки и источники вдохновения

- `token-free-gateway` — базовая архитектура, подтверждение подхода «tools as prompt».
- `deepseek-web2api-free` — DSML prompt injection, `StreamSieve`, PoW.
- `OmniRoute` PR #2295 — полный PoW solver и SSE-парсинг DeepSeek.
- `OmniRoute` PR #13345 — нативный DSML-парсер, обработка edge cases.
- DSH Handbook — `UNKNOWN_TOOL` из-за пустых `id`/`name` в continuation-чанках.
- DSH Discussion #161 — подтверждение проблемы `null` в continuation-чанках.
- DSH providers guide — настройка Custom Provider, `openaiURL`.

---

**Следующий шаг:** Этап 0 закрыт захватами 2026-10-19 (JSON Patch-стрим,
PoW, WAF). Переходим к Этапу 2 (`webauth`: Bearer, `ds_session_id`,
`aws-waf-token`) и Этапу 3 (клиент DeepSeek + PoW-решатель). Открытый
вопрос — обязательность WAF-заголовков `x-hif-dliq`/`x-hif-leim` (KI-013).
