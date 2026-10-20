# Changelog

Все заметные изменения проекта **AI DSH Bridge** документируются в этом файле.
Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект следует [Semantic Versioning](https://semver.org/lang/ru/).

Реестр известных проблем: [KNOWN_ISSUES.md](KNOWN_ISSUES.md). Процесс выпуска
версий: [RELEASES.md](RELEASES.md).

> На этапе 0.x проект находится в статусе scaffold: breaking changes возможны
> в минорных версиях. Начиная с 1.0.0 действует строгий SemVer.

## [Unreleased]

### Added

- `GET /v1/models` отдаёт `capabilities` (`tools`, `function_calling`,
  `streaming`) в каждой карточке модели — DSH видит поддержку инструментов
  и передаёт `tools` в запросах (маршрут вынесен в `src/api/models.ts`).
- `pnpm dev:kill` — находит процесс на порту 3456, останавливает и
  запускает `pnpm dev`; `pnpm run version` — вывод версии из package.json
  (`pnpm version` зарезервирована pnpm).

---

## [0.6.0-alpha] — 2026-10-20

### Added

- Few-shot для скриншота через PowerShell (`CopyFromScreen`,
  `screenshot.png`) — S1 Vision: модель делает скриншот через `bash`.
- Few-shot для OCR через `tesseract` (`"C:\Program Files\Tesseract-OCR\tesseract.exe" screen.png stdout -l rus+eng`) — S2 Vision: модель распознаёт текст со скриншота через `bash`, проверяя `where tesseract` при другом пути.
- `docs/DESIGN_V06_VISION.md` дополнен разделами 3 «Технические срезы»
  (screenshot, OCR, передача изображений, Prompt Builder, конфигурация) и
  4 «План работ» (S1–S5); R-06-01/R-06-04 переведены в In Progress.

### Changed

- Fallback пустого `content` теперь возвращает `Результат: <последний
  tool-результат>` (до 500 символов), а не только «Готово» — вывод
  инструмента не теряется, даже если модель промолчала.
- Диагностика `role:"tool"`: Prompt Builder помечает пустой tool-результат
  как `(empty)`; в `POST /v1/chat/completions` добавлен opt-in лог
  `DEBUG_MESSAGES=1` (роль, длина/превью content, tool_call_id,
  наличие tool_calls) для разбора запросов DSH.

---

## [0.5.7] — 2026-10-20

### Changed

- Инструкция показывать вывод инструментов: если результат `bash`
  содержит данные (`pwd`, `ls`, `cat`), модель обязана включить их в ответ,
  а не отвечать «Готово».

---

## [0.5.6] — 2026-10-20

### Added

- `docs/ROADMAP.md` — карта развития v0.6.0–v0.9.0 (Vision, Performance,
  Ecosystem, Advanced) с ID `R-XX-NN` и приоритетами.
- `docs/DESIGN_V06_VISION.md` — черновик архитектуры Vision & Multimodal
  (OCR/LLaVA/CDP, гибридный выбор).
- Backlog `KI-1001…KI-1015` в KNOWN_ISSUES (не входит в сводку активных KI).

### Changed

- cwd awareness в Prompt Builder: модель обязана проверять рабочую
  директорию (`pwd`/`cd`), а не предполагать корень проекта; добавлена
  инструкция после файловых результатов.

---

## [0.5.5] — 2026-10-20

### Changed

- Инструкция в Prompt Builder для файловых результатов: если инструмент
  вернул файл, модель отвечает текстом с путём к файлу («Файл сохранён: …»),
  а не пытается вставить файл в чат.

---

## [0.5.4] — 2026-10-20

### Fixed

- Очистка `text` от остатков DSML: после парсинга вырезаются все
  открывающие/закрывающие маркеры (`tool_calls`, `invoke`, `parameter`),
  даже если вызов невалиден; лишние пустые строки схлопываются.

---

## [0.5.3] — 2026-10-20

### Added

- Few-shot пример в Prompt Builder: для системной задачи без
  специализированного инструмента (мышь) модель видит готовый вызов
  `bash` с Python/pyautogui в DSML-формате.

---

## [0.5.2] — 2026-10-20

### Changed

- Мета-инструкция в Prompt Builder: если специализированного инструмента
  нет (мышь, буфер обмена, скриншоты), но доступен `bash` — сразу вызывать
  `bash` для запуска скрипта (Python/PowerShell), а не отвечать «проверю
  доступные инструменты».

---

## [0.5.1] — 2026-10-20

### Fixed

- Пустой `content` после результата инструмента (роль `tool`) больше не
  отдаётся DSH как «completed response with no content»: в Prompt Builder
  добавлена инструкция обязательно отвечать текстом после tool-результата,
  а роут синтезирует fallback (`«Готово. Инструмент выполнен.»` при наличии
  tool-результата, иначе `«Готово.»`).
- Zod-схема `POST /v1/chat/completions` расширена для совместимости с DSH:
  принимаются `store`, `max_completion_tokens`, `n`, `seed`,
  `response_format`, `user`, `parallel_tool_calls` (не используются —
  DeepSeek Web API их не поддерживает); неизвестные поля по-прежнему
  отклоняются `.strict()`; обновлён `docs/api-contract.json`.

---

## [0.5.0] — 2026-10-20

### Added

- `POST /v1/chat/completions` — режим `stream: true` (K2): OpenAI SSE
  (`chat.completion.chunk`), role/content-чанки, `tool_calls` с `id`/`name`
  только в первом чанке, `finish_reason`, `[DONE]`,
  `stream_options.include_usage`.
- `src/translate/sse-writer.ts` — `writeOpenAiSse`.
- Схема запроса расширена: `top_p`, `stream_options`, `frequency_penalty`,
  `presence_penalty`, `stop` (DSH может их присылать).
- `test/api-completions-stream.test.ts` — 6 тестов SSE (контракт чанков,
  continuation без `id`/`name`, usage, ошибки; всего **105 тестов**).

### Changed

- KI-002, KI-005, KI-006 → Fixed (v0.5.0).

### Fixed

- KI-007 — живой e2e DSH ↔ шлюз подтверждён: DSH подключился как Custom
  Provider, выполнил `bash ls -la` через `tool_calls` (SSE с корректными
  `id`/`name`), результат возвращён в модель; проект работает от начала
  до конца.

---

## [0.4.0] — 2026-10-20

### Added

- `POST /v1/chat/completions` — non-streaming режим (K1): Zod-валидация,
  Prompt Builder, DeepSeek (session + PoW + SSE-сборка), DSML-парсер,
  OpenAI-ответ с `tool_calls`; `stream: true` → 501 (K2).
- `src/api/completions.ts`, `src/api/completions.schema.ts` — обработчик и
  строгая схема запроса.
- `src/translate/assemble.ts` — `assembleTextFromEvents`: текст из
  SET/APPEND/text-событий и `accumulated_token_usage` из BATCH.
- `test/api-completions.test.ts` — 10 тестов (200 content/tool_calls,
  400/401/501/502, сборка текста; всего **99 тестов**).

- `scripts/e2e-tools.ts` и `pnpm e2e:tools` — диагностический прогон DSML:
  Prompt Builder (`messages + tools`) → DeepSeek → сборка текста →
  `parseDsml`; флаги `--prompt-only` (без сети) и `--verbose`; лог
  `docs/captures/e2e-tools-YYYY-MM-DD-HH-mm-ss.log`.
- `test/e2e-tools-script.test.ts` — 5 тестов (prompt-only, mock-поток с
  DSML, ответ без DSML, невалидный DSML, имя лога).
- GETTING_STARTED §4.6 — проверка DSML с tools.

### Changed

- Подготовка к публикации на GitHub: README переписан для внешнего
  пользователя (требования, webauth, запуск, DSH, e2e, безопасность);
  личные абсолютные пути разработчика заменены на относительные/домашние;
  фрагмент реального `chat_session_id` обезличен; в `.gitignore` явно
  добавлены `docs/captures/*.log`; `package.json.name` → `ai_dsh_bridge`.

---

## [0.3.1] — 2026-10-20

### Added

- `src/translate/dsml-parser.ts` — non-streaming DSML-парсер: извлекает
  `tool_calls` из полного текста ответа DeepSeek, нормализует pipe-маркеры,
  поддерживает неявный wrapper и fail-safe на незакрытых блоках
  (`{ text, tool_calls, warnings }`).
- `test/dsml-parser.test.ts` — 18 тестов (edge cases из DESIGN § 5.2 +
  уникальность `id`; всего **84 теста**).

---

## [0.3.0] — 2026-10-19

### Added

- `src/translate/prompt.ts` — Prompt Builder: `messages[] + tools[]` → prompt
  с DSML-инструкцией; `toolChoice` (`auto`/`none`/`required`/конкретная
  функция); `PromptValidationError`.
- `src/translate/types.ts` — `OpenAiMessage`, `OpenAiToolCall`, `OpenAiTool`.
- `test/prompt.test.ts` — 12 тестов (prompt без/с tools, system, история
  `tool_calls`, `tool_result`, `toolChoice`, ошибки валидации; всего
  **66 тестов**).

- `scripts/e2e-deepseek.ts` и `pnpm e2e:deepseek` — живой e2e (сессия →
  PoW → completion → SSE → сборка текста), флаг `--verbose`, лог
  `docs/captures/e2e-YYYY-MM-DD-HH-mm.log` с редактированием
  `authorization`/`cookie`/`x-ds-pow-response`.
- `test/e2e-script.test.ts` — unit-тесты сборки текста из SSE-захвата,
  шагов лога, редактирования секретов и ошибок (**66 тестов** всего).
- GETTING_STARTED §4.5 — инструкция по живому e2e.

### Fixed

- **Корневая причина не-SSE ответа:** `chat_session_id` больше не случайный
  UUID — клиент создаёт сессию через `POST /api/v0/chat_session/create`
  (`createChatSessionAsync(auth)` → `{ id }`), а `sendChatAsync` принимает
  этот id обязательным параметром. Без предварительной сессии DeepSeek
  отвечает JSON-ошибкой.
- `POST /api/v0/chat/completion` теперь отправляет
  `accept: text/event-stream` (было `application/json`) — DeepSeek должен
  отдавать SSE, а не JSON.
- `x-ds-pow-response` кодирует запрошенный `target_path`
  (`/api/v0/chat/completion`), а не `target_path` из ответа challenge
  (сервер мог вернуть `/api/v0/file/upload_file`).
- `bodyPreview` не-SSE ответа: для JSON оставляются безопасные поля
  `code`/`msg`/`error` и `biz_code`/`biz_msg` из `data.biz_data` (туда
  DeepSeek кладёт бизнес-ошибки), для не-JSON — прежняя маскировка по
  секретам. Диагностика печатается как `[5.1] Non-SSE response` (нумерация
  этапов e2e сдвинута: `[2] createChatSession`, `[8] E2E OK`).
- KI-016 — `chat_session/create` подтверждён живым e2e (2026-10-19,
  `id=<uuid>`): структура `data.biz_data.chat_session.id` верна,
  схема клиента не менялась.
- Тесты: 66 всего (создание сессии, её отсутствие, `safeBodyPreview` +
  `biz_data`, `accept`, `target_path` PoW, Prompt Builder).

### Changed

- `tsconfig.json` и `pnpm lint`: `scripts/**/*.ts` включены в typecheck и
  lint.

### Planned (Этапы 5–8, DESIGN § 10)

Перечисленное ниже **не входит** ни в v0.1.x, ни в v0.2.0, ни в v0.3.0,
ни в v0.3.1 и пока не реализовано; это состав будущих релизов, а не текущие
возможности шлюза.

- Этап 5 — ToolReconstructor и streaming-парсер: non-streaming DSML-парсер
  готов в 0.3.1, остались сборка `tool_calls` для SSE и инкрементальный
  tokenizer (KI-005).
- Этап 6 — SSE Streaming: SseWriter; `id`/`name` инструмента передаются ровно
  один раз — в первом чанке `tool_calls` для данного `index`, в
  continuation-чанках эти поля отсутствуют (KI-006).
- Этап 7 — полный цикл DSH: `tool_call` → вызов инструмента → результат
  `role: "tool"` → второй turn.
- Этап 8 — устойчивость: обработка edge cases DSML, retry/backoff, отладочные
  дампы «сырых» ответов DeepSeek при `DEBUG=1`.
- Тесты: `test/dsml-parser.test.ts`, `test/sse-tool-calls.test.ts`,
  `test/e2e.test.ts` (мок DeepSeek) (KI-007).

### Security (Planned)

- Реализация правил логирования без токенов и без полных промптов — Этап 8
  (правила уже зафиксированы в RULES и README).

---

## [0.2.0] — 2026-10-19

Этап 2 (`webauth`) и Этап 3 (DeepSeek Client + PoW) реализованы; добавлены
тесты. Реальный чат через `/v1/chat/completions` пока не подключён (KI-002).

### Added

- `src/deepseek/deepseek-hash.ts` — порт DeepSeekHashV1 (SHA3-спonge,
  KECCAK-p[1600,23]; MIT-реализация OmniRoute) и асинхронный перебор nonce
  с уступкой event loop каждые 4096 итераций.
- `src/deepseek/pow.ts` — `solvePowAsync`, `encodePowResponse`/
  `decodePowResponse` для `x-ds-pow-response`.
- `src/deepseek/client.ts` — PoW-challenge под `target_path`
  `/api/v0/chat/completion`, отправка completion, SSE-парсер JSON Patch,
  ретраи `40301`/сетевых ошибок, `AuthExpiredError`,
  `validateSessionAsync`.
- `src/auth/webauth.ts` — запуск/переиспользование Chrome (CDP :9222),
  извлечение `ds_session_id`, `aws-waf-token` и Bearer, сохранение
  `~/.ai-dsh-bridge/auth.json` (права 0600), таймаут 5 минут.
- `src/config.ts` — тип `Auth`, `loadAuthAsync` с `AuthNotFoundError`.
- `src/deepseek/errors.ts` — типизированные ошибки слоёв.
- Тесты: `test/pow.test.ts`, `test/client.test.ts`, `test/webauth.test.ts`
  (**34 теста**); реальный challenge из захвата 2026-10-19 решён
  (`answer` валиден по хэшу).
- `@types/chrome-remote-interface` (devDependency).

### Fixed

- KI-003 — `webauth` реализован (CDP + `auth.json`) и проверен smoke-запуском
  с реальным Chrome.
- KI-004 — клиент DeepSeek и PoW-решатель реализованы и покрыты тестами.
- KI-013 — WAF-заголовки `x-hif-*` не обязательны (ручной тест: PoW
  обязателен, WAF — нет) → Won't Fix.

### Changed

- `tsconfig.json`: `rootDir` → `.` (тестовые файлы вне `src`); сборка
  по-прежнему использует `rootDir: src` из `tsconfig.build.json`.
- `.oxlintrc.json`: категория `pedantic` отключена (max-lines/max-classes
  не отражают RULES); `correctness` остаётся `error`; `pnpm lint` — 0/0.
- `src/index.ts`: синхронные обработчики, top-level await вместо
  promise-chain, stderr вместо `console`; версия 0.2.0.

---

## [0.1.3] — 2026-10-19

Зафиксированы реальные захваты DeepSeek (Этап 0) и уточнён DESIGN по ним.
Главное открытие: стрим DeepSeek — JSON Patch (`{"v": ...}`,
`{"p": ..., "o": "APPEND"|"BATCH"|"SET", "v": ...}`), а не DSML; DSML
остаётся нашим форматом эмуляции `tool_calls`.

### Added

- Захваты 2026-10-19 в `docs/captures/`:
  `2026-10-19-users-current.http`, `2026-10-19-pow-challenge.http`,
  `2026-10-19-chat-completion.http`, `2026-10-19-chat-completion.sse`
  (секреты заменены на `<REDACTED>`, файлы исключены из git).
- `src/deepseek/types.ts` — Zod-схемы `PowChallenge`, `PowResponse`,
  `ChatCompletionRequest` (DESIGN § 4.1, § 6.3).
- `.env.example`: `DEEPSEEK_WAF_DLIQ`, `DEEPSEEK_WAF_LEIM` (опциональные
  WAF-заголовки; KI-013).

### Changed

- DESIGN §3.1 (поля webauth: Bearer, `ds_session_id`, `aws-waf-token`),
  §4.1 (формат challenge/response и WAF), §5 (JSON Patch → текст → DSML;
  §5.3 переписан), §6.3 (тело `chat/completion`), §10 (результат Этапа 0).
- Версия 0.1.3 (package.json, `/health`, README, GETTING_STARTED).

---

## [0.1.2] — 2026-10-19

Технический релиз: закрыт KI-012 (`.env` стал опциональным), подготовлена
инфраструктура Этапа 0 (захват запросов DeepSeek). Функциональность
фасада не менялась.

### Fixed

- KI-012 — скрипты `dev`/`start`/`webauth` используют
  `--env-file-if-exists=.env`: без `.env` приложение стартует на значениях
  по умолчанию (порт 3456), с `.env` — применяет файл. Проверены три
  сценария: без `.env` → 3456, с `PORT=3457` → 3457, снова без `.env` →
  3456.

### Added

- `docs/captures/README.md`, `docs/captures/.gitkeep` и `scripts/.gitkeep` —
  структура для Этапа 0.
- GETTING_STARTED §10 «Захват запросов DeepSeek» — пошаговая инструкция
  для человека (DevTools Network → cURL/SSE → `docs/captures/`).
- `.gitignore`: `docs/captures/*.http` и `docs/captures/*.sse` исключены
  из git (там реальные токены/cookie); `README.md` и `.gitkeep` — нет.

### Changed

- README и GETTING_STARTED: `.env` — опциональный шаг; удалено требование
  создавать `.env` до `pnpm dev`; из troubleshooting убрана ошибка
  `.env: not found`; версия 0.1.2 в примерах.

---

## [0.1.1] — 2026-10-19

Технический релиз: закрыты долги каркаса (KI-008, KI-009), уточнена
документация. Функциональность фасада не менялась: те же три эндпоинта,
`POST /v1/chat/completions` по-прежнему отвечает `501`.

### Fixed

- KI-008 — добавлен `.oxlintrc.json`: oxlint запускается с правилами
  проекта (`typescript/no-explicit-any`,
  `typescript/no-floating-promises`, `typescript/no-misused-promises`,
  `typescript/consistent-type-imports`, `import/no-cycle`,
  `unicorn/prefer-node-protocol`, `no-console: warn`); `pnpm lint` — 0
  errors, 11 warnings.
- KI-009 — `.env` загружается нативно через `--env-file=.env` в скриптах
  `pnpm dev`, `pnpm start`, `pnpm webauth` (без новых зависимостей);
  документация обновлена. Побочный эффект — KI-012.
- README и GETTING_STARTED: `pnpm webauth` помечен как доступный после
  этапа 2; добавлены заметки о занятом порте и смене `PORT`; требование
  создать `.env` перед первым запуском (KI-012).

### Changed

- `package.json`: `version` 0.1.1; скрипты запуска с `--env-file=.env`;
  `GET /health` отдаёт `version: "0.1.1"`.

---

## [0.1.0] — 2026-10-19

Первый публикуемый релиз: каркас репозитория и минимальный OpenAI-совместимый
фасад. Реальный чат, аутентификация, PoW, DSML-парсер и SSE-стриминг в эту
версию не входят — см. раздел «Planned (не входит в v0.1.0)» и
[KNOWN_ISSUES.md](KNOWN_ISSUES.md).

### Added

#### Каркас и инфраструктура

- Репозиторий Node.js 22+ с ESM (`"type": "module"`) и TypeScript 6 в режиме
  `strict`, `NodeNext`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`.
- Конфигурация сборки: `tsconfig.json` (typecheck, `--noEmit`) и
  `tsconfig.build.json` (сборка в `dist/`, source maps).
- Тестовая инфраструктура Vitest 4 (`vitest.config.ts`, окружение `node`,
  маска `test/**/*.test.ts`). Тестов на этом этапе нет — скрипт настроен с
  `--passWithNoTests` (см. KI-007).
- Toolchain качества: `pnpm lint` (`oxlint --type-aware`), `pnpm typecheck`,
  `pnpm test`, `pnpm build`; `oxlint-tsgolint` добавлен в devDependencies и
  lock-файл для типового анализа (KI-008).
- Конфигурация окружения: `.env.example` (`PORT`, `DEBUG`, `DEBUG_DIR`,
  `DEEPSEEK_BASE_URL`, `AUTH_FILE`, `LOG_LEVEL`), `.gitignore`, lock-файл и
  `pnpm-workspace.yaml` с политикой `allowBuilds` для `esbuild` (pnpm 12 не
  запускает postinstall без явного разрешения).
- Файл `LICENSE` — MIT License (Copyright (c) 2026 AI DSH Bridge
  contributors), ссылка в README проверена.

#### L1 OpenAI Facade (Fastify 5)

- Точка входа `src/index.ts`: сборка Fastify, логирование pino, graceful
  shutdown по `SIGINT`/`SIGTERM`, прослушивание `127.0.0.1:PORT`.
- `GET /health` — `{ status: "ok", version: "0.1.0", uptime_sec }`.
- `GET /v1/models` — список OpenAI-совместимых моделей
  `deepseek-web-chat` и `deepseek-web-reasoner` (`object: "list"`,
  `owned_by: "deepseek-web"`), `created: 0`.
- `POST /v1/chat/completions` — заглушка: HTTP 501 и ошибка в формате OpenAI
  (`type: "not_implemented"`, `code: "not_implemented"`); тело запроса,
  включая `messages`, `tools` и `stream`, не обрабатывается (KI-002).
- `src/config.ts` — Zod-валидация переменных окружения на старте, значения по
  умолчанию (порт 3456, `~/.ai-dsh-bridge/debug`, `~/.ai-dsh-bridge/auth.json`,
  `https://chat.deepseek.com`, `info`), раскрытие `~` в путях.
- Зависимости, объявленные для следующих этапов: `fastify`, `zod`, `undici`
  (прямой HTTP к DeepSeek), `chrome-remote-interface` (CDP для `webauth`).

#### Документация

- `README.md` — статус scaffold, быстрый старт, настройка Custom Provider в
  DSH (`openaiURL: http://localhost:3456/v1/chat/completions`), безопасность,
  ссылки на документацию.
- `docs/DESIGN.md` — назначение, архитектура L1–L4, аутентификация, PoW,
  DSML и SSE-контракт, этапы реализации 0–8, риски.
- `docs/api-contract.json` — машинночитаемый контракт ответов
  `/v1/chat/completions`, `/v1/models` и полей SSE-чанков.
- `docs/ARCHITECTURE.md` — C4-модель (контекст, контейнеры, компоненты,
  динамический сценарий).
- `docs/GETTING_STARTED.md` — установка, аутентификация, запуск, настройка
  DSH, troubleshooting, переменные окружения.
- `docs/RULES.md` — инженерные правила и соглашения проекта.
- `docs/PROMPT_CURRENT.md` — актуальный системный промпт ассистента проекта.
- `docs/KNOWN_ISSUES.md` — реестр известных проблем (KI-001–KI-011).
- `docs/CHANGELOG.md` — этот файл.
- `docs/RELEASES.md` — чек-лист релиза и процедура отката.
- `docs/KI_GITHUB_SYNC.md` — проект односторонней синхронизации KI в GitHub
  Issues (`scripts/sync-known-issues.ps1`, ещё не реализован — KI-010).

### Fixed

- Добавлен отсутствовавший файл лицензии `LICENSE` (MIT): ссылка
  `[MIT](LICENSE)` в README перестала быть битой (KI-011).

### Security

- `auth.json` и `.env` исключены из репозитория (`.gitignore`); `auth.json`
  хранится вне рабочей копии — в `~/.ai-dsh-bridge/`.
- Правило «не логировать токены и не логировать промпты целиком» зафиксировано
  в README и RULES; реализация логирования появится на Этапе 8.
- Шлюз слушает только loopback (`127.0.0.1`) и не проверяет API-ключ DSH:
  аутентификация делегирована сессии DeepSeek. Публиковать шлюз в сеть
  не следует.
- В README и DESIGN зафиксировано предупреждение: использование веб-сессии
  DeepSeek может нарушать условия сервиса и привести к блокировке аккаунта.

### Planned (не входит в v0.1.0)

Следующие компоненты спроектированы (DESIGN), но **отсутствуют в коде** этой
версии; их появление изменит поведение шлюза:

- `webauth` — одноразовый захват сессии через CDP (`src/auth/webauth.ts`).
- DeepSeek Client — прямой HTTP с Bearer, cookie и PoW, fallback на CDP
  (`src/deepseek/client.ts`, `src/deepseek/pow.ts`, `src/transport/http.ts`).
- PromptBuilder — внедрение DSML-инструкции с описанием инструментов
  (`src/translate/prompt.ts`).
- DsmlParser — потоковый tokenizer (non-streaming разбор полного ответа) и
  ToolReconstructor → OpenAI `tool_calls`
  (`src/translate/dsml-parser.ts`, `src/translate/tool-reconstructor.ts`).
- SseWriter — генерация `chat.completion.chunk`; контракт `id`/`name` только
  в первом чанке (`src/translate/sse.ts`).
- Тесты DSML-парсера, SSE-контракта и e2e с моком DeepSeek.
- Автоматическое закрытие/синхронизация KI в GitHub (KI_GITHUB_SYNC).

### Known issues

- Открытые проблемы scaffold-релиза перечислены в
  [KNOWN_ISSUES.md](KNOWN_ISSUES.md): 7 Open, 1 Fixed, 1 Deferred,
  2 Documented; блокирующие — KI-005 (🔴 Critical: нет слоя трансляции DSML),
  KI-002, KI-003, KI-004, KI-006, KI-007 (🟠 High).

---

## Ссылки на сравнение версий

Сравнение версий будет добавлено после создания удалённого репозитория и
первого тега: до этого момента ссылки на diff не поддерживаются.
