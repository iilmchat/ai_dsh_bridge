# Чек-лист релиза AI DSH Bridge

**Версия документа:** 1.0
**Дата:** 2026-10-19
**Первый релиз по этому чек-листу:** v0.1.0 (2026-10-19)

Документ описывает обязательную процедуру выпуска версии: от заморозки
состава до проверки после публикации и отката. Все команды выполняются в
**PowerShell 7 (pwsh)** из корня репозитория. Пример использует текущую
версию `0.5.4`; для следующих релизов меняется только значение `$Version`.

```powershell
$Version   = '0.5.4'                       # SemVer без префикса v
$Tag       = "v$Version"
$RepoRoot  = (Get-Location).Path           # запуск из корня репозитория
Set-Location $RepoRoot
```

> Важно: релиз не выпускается при открытом KI с приоритетом 🔴 Critical,
> который относится к функциональности этого релиза. Для v0.1.0 KI-005
> относится к будущим этапам 4–5 и не блокирует публикацию каркаса —
> исключение фиксируется в release notes.

---

## 1. Подготовка

- [ ] Состав релиза зафиксирован: milestone/список PR и issue закрыты,
      в CHANGELOG есть запись для версии.
- [ ] CI на `main` зелёный (все обязательные workflow).
- [ ] Рабочее дерево чистое; локальные ветки не «висят» с несохранённой
      работой.
- [ ] Реестр известных проблем актуален: нет забытых статусов, для каждого
      Fixed есть ссылка на проверку.
- [ ] Создана release-ветка.

```powershell
# 1.1. Проверка чистого дерева и текущей ветки
$dirty = git status --porcelain
if ($dirty) { throw "Рабочее дерево не чистое:`n$dirty" }
Write-Host "Текущая ветка: $(git rev-parse --abbrev-ref HEAD)"

# 1.2. Статус последних CI-прогонов (GitHub CLI должен быть авторизован)
gh auth status
gh run list --branch main --limit 5

# 1.3. Создание release-ветки
git fetch origin
git switch main
git pull --ff-only
git switch -c "release/v$Version"
```

Если `gh run list` показывает красный прогон — релиз останавливается до
исправления; «дожать руками» нельзя.

## 2. Код

Порядок обязателен: сначала установка зависимостей по lock-файлу, затем
проверки, затем сборка. Каждый шаг должен завершиться с кодом 0.

- [ ] `pnpm install --frozen-lockfile` — без обновления lock-файла.
- [ ] `pnpm lint` — без ошибок (oxlint, type-aware).
- [ ] `pnpm typecheck` — `tsc --noEmit`, без ошибок.
- [ ] `pnpm test` — зелёный; тестовые файлы существуют (сейчас 9 suite,
      включая SSE-контракт `api-completions-stream.test.ts`).
- [ ] `pnpm build` — без ошибок и **без warning-ов** TypeScript.
- [ ] Smoke-проверка запущенного фасада (§ 2.5).

```powershell
# 2.1. Установка строго по lock-файлу
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install --frozen-lockfile failed' }

# 2.2. Все проверки качества
foreach ($step in 'lint', 'typecheck', 'test', 'build') {
    Write-Host "=== pnpm $step ===" -ForegroundColor Cyan
    & pnpm $step
    if ($LASTEXITCODE -ne 0) { throw "pnpm $step завершился с кодом $LASTEXITCODE" }
}

# 2.3. Сборка без warning-ов (лог сохраняется для разбора)
$buildLog = Join-Path $env:TEMP "ai-dsh-bridge-build-$Version.log"
pnpm build 2>&1 | Tee-Object -FilePath $buildLog
if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }
$warnings = @(Select-String -Path $buildLog -Pattern 'warning TS\d+')
if ($warnings.Count -gt 0) {
    $warnings | ForEach-Object { Write-Host $_.Line -ForegroundColor Yellow }
    throw "pnpm build: $($warnings.Count) warning(s)"
}

# 2.4. Проверка, что тесты действительно существуют.
# С 0.5.0 в test/ есть 9 suite; если файлов нет — это регрессия, релиз
# блокируется (зелёный прогон с --passWithNoTests ничего не доказывает).
$testFiles = @(Get-ChildItem test -Filter '*.test.ts' -File -ErrorAction SilentlyContinue)
if ($testFiles.Count -eq 0) {
    Write-Warning 'В test/ нет *.test.ts — тестовое покрытие отсутствует, релиз блокируется'
} else {
    Write-Host "Найдено тестовых файлов: $($testFiles.Count)"
}
```

Smoke-проверка собранного приложения (перед тегом):

```powershell
# 2.5. Запуск dist/index.js и проверка эндпоинтов
$env:PORT = '3456'
$server = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -PassThru -WindowStyle Hidden
try {
    Start-Sleep -Seconds 2
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3456/health'
    $models = Invoke-RestMethod -Uri 'http://127.0.0.1:3456/v1/models'
    if ($health.status -ne 'ok') { throw 'GET /health вернул не ok' }
    if ($models.object -ne 'list') { throw 'GET /v1/models вернул не list' }
    Write-Host "health: $($health | ConvertTo-Json -Compress)"
    Write-Host "models: $($models.data.id -join ', ')"

    # POST /v1/chat/completions на v0.1.0 обязан отвечать 501 (KI-002)
    try {
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3456/v1/chat/completions' `
            -ContentType 'application/json' `
            -Body '{"model":"deepseek-web-chat","messages":[{"role":"user","content":"ping"}]}'
        Write-Warning 'Ожидался HTTP 501, но запрос завершился успешно'
    } catch {
        $status = [int]$_.Exception.Response.StatusCode
        Write-Host "POST /v1/chat/completions: HTTP $status (ожидается 501)"
        if ($status -ne 501) { throw "Неожиданный статус: $status" }
    }
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\PORT -ErrorAction SilentlyContinue
}
```

## 3. Документация

- [ ] `README.md` — статус, быстрый старт, ссылки на docs, ограничения
      scaffold-версии.
- [ ] `docs/GETTING_STARTED.md` — соответствует фактическим скриптам и
      переменным окружения.
- [ ] `docs/DESIGN.md` — архитектура и этапы не противоречат коду; статус
      «Draft» обновлён при необходимости.
- [ ] `docs/CHANGELOG.md` — есть раздел `[X.Y.Z] — YYYY-MM-DD`, все изменения
      перечислены, пустых разделов нет.
- [ ] `docs/KNOWN_ISSUES.md` — сводка и статусы совпадают; закрытые KI имеют
      точечный diff и запись в CHANGELOG.
- [ ] `docs/PROMPT_CURRENT.md` — версия, статус и число Open KI актуальны.
- [ ] `docs/RELEASES.md` — этот чек-лист не устарел.
- [ ] Ссылки в Markdown не битые.

```powershell
# 3.1. Проверка обязательных документов
$required = @(
    'README.md',
    'docs/GETTING_STARTED.md',
    'docs/DESIGN.md',
    'docs/CHANGELOG.md',
    'docs/KNOWN_ISSUES.md',
    'docs/PROMPT_CURRENT.md',
    'docs/RELEASES.md'
)
foreach ($doc in $required) {
    if (-not (Test-Path $doc)) { throw "Отсутствует обязательный документ: $doc" }
}

# 3.2. Проверка относительных ссылок README и docs/*.md
$markdownFiles = @('README.md') + @(Get-ChildItem docs -Filter '*.md' -File | ForEach-Object { $_.FullName })
foreach ($file in $markdownFiles) {
    $text = Get-Content -LiteralPath $file -Raw
    foreach ($m in [regex]::Matches($text, '\]\(([^)#]+?)(#[^)]*)?\)')) {
        $target = $m.Groups[1].Value
        if ($target -match '^(https?:|mailto:)') { continue }
        $resolved = Join-Path (Split-Path -Parent $file) $target
        if (-not (Test-Path $resolved)) {
            Write-Warning "Битая ссылка в $(Split-Path -Leaf $file): $target"
        }
    }
}

# 3.3. Контроль свежести версии в CHANGELOG
$changelog = Get-Content docs/CHANGELOG.md -Raw
$escape = [regex]::Escape("## [$Version] — ")
if ($changelog -notmatch $escape) { throw "В CHANGELOG нет раздела ## [$Version]" }
```

Битые ссылки — блокер релиза, если ссылка ведёт на обязательный документ.
Исторический пример: KI-011 — ссылка `[MIT](LICENSE)` при отсутствующем файле
`LICENSE` (в 0.1.0 закрыт добавлением файла; регрессию ловит проверка § 3.2).

## 4. Версия

- [ ] `version` в `package.json` равна `$Version`.
- [ ] `## [X.Y.Z] — YYYY-MM-DD` в CHANGELOG (дата в ISO, без времени).
- [ ] `APP_VERSION` в `src/index.ts` синхронизирован с `package.json`.
- [ ] Бейдж версии в README обновлён (если используется; сейчас бейджа нет).
- [ ] Версия упомянута в release notes; номер не «прыгает» между файлами.

```powershell
# 4.1. Сверка версии в package.json, src/index.ts и CHANGELOG
$ReleaseDate = '2026-10-19'
$pkgVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($pkgVersion -ne $Version) { throw "package.json: $pkgVersion, ожидается $Version" }

$appMatch = Select-String -Path src/index.ts -Pattern "APP_VERSION\s*=\s*'([^']+)'"
if (-not $appMatch) { throw 'APP_VERSION не найден в src/index.ts' }
$appVersion = $appMatch.Matches[0].Groups[1].Value
if ($appVersion -ne $Version) { throw "src/index.ts: APP_VERSION=$appVersion, ожидается $Version" }

$changelog = Get-Content docs/CHANGELOG.md -Raw
if ($changelog -notmatch [regex]::Escape("## [$Version] — $ReleaseDate")) {
    throw "CHANGELOG: нет раздела ## [$Version] — $ReleaseDate"
}

# 4.2. Коммит подготовки релиза
git add -A
git diff --cached --stat
git commit -m "chore(release): v$Version"
if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
```

Правило SemVer для 0.x: ломающие изменения допускаются в минорной версии,
обратно совместимые доработки — в патче. Пометка «scaffold» снимается после
реализации Этапов 2–8.

## 5. Тег и Release Notes

- [ ] Release-ветка влита в `main` (или, при trunk-based, коммит в `main`).
- [ ] Аннотированный тег создан на коммите из `main`.
- [ ] Тег запушен; GitHub Release создан из тега.
- [ ] Release notes содержат: состав, ограничения, Open KI, порядок установки.

```powershell
# 5.1. Вливание release-ветки
git switch main
git pull --ff-only
git merge --no-ff "release/v$Version" -m "merge: release v$Version"
git push origin main

# 5.2. Аннотированный тег
git tag -a $Tag -m "AI DSH Bridge $Tag"
git show $Tag --stat
git push origin $Tag
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запушить тег' }

# 5.3. Публикация GitHub Release
gh release create $Tag --title "AI DSH Bridge v$Version" --generate-notes --verify-tag
```

Шаблон release notes (заполняется вручную, если `--generate-notes` не
подходит):

```markdown
## AI DSH Bridge v0.1.0 — scaffold (2026-10-19)

### Что есть
- Минимальный Fastify-фасад: GET /health, GET /v1/models,
  POST /v1/chat/completions (заглушка 501).
- Документация: DESIGN, ARCHITECTURE, GETTING_STARTED, RULES, CHANGELOG,
  KNOWN_ISSUES, RELEASES, KI_GITHUB_SYNC, api-contract.

### Чего пока нет (Planned)
- webauth, клиент DeepSeek с PoW, DSML-парсер/SSE, тесты, синхронизация KI.

### Установка
    pnpm install
    pnpm build
    pnpm start        # http://127.0.0.1:3456

### Известные проблемы
- См. docs/KNOWN_ISSUES.md: KI-001…KI-011.
```

## 6. После релиза

- [ ] CI на теге завершился зелёным.
- [ ] GitHub Release опубликован (не draft, не prerelease — если это не
      намеренно).
- [ ] Smoke-проверка развёрнутого/локального экземпляра по чек-листу § 2.4.
- [ ] В CHANGELOG открыт пустой раздел `[Unreleased]` для следующих работ.
- [ ] Проведена синхронизация KI (при наличии скрипта; пока — вручную,
      см. KI_GITHUB_SYNC.md / KI-010).
- [ ] Анонс: issue/Discussion в репозитории, отметка в DSH (если требуется).

```powershell
# 6.1. Прогон CI на теге (ищем runs по SHA тега)
$tagSha = git rev-parse $Tag
gh run list --commit $tagSha --limit 5
# При необходимости — дождаться конкретного прогона:
# gh run watch <run-id>

# 6.2. Проверка опубликованного релиза
gh release view $Tag --json tagName,isDraft,isPrerelease,publishedAt

# 6.3. Контрольная smoke-проверка
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3456/health'
$models = Invoke-RestMethod -Uri 'http://127.0.0.1:3456/v1/models'
Write-Host "Версия: $($health.version); моделей: $($models.data.Count)"

# 6.4. Новый цикл разработки: пустой раздел Unreleased
# (правится в docs/CHANGELOG.md, затем коммит)
git switch -c "chore/post-release-v$Version"
# ... добавить "## [Unreleased]" с пустыми подразделами ...
git commit -am "docs(changelog): open Unreleased after v$Version"
```

## Откат

Откат выполняется по уровню: чем дальше зашёл релиз, тем дороже откат.
Запрещено переписывать `main` через `git push --force`; допустим только
`--force-with-lease` и только для release-ветки/тега.

### A. Кандидат не прошёл проверки (§§ 1–4), тег не создан

```powershell
# Вернуться на main и удалить локальную release-ветку
git switch main
git branch -D "release/v$Version"        # удаляет только локальную ветку
# Рабочие изменения, если они уже закоммичены в release-ветку, остаются в истории;
# при необходимости перенести нужные коммиты через git cherry-pick.
```

Риск минимален: ничего не опубликовано. Обязательно записать причину отката
в release issue.

### B. Тег создан локально, но не запушен

```powershell
git tag -d $Tag
```

Проверить, что тег не ушёл: `git ls-remote --tags origin $Tag` не должен
ничего вернуть.

### C. Тег и GitHub Release опубликованы, обнаружен дефект

```powershell
# 1. Удалить GitHub Release и тег (осознанно, с уведомлением пользователей)
gh release delete $Tag --yes
git push origin ":refs/tags/$Tag"       # удаление тега в origin
git tag -d $Tag

# 2. Исправить дефект в main
git switch main
git pull --ff-only
# ... коммит с фиксом ...
git push origin main

# 3. Выпустить patch-версию по этому же чек-листу
```

Если тег уже начали использовать пользователи — вместо удаления
предпочтителен **fix-forward**: revert проблемного коммита и новый
patch-релиз; удаление тега применять только для явно сломанного релиза.

### D. Проблема найдена на работающем экземпляре

- Остановить сервер (`Ctrl+C` при `pnpm start`, либо остановить процесс Node).
- Аутентификационные данные (`~/.ai-dsh-bridge/auth.json`) не удалять — они
  не относятся к версии кода; откат кода их не затрагивает.
- Вернуть предыдущую стабильную версию:

```powershell
Set-Location $RepoRoot
git fetch --tags
# $PreviousTag — предыдущий известный хороший тег; в самом первом релизе
# (v0.1.0) предыдущего тега нет, поэтому откат сводится к остановке сервиса.
$PreviousTag = 'v0.1.0'   # заменить на тег предыдущего стабильного релиза
git switch --detach $PreviousTag
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

- Зафиксировать инцидент: открыть/переоткрыть KI, указать проблемную версию,
  запись в CHANGELOG (`Unreleased` → строка `Fixed`/`Rolled back`), уведомить
  ответственного за релиз.

### E. Что откатывать нельзя

- Реестр `docs/KNOWN_ISSUES.md` — записи не удаляются, только меняют статус.
- `CHANGELOG.md` — опубликованные разделы не переписываются; исправления
  добавляются новой записью.
- Закрытые KI — не удаляются; регрессия возвращает статус `Open` с тем же
  номером.

## Definition of Done релиза

Релиз считается выпущенным, когда одновременно выполнено:

1. Тег `v$Version` существует в `origin`, на него ссылается GitHub Release.
2. CI на теге зелёный.
3. `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `build`
   прошли без ошибок; сборка без warning-ов.
4. Smoke-проверка `/health`, `/v1/models`, `POST /v1/chat/completions`
   соответствует ожиданиям версии.
5. `CHANGELOG.md` содержит раздел версии с датой; `KNOWN_ISSUES.md`
   актуален; README и docs не противоречат фактическому поведению.
6. Release notes опубликованы, ограничения и Open KI перечислены.
7. Открыт раздел `[Unreleased]` для следующего цикла.

## Ответственность и периодичность

| Роль | Ответственность |
|---|---|
| Release manager | ведёт чек-лист, назначен на релиз, принимает решение об откате |
| Автор изменений | обеспечивает зелёные проверки и запись в CHANGELOG/KNOWN_ISSUES |
| Reviewer | проверяет diff релиза, версии и документацию |
| CI | блокирует релиз при красных проверках |

Релизы 0.x выпускаются по готовности, но не чаще одного раза в неделю;
обязательные patch-релизы — при Critical/High дефектах. Перед любым релизом
чек-лист копируется в release issue и отмечается по пунктам.
