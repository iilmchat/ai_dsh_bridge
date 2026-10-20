# Известные проблемы AI DSH Bridge

**Версия реестра:** 0.6.0-alpha
**Дата последнего обновления:** 2026-10-20
**Статус проекта:** v0.6.0-alpha (scaffold)

Формат: `KI-XXX` — название, приоритет, статус, файлы.
Приоритеты: 🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low
Статусы: Open / In Progress / Fixed / Documented / Deferred / Won't Fix

Реестр — единственный источник истины о известных проблемах проекта. Записи
ведутся вручную в этом файле; выгрузка в GitHub Issues (односторонняя)
описана в [KI_GITHUB_SYNC.md](KI_GITHUB_SYNC.md). Записи KI-001–KI-011
относятся к релизам 0.1.0–0.1.1, KI-012 — к 0.1.2, KI-013 — к 0.1.3;
исправления KI-003/KI-004/KI-013 вошли в 0.2.0 (Этапы 2–3), KI-016
подтверждён живым e2e и закрыт в 0.3.0.

## Сводка

| Статус | Количество | Записи |
|---|---|---|
| Open | 2 | KI-014, KI-015 |
| In Progress | 0 | — |
| Fixed | 11 | KI-002, KI-003, KI-004, KI-005, KI-006, KI-007, KI-008, KI-009, KI-011, KI-012, KI-016 |
| Documented | 1 | KI-001 |
| Deferred | 1 | KI-010 |
| Won't Fix | 1 | KI-013 |
| **Всего** | **16** | — |

### Приоритеты

| Приоритет | Количество | Записи |
|---|---|---|
| 🔴 Critical | 1 | KI-005 |
| 🟠 High | 5 | KI-002, KI-003, KI-004, KI-006, KI-007 |
| 🟡 Medium | 7 | KI-008, KI-009, KI-011, KI-012, KI-013, KI-014, KI-016 |
| 🟢 Low | 3 | KI-001, KI-010, KI-015 |
| **Всего** | **16** | — |

### Связь с этапами DESIGN § 10

| Этап | Содержание | Связанные KI |
|---|---|---|
| 0 | Исследование (захват запроса/ответа DeepSeek) | — |
| 1 | Каркас: Fastify + `/v1/models` + `/v1/chat/completions` | KI-002 — Fixed в 0.5.0 (SSE) |
| 2 | Аутентификация (`webauth`, `auth.json`) | KI-003 — Fixed в 0.2.0 |
| 3 | DeepSeek Client (HTTP + PoW) | KI-004 — Fixed в 0.2.0 |
| 4 | Prompt Builder (DSML injection) | KI-005 — Fixed в 0.5.0 |
| 5 | DSML Parser | KI-005 — Fixed в 0.5.0 |
| 6 | SSE Streaming (`id`/`name` только в первом чанке) | KI-006 — Fixed в 0.5.0; e2e — KI-007 |
| 7 | Полный цикл tool_call | KI-007 — Fixed в 0.5.0 (живой DSH e2e: bash выполнен, результат возвращён) |
| 8 | Устойчивость (edge cases, retry, логирование) | KI-004, KI-006 |

---

## v0.1.0 — Initial scaffold (2026-10-19)

### KI-001 — Шаблон записи (Documented)
- **Приоритет:** 🟢 Low | **Статус:** Documented | **Обнаружено:** 2026-10-19
- **Файлы:** —
- **Описание:** Шаблон. Реальные проблемы начинаются с KI-002.
- **Связанные:** —

### KI-002 — `POST /v1/chat/completions`: нет SSE-режима (`stream: true`) (Fixed)
- **Приоритет:** 🟠 High | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.5.0 (2026-10-20)
- **Файлы:** `src/api/completions.ts`, `src/translate/sse-writer.ts`
- **Описание:** В 0.4.0 был реализован только non-streaming режим, а
  `stream: true` возвращал HTTP 501, из-за чего DSH (стримит по умолчанию)
  не мог использовать шлюз для сквозного чата.
- **Исправление:** K2 — `writeOpenAiSse` и SSE-ветка в роуте: чанки
  `chat.completion.chunk`, `id`/`name` только в первом `tool_calls`-чанке,
  continuation-чанки без них, `finish_reason`, `[DONE]`,
  `stream_options.include_usage`; тесты `test/api-completions-stream.test.ts`.
- **Связанные:** KI-005, KI-006, KI-007

### KI-003 — `webauth` не реализован (Fixed)
- **Приоритет:** 🟠 High | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.2.0 (2026-10-19)
- **Файлы:** `src/auth/webauth.ts`, `src/config.ts`, `package.json`
- **Описание (было):** Каталог `src/auth/` отсутствовал, `pnpm webauth`
  падал с `ERR_MODULE_NOT_FOUND`, `auth.json` не создавался.
- **Исправление:** `webauth` подключается к Chrome по CDP :9222 (или
  запускает его с отдельным профилем), ждёт входа, извлекает `ds_session_id`,
  `aws-waf-token` и Bearer (`localStorage.userToken` либо
  `users/current`), сохраняет `~/.ai-dsh-bridge/auth.json` с правами 0600;
  таймаут — 5 минут; понятные ошибки (`ChromeNotFoundError`,
  `WebauthTimeoutError`, `TokenExtractionError`).
- **Проверка:** `pnpm webauth` запускает Chrome, подключается к CDP и ждёт
  вход (smoke 2026-10-19); `test/webauth.test.ts` — 8 тестов на mock-CDP.
- **Связанные:** KI-004, KI-013, DESIGN § 3.1

### KI-004 — Нет клиента DeepSeek и решателя PoW (Fixed)
- **Приоритет:** 🟠 High | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.2.0 (2026-10-19)
- **Файлы:** `src/deepseek/deepseek-hash.ts`, `src/deepseek/pow.ts`,
  `src/deepseek/client.ts`, `src/deepseek/errors.ts`
- **Описание (было):** Не было прямого HTTP-транспорта к `chat.deepseek.com`,
  PoW-решателя `DeepSeekHashV1`, валидации сессии и ретраев.
- **Исправление:** реализованы DeepSeekHashV1 (SHA3-спonge,
  KECCAK-p[1600,23]) с асинхронным перебором nonce, `solvePowAsync`,
  challenge под `target_path` `/api/v0/chat/completion`, отправка
  `chat/completion` с `x-ds-pow-response`, SSE-парсер JSON Patch, ретраи
  `40301`/сетевых ошибок, `AuthExpiredError`, `validateSessionAsync`.
- **Проверка:** `test/pow.test.ts` решает реальный challenge из захвата
  2026-10-19 (answer валиден по хэшу); `test/client.test.ts` — 13 тестов
  на SSE/ретраи/401/валидацию; `pnpm test` — 34 теста зелёные.
- **Связанные:** KI-002, KI-003, DESIGN § 4, § 5.3, § 6.3

### KI-005 — Нет PromptBuilder, DsmlParser и ToolReconstructor (Fixed)
- **Приоритет:** 🔴 Critical | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.5.0 (2026-10-20)
- **Файлы:** `src/translate/prompt.ts`, `src/translate/dsml-parser.ts`,
  `src/translate/sse-writer.ts`
- **Описание:** Слой трансляции DSML отсутствовал: `tools[]` не внедрялись
  в prompt, `tool_calls` не извлекались, SSE-контракт не соблюдался.
- **Исправление:** Prompt Builder (0.3.0), non-streaming `parseDsml` с
  нормализацией pipe-маркеров и fail-safe (0.3.1), `writeOpenAiSse` (0.5.0).
  SSE-режим буферизует текст и использует тот же парсер — отдельный
  инкрементальный tokenizer/ToolReconstructor не потребовался для контракта.
- **Связанные:** KI-002, KI-006, DESIGN § 5

### KI-006 — Нет SSE-писателя; контракт `id`/`name` не реализован (Fixed)
- **Приоритет:** 🟠 High | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.5.0 (2026-10-20)
- **Файлы:** `src/translate/sse-writer.ts`, `docs/api-contract.json`,
  `docs/DESIGN.md` § 5.3
- **Описание:** Потоковый режим (`stream: true`) не был реализован: чанки
  `chat.completion.chunk` не формировались, контракт `id`/`name` существовал
  только в документации.
- **Исправление:** `writeOpenAiSse`: роль, content-чанки, первый
  `tool_calls`-чанк с `id`/`name`, continuation-чанки без них (поля
  отсутствуют, не пустые), `finish_reason`, `[DONE]`, опциональный
  usage-чанк; тесты в `test/api-completions-stream.test.ts`.
- **Связанные:** KI-002, KI-005, KI-007, `docs/api-contract.json`

### KI-007 — Нет e2e-теста шлюза (DSH ↔ шлюз) (Fixed)
- **Приоритет:** 🟠 High | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.5.0 (2026-10-20)
- **Файлы:** `test/`, `scripts/`, `docs/captures/`
- **Описание:** Unit-тесты были, но отсутствовала сквозная проверка
  «DSH → шлюз → DeepSeek → tool_call → результат → второй turn».
- **Проверено:** живой e2e DSH ↔ шлюз подтверждён — DSH подключился как
  Custom Provider (`GET /v1/models` → 200), отправил `POST
  /v1/chat/completions` (`stream:true`), выполнил `bash ls -la` через
  `tool_calls` (SSE с корректными `id`/`name`), результат вернулся в модель.
  Проект работает от начала до конца.
- **Связанные:** KI-002, KI-005, KI-006, DESIGN § 5.3

### KI-008 — Нет конфигурации oxlint (`.oxlintrc.json`) (Fixed)
- **Приоритет:** 🟡 Medium | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.1.1 (2026-10-19)
- **Файлы:** `.oxlintrc.json` (добавлен), `package.json`
  (`"lint": "oxlint --type-aware src/ test/"`)
- **Описание (было):** Линтер запускался на дефолтном наборе правил без
  зафиксированной конфигурации: категории и правила проекта (`any`
  запрещён, `unknown` + narrowing, порядок импортов из RULES § 1, § 4) не
  проверялись автоматически. `oxlint-tsgolint` в lock-файле был, поэтому
  режим `--type-aware` работал, но без конфига давал шум/пропуски.
- **Исправление:** добавлен `.oxlintrc.json`: плагины `typescript`,
  `import`, `unicorn`, `oxc`; категории `correctness` (error),
  `suspicious`/`pedantic` (warn); правила `typescript/no-explicit-any`,
  `typescript/no-floating-promises`, `typescript/no-misused-promises`,
  `typescript/consistent-type-imports`, `import/no-cycle`,
  `unicorn/prefer-node-protocol`, `no-console: warn`; исключены `dist/`,
  `node_modules/`, `coverage/`.
- **Проверка:** `pnpm lint` → 0 errors, 11 warnings (pedantic/require-await,
  `no-console`, `prefer-readonly-parameter-types`); обязательные правила
  `no-explicit-any` и `no-floating-promises` не отключены.
- **Связанные:** RULES § 1, § 4; CI; CHANGELOG 0.1.1

### KI-009 — `.env` не загружается автоматически (Fixed)
- **Приоритет:** 🟡 Medium | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.1.1 (2026-10-19)
- **Файлы:** `package.json` (скрипты `dev`/`start`/`webauth`),
  `README.md`, [GETTING_STARTED.md](GETTING_STARTED.md)
- **Описание (было):** `src/config.ts` читал только `process.env`; `.env`,
  созданный по `.env.example`, не применялся без явной загрузки.
- **Исправление:** скрипты запускаются с нативным `--env-file=.env`
  (Node 22+, без новых зависимостей): `dev` — `tsx watch --env-file=.env`,
  `start` — `node --env-file=.env`, `webauth` — `tsx --env-file=.env`.
  `tsx` пробрасывает флаг в Node (проверено); переменные оболочки имеют
  приоритет над `.env`.
- **Побочный эффект:** при отсутствии `.env` команда падает с exit 9
  (`.env: not found`) — вынесено в KI-012; README и GETTING_STARTED
  требуют создать `.env` перед первым запуском.
- **Проверка:** `.env` с `PORT=3457` → `pnpm dev` слушает 3457,
  `GET /health` → `{"version":"0.1.1"}`.
- **Связанные:** KI-012, `.env.example`, DESIGN § 3, CHANGELOG 0.1.1

### KI-010 — `scripts/sync-known-issues.ps1` не реализован (Deferred)
- **Приоритет:** 🟢 Low | **Статус:** Deferred | **Обнаружено:** 2026-10-19
- **Файлы:** `docs/KI_GITHUB_SYNC.md`, `scripts/sync-known-issues.ps1`
  (отсутствует, планируется)
- **Описание:** Односторонняя синхронизация реестра KI в GitHub Issues
  спроектирована, но не реализована; каталога `scripts/` в репозитории нет.
  Пока синхронизация выполняется вручную, а GitHub Issues не используются
  как зеркало реестра.
- **Влияние:** низкое — реестр `docs/KNOWN_ISSUES.md` самодостаточен и
  является источником истины; автоматизация нужна для публичного трекинга.
- **План:** реализовать после стабилизации формата записей (ориентир —
  после Этапа 2), добавить `-DryRun`, метки `ki`, `priority:*`, `status:*`,
  идемпотентный upsert по маркеру `<!-- ki-id: KI-XXX -->`; тесты на Pester.
  Спецификация — [KI_GITHUB_SYNC.md](KI_GITHUB_SYNC.md).
- **Связанные:** KI_GITHUB_SYNC.md, RELEASES § 6

### KI-011 — Нет файла `LICENSE`, хотя заявлена MIT (Fixed)
- **Приоритет:** 🟡 Medium | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Файлы:** `README.md` (ссылка `[MIT](LICENSE)`), `LICENSE` (добавлен),
  `package.json` (`"license": "MIT"`)
- **Описание:** В `package.json` и README заявлена лицензия MIT, но файла
  `LICENSE` в корне не было: ссылка в README вела в никуда, условия
  использования и копирайт не были зафиксированы. Для публичного релиза это
  создавало правовую неопределённость.
- **Исправлено:** 2026-10-19 — добавлен стандартный текст MIT License
  (Copyright (c) 2026 AI DSH Bridge contributors), ссылка в README
  проверена. Точечный diff: `LICENSE`, `README.md`; запись в CHANGELOG есть.
- **Проверка:** `Test-Path LICENSE` → `True`; файл начинается с `MIT License`
  и содержит год 2026.
- **Связанные:** README.md, package.json, CHANGELOG.md

---

## v0.1.1 — Scaffold fixes (2026-10-19)

### KI-012 — `--env-file=.env` требует файла: `pnpm dev` падает без `.env` (Fixed)
- **Приоритет:** 🟡 Medium | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.1.2 (2026-10-19)
- **Файлы:** `package.json` (`dev`/`start`/`webauth`), `README.md`,
  [GETTING_STARTED.md](GETTING_STARTED.md) §2/§7/§9
- **Описание (было):** Скрипты запускались с `--env-file=.env`. Если файла
  `.env` нет (свежий клон, CI), Node завершался с кодом 9 и сообщением
  `.env: not found` — `pnpm dev`/`start`/`webauth` падали до старта
  приложения, хотя значения по умолчанию из `src/config.ts` могли бы
  примениться.
- **Исправление:** `--env-file=.env` заменён на
  `--env-file-if-exists=.env` (Node ≥ 22.9) во всех трёх скриптах; при
  отсутствии файла Node пишет `.env not found. Continuing without it.` и
  продолжает запуск. `tsx` пробрасывает флаг в Node (проверено).
  Документация переформулирована: `.env` — опциональный шаг.
- **Проверка (v0.1.2):** без `.env` → `pnpm dev` слушает 3456,
  `GET /health` 200; с `.env` (`PORT=3457`) → слушает 3457; после удаления
  `.env` → снова 3456. Все три сценария — 200.
- **Связанные:** KI-009, `.env.example`, CHANGELOG 0.1.2

---

## v0.1.3 — Captures & design (2026-10-19)

### KI-013 — WAF-заголовки `x-hif-dliq`/`x-hif-leim` не отправляются (Won't Fix)
- **Приоритет:** 🟡 Medium | **Статус:** Won't Fix | **Обнаружено:** 2026-10-19
- **Файлы:** `src/deepseek/client.ts`, `.env.example`
  (`DEEPSEEK_WAF_DLIQ`, `DEEPSEEK_WAF_LEIM`)
- **Описание:** В захватах 2026-10-19 запросы `chat/completion` содержали
  WAF-заголовки `x-hif-*`; предполагалось, что они обязательны.
- **Решение:** ручной тест Этапа 2 (2026-10-19) показал, что заголовки
  `x-hif-*` **не обязательны**: достаточно Bearer, cookie `ds_session_id`/
  `aws-waf-token` и решённого PoW. Без PoW сервер возвращает
  `{"code":40301,"msg":"INVALID_POW_RESPONSE"}` (HTTP 200) — это лечится
  ретраем с новым challenge, а не WAF-заголовками. Переменные окружения
  оставлены для ручной отладки, код их не требует.
- **Проверка:** `test/client.test.ts` (ретрай `40301`), smoke webauth.
- **Связанные:** KI-003, DESIGN § 4.1, CHANGELOG 0.2.0

---

## v0.2.0 — Auth & DeepSeek client (2026-10-19)

### KI-014 — PoW-решатель на JS медленнее цели (~570 мс) (Open)
- **Приоритет:** 🟡 Medium | **Статус:** Open | **Обнаружено:** 2026-10-19
- **Файлы:** `src/deepseek/deepseek-hash.ts`, `src/deepseek/pow.ts`
- **Описание:** Реальный challenge из захвата (difficulty 144 000) решается
  за ~570 мс на чистом JS (32-битная реализация, чанки по 4096 nonce с
  `setImmediate`). Цель DESIGN §4.2 — ~100–500 мс; верхняя граница
  превышена. Основное время — 23 раунда Keccak на каждый nonce.
- **Влияние:** при большой difficulty или нагруженном CPU PoW может
  добавить заметную задержку к каждому запросу; таймауты клиента (если
  появятся) должны учитывать бюджет.
- **План:** бенчмарк и оптимизация: вынос перебора в `worker_threads`
  (параллельно по ядрам), разворачивание chi/theta в локальные переменные,
  сравнение с WASM-решателем DeepSeek. Целевой бюджет — <300 мс на
  144k; после оптимизации закрыть KI.
- **Связанные:** KI-004, DESIGN § 4.2, CHANGELOG 0.2.0

### KI-015 — `webauth`: не проверено подключение к уже запущенному Chrome (Open)
- **Приоритет:** 🟢 Low | **Статус:** Open | **Обнаружено:** 2026-10-19
- **Файлы:** `src/auth/webauth.ts`
- **Описание:** Smoke 2026-10-19 проверил ветку «Chrome не запущен»:
  `webauth` запустил новый экземпляр с отдельным профилем, подключился к
  CDP :9222 и стал ждать вход. Ветка «CDP уже слушает» (пользователь
  заранее запустил Chrome с `--remote-debugging-port=9222`) покрыта только
  кодом и mock-тестами (`dependencies.connect`), вживую не проверялась.
- **Влияние:** при уже запущенном Chrome возможны отличия (несколько
  страниц, чужой профиль, отсутствие вкладки deepseek) — риск понятной,
  но не подтверждённой ошибки.
- **План:** smoke-сценарий: запустить Chrome вручную с портом 9222,
  выполнить `pnpm webauth` и убедиться, что он подключается к нему, а не
  запускает второй экземпляр.
- **Связанные:** KI-003, DESIGN § 3.1, CHANGELOG 0.2.0

### KI-016 — Нет живого захвата `POST /api/v0/chat_session/create` (Fixed)
- **Приоритет:** 🟡 Medium | **Статус:** Fixed | **Обнаружено:** 2026-10-19
- **Исправлено в:** v0.3.0 (2026-10-19)
- **Файлы:** `src/deepseek/client.ts`, `docs/captures/`
- **Описание:** Структура ответа `chat_session/create` была известна только
  по внешним источникам и ТЗ (`data.biz_data.chat_session.id`); локального
  захвата не было. Клиент поддерживал три возможных места id и бросал
  `DeepSeekApiError`, если id нет.
- **Проверено:** живой e2e 2026-10-19 прошёл полностью (`[8] E2E OK`,
  текст «Привет! Чем могу помочь?»); сессия создана, `id=<uuid>`
  пришёл именно в `data.biz_data.chat_session.id` — схема верна.
- **Связанные:** KI-003, DESIGN § 6.3, CHANGELOG 0.3.0

---

### KI-1016 — SSRF: `http(s)` image_url скачивается без allowlist (Open)
- **Приоритет:** 🟠 High | **Статус:** Open | **Обнаружено:** 2026-10-20
- **Файлы:** `src/api/completions.ts` (скачивание `image_url` c `http(s)`)
- **Описание:** При `content: [{type:"image_url", image_url:{url:"http://..."}}]`
  шлюз делает `fetch(url)` и загружает байты в DeepSeek. Есть лимиты (10 МиБ,
  15 с, только `image/*`), но нет allowlist и запрета приватных IP/`localhost`.
  Шлюз слушает loopback — прямой доступ извне ограничен, но запрос DSH может
  прийти с произвольным URL (в т.ч. при использовании шлюза другим клиентом
  на той же машине).
- **Влияние:** утечка ответов внутренних сервисов в DeepSeek; возможен SSRF
  в локальную сеть при неаккуратном клиенте.
- **План:** allowlist доменов (по умолчанию пуст → только `data:`),
  блокировка RFC1918/loopback/link-local после DNS-резолва, либо отдельный
  флаг `ALLOW_REMOTE_IMAGES=0|1` (по умолчанию 0). Решение зафиксировать в
  DESIGN § 6.3.
- **Обходной путь:** использовать `data:base64` (не триггерит сеть).
- **Связанные:** KI-1003, DESIGN § 6.3, RULES § 5.4

---

## v0.3.0 — Prompt Builder (2026-10-19)

KI-016 закрыт: структура `POST /api/v0/chat_session/create` подтверждена
живым e2e 2026-10-19 (сессия `id=<uuid>`, поток `users/current` →
`chat_session/create` → `create_pow_challenge` → PoW → `/chat/completion`
→ `[8] E2E OK`). Добавлен слой L2: `src/translate/prompt.ts` (Prompt
Builder) и `src/translate/types.ts`; оставшиеся KI-005/KI-006 относятся к
DSML-парсеру и SSE-writer (Этапы 5–6).

---

## Правила ведения

### 1. Нумерация

1. Номер `KI-XXX` присваивается один раз и **никогда не переиспользуется**,
   даже если запись закрыта или признана неактуальной.
2. Пропуски в нумерации допустимы: номера выдаются по порядку обнаружения,
   но при удалении/переносе черновика дырки не заполняются.
3. Записи не удаляются из реестра. Вместо удаления используется статус
   `Won't Fix` (с обоснованием) или `Deferred` (с условиями пересмотра).
4. Номер не привязан к релизу и не меняется при переносе проблемы между
   версиями; принадлежность к релизу задаётся секцией `## vX.Y.Z`.

### 2. Статусы и переходы

| Статус | Значение | Как переводится |
|---|---|---|
| **Open** | Проблема подтверждена, работа не начата | при обнаружении |
| **In Progress** | Есть исполнитель и активная работа | назначение ответственного |
| **Fixed** | Исправлено и проверено | точечный diff + тест/проверка + CHANGELOG |
| **Documented** | Ограничение известно и задокументировано; обход описан | решение команды |
| **Deferred** | Отложено осознанно, зафиксированы причина и триггер пересмотра | решение команды |
| **Won't Fix** | Исправлять не будем; зафиксировано обоснование | решение команды |

- `Open → In Progress → Fixed` — основной путь.
- `Fixed` без проверки (тест или ручной сценарий) недопустим.
- `Deferred` и `Won't Fix` обязаны содержать причину и дату/условие
  пересмотра; «просто забыли» — не Deferred.
- Возврат `Fixed → Open` (регрессия) допускается с новой датой обнаружения
  в описании; номер KI при этом сохраняется.

### 3. Обязательные поля записи

- **Приоритет** — один из четырёх уровней: 🔴 Critical / 🟠 High /
  🟡 Medium / 🟢 Low.
- **Статус** — строго одно из значений таблицы выше.
- **Обнаружено** — дата в формате `YYYY-MM-DD`.
- **Файлы** — пути относительно корня репозитория; `—`, если файлов нет.
- **Описание** — суть проблемы, симптом, воспроизводимость; без «воды».
- **Связанные** — номера KI, этапы DESIGN, issue/PR; `—`, если связей нет.

Дополнительные поля (`Влияние`, `План`, `Обходной путь`) приветствуются:
они попадают в GitHub Issue как есть (см. [KI_GITHUB_SYNC.md](KI_GITHUB_SYNC.md)).

### 4. Приоритеты

| Приоритет | Критерий | Реакция |
|---|---|---|
| 🔴 Critical | Блокирует заявленную функцию целиком; риск `UNKNOWN_TOOL`, потери данных, утечки секретов | немедленно, блокирует релиз |
| 🟠 High | Ломает основной сценарий или делает его неполным | до ближайшего релиза |
| 🟡 Medium | Мешает, но есть обходной путь; технический долг | в плановом порядке |
| 🟢 Low | Косметика, удобство, документация | по возможности |

### 5. Создание, закрытие и связь с CHANGELOG

1. При обнаружении проблемы сначала создаётся запись KI (тем же коммитом,
   если проблема найдена при разработке), затем — фикс.
2. **Закрытие KI = точечный diff + запись в `docs/CHANGELOG.md` + смена
   статуса в этом файле.** Массовые «заодно» правки не допускаются.
3. Для `Fixed` указываются ссылка на коммит/PR и способ проверки (тест или
   шаги ручного воспроизведения).
4. Если KI закрывается в составе релиза, запись в CHANGELOG делается в
   разделе этого релиза; для Critical/High — отдельной строкой в `Fixed`.
5. Закрытая запись остаётся в реестре под своей версией — история не
   переписывается.

### 6. Синхронизация с GitHub

- Источник истины — этот файл; GitHub Issues — только зеркало.
- Синхронизация односторонняя: `docs/KNOWN_ISSUES.md` → Issues
  (дизайн: [KI_GITHUB_SYNC.md](KI_GITHUB_SYNC.md)).
- Правки в Issue вручную будут перезаписаны при следующем запуске скрипта;
  обсуждать проблему нужно в Issue, а фиксировать изменения — в реестре.

### 7. Шаблон для копирования

```markdown
### KI-XXX — Название (Open)
- **Приоритет:** 🟡 Medium | **Статус:** Open | **Обнаружено:** YYYY-MM-DD
- **Файлы:** `path/to/file.ts`
- **Описание:** Что происходит, как воспроизвести, чего ожидали.
- **Влияние:** Что ломается у пользователя/в CI.
- **План:** Что сделать и на каком этапе.
- **Обходной путь:** Как жить до исправления (или «отсутствует»).
- **Связанные:** KI-YYY
```

### 8. История изменений реестра

| Версия | Дата | Изменение |
|---|---|---|
| 0.1.0 | 2026-10-19 | Создан реестр: KI-001 (шаблон) и KI-002–KI-011 по итогам scaffold-релиза; KI-011 закрыт в день обнаружения (добавлен `LICENSE`) |
| 0.1.1 | 2026-10-19 | KI-008 и KI-009 переведены в Fixed (`.oxlintrc.json`, `--env-file=.env`); добавлен KI-012 (`--env-file` требует файла) |
| 0.1.2 | 2026-10-19 | KI-012 переведён в Fixed (`--env-file-if-exists=.env`); добавлена структура `docs/captures/` для Этапа 0 |
| 0.1.3 | 2026-10-19 | Зафиксированы захваты DeepSeek; добавлен KI-013 (WAF-заголовки не отправляются); DESIGN обновлён по реальному формату JSON Patch |
| 0.2.0 | 2026-10-19 | KI-003 (webauth) и KI-004 (клиент+PoW) → Fixed; KI-013 → Won't Fix (WAF не обязателен); добавлены KI-014 (PoW ~570 мс), KI-015 (CDP reuse) и KI-016 (нет захвата chat_session/create); 34→53 теста |
| 0.3.0 | 2026-10-19 | KI-016 → Fixed (живой e2e подтвердил структуру `chat_session/create`); добавлен Prompt Builder (`src/translate/`), тестов 66 |
| 0.3.1 | 2026-10-20 | Добавлен non-streaming DSML-парсер (`src/translate/dsml-parser.ts`), тестов 84; новых KI нет |
| 0.4.0 | 2026-10-20 | `POST /v1/chat/completions` (non-streaming): Zod, сборка текста, DSML → `tool_calls`; KI-002 остаётся Open из-за `stream:true`; тестов 99 |
| 0.5.0 | 2026-10-20 | K2: `stream:true` + `writeOpenAiSse`; KI-002/KI-005/KI-006 → Fixed; живой e2e DSH ↔ шлюз подтверждён (bash через tool_calls), KI-007 → Fixed; тестов 107 |
| 0.5.1 | 2026-10-20 | Fallback пустого `content` после tool-результата + инструкция в prompt; 110 тестов; KI-007 остаётся Fixed |
| 0.5.2 | 2026-10-20 | Мета-инструкция: использовать `bash` для нестандартных задач (мышь/буфер/скриншоты); 111 тестов |
| 0.5.3 | 2026-10-20 | Few-shot пример вызова `bash` (pyautogui) для системных задач; 112 тестов |
| 0.5.4 | 2026-10-20 | Очистка `text` от остатков DSML (закрывающие маркеры, незакрытые invoke); 114 тестов |
| 0.5.5 | 2026-10-20 | Инструкция для файловых результатов (отвечать путём к файлу); 115 тестов |
| 0.5.6 | 2026-10-20 | cwd awareness в Prompt Builder (`pwd`/`cd`, не предполагать корень); 116 тестов |
| 0.5.7 | 2026-10-20 | Инструкция показывать вывод инструментов (`pwd`/`ls`/`cat`), не отвечать «Готово»; 117 тестов |
| 0.6.0-alpha | 2026-10-20 | S1/S2 Vision: few-shot скриншота через PowerShell и OCR через `tesseract` (полный путь + `where tesseract`); fallback показывает последний tool-результат; 123 теста |

---

## Backlog (Planned/In Progress/Fixed/Done/Deferred)

Идеи развития из [ROADMAP.md](ROADMAP.md). Это **не активные дефекты**:
они не входят в сводку выше и не блокируют релизы. При старте работы над
пунктом создаётся обычный KI с техническими деталями, а запись здесь
переводится в `In Progress`/`Done`.

| ID | Roadmap | Приоритет | Статус | Кратко |
|---|---|---|---|---|
| KI-1001 | R-06-01 | 🔴 Critical | Done | OCR (Tesseract) через `bash` — реализован в 0.6.0-alpha (S2: few-shot, полный путь + `where tesseract`) |
| KI-1002 | R-06-02 | 🟠 High | Planned | Локальная vision-модель (Ollama/LLaVA) — описание сцены |
| KI-1003 | R-06-03 | 🟡 Medium | Fixed | Изображения в DeepSeek Web: `upload_file` + `ref_file_ids` при `model_type: default` (S3, 0.6.0-alpha) — детали ниже |
| KI-1004 | R-06-04 | 🟠 High | In Progress | Инструмент `screenshot` (обёртка `screenshot-desktop`, base64 + путь) |
| KI-1005 | R-07-01 | 🟠 High | Planned | PoW через `worker_threads` — цель ~150 мс вместо ~500 мс |
| KI-1006 | R-07-02 | 🟠 High | Planned | Инкрементальный streaming DSML — первый SSE-чанк без полной буферизации |
| KI-1007 | R-07-03 | 🟠 High | Planned | Ротация/пересоздание `chat_session_id` при 401 без ручного `webauth` |
| KI-1008 | R-07-04 | 🟡 Medium | Planned | Мультиаккаунтность: несколько `auth.json`, балансировка |
| KI-1009 | R-08-01 | 🟡 Medium | Planned | Публикация в npm (`npx ai-dsh-bridge`) |
| KI-1010 | R-08-02 | 🟡 Medium | Planned | Docker-образ (`docker run -p 3456:3456`) |
| KI-1011 | R-08-03 | 🟡 Medium | Planned | Поддержка `deepseek-web-reasoner` без обрезки по токенам |
| KI-1012 | R-08-04 | 🟡 Medium | Planned | Метрики и OTel: токены, время, PoW, tool_calls |
| KI-1013 | R-09-01 | 🟢 Low | Deferred | CDP-fallback, если прямые HTTP перестанут работать из-за WAF |
| KI-1014 | R-09-02 | 🟢 Low | Deferred | Автообновление PoW-алгоритма при смене `DeepSeekHashV1` |
| KI-1015 | R-09-03 | 🟢 Low | Deferred | Web UI настройки вместо `pnpm webauth` |

### KI-1003 — как закрыт (S3, 2026-10-20)

Захваты: `docs/captures/upload-file-2026-10-20.http`,
`docs/captures/chat-completion-vision-2026-10-20.http` (локальные, вне git).

- `POST /api/v0/file/upload_file` — `multipart/form-data`, единственное поле
  `file` (`filename`, `Content-Type: image/png`); заголовки `x-file-size`,
  `x-model-type: default`, `x-thinking-enabled: 0`; PoW под
  `target_path=/api/v0/file/upload_file`. Полей `purpose`/`expires_after`
  в текущем web-клиенте нет.
- `GET /api/v0/file/fetch_files?file_ids=<id>` — опрос статуса до
  `SUCCESS` (PENDING → SUCCESS, таймаут ожидания 30 с); терминальные статусы
  (`FAILED`, `CONTENT_FILTER`, …) — ошибка upstream.
- `POST /api/v0/chat/completion` — `ref_file_ids: ["file-…"]`,
  `model_type: "default"` (не `"vision"`/не `null`); `fork_file_task` при
  загрузке изображения не вызывается.
- Реализация: `uploadFileAsync`/`fetchFilesAsync` (`src/deepseek/client.ts`),
  извлечение `image_url` и загрузка в `src/api/completions.ts`; Prompt Builder
  собирает только текст (`src/translate/prompt.ts`).
