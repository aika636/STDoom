# Устройство STDoom

UI-расширение SillyTavern: оригинальный DOS-DOOM 1993 в окне поверх чата, эмулятор DOSBox (WebAssembly)
из пакета `emulators` 8.4.1. Общие ограничения ST-расширений (без сборки, `getContext()`, fail soft,
мобильная версия, фон) — `~/src/docs/st-extensions.md`. Инварианты, которые легко «починить» обратно, —
[rules-emulator.md](rules-emulator.md) и [input.md](input.md). Содержимое бандла и конфигов —
[bundle.md](bundle.md). Лицензии — [legal.md](legal.md).

Границы: LLM не участвует (`ctx.chat` не читается и не пишется); мультиплеера нет (нужен внешний сервер,
расширение полностью офлайн); универсального «запусти любую DOS-игру» нет — один WAD, одна игра, своим
может быть только IWAD игрока; свободного взгляда мышью нет (его нет в оригинале); `hand_savestate` не
используется — сохранение штатное, через F2/F3 в игре и `ci.persist()`.

## Модули

```
index.js              точка входа: кнопка в wand-меню, слэш-команда /doom
style.css             стили с префиксом .stdoom-
src/ctx.js            getContext(), хелпер событий, toast
src/log.js            логи [STDoom], warnOnce
src/settings.js       extensionSettings.STDoom: замороженные дефолты, мерж при чтении
src/shell/            launcher (wand-меню, слэш-команда), modal (попап и жизненный цикл),
                      settings-panel (секция настроек внутри окна), debug-overlay, touch-overlay
src/dos/              loader (загрузка emulators.js), runtime (запуск ci, exit, persist),
                      session (склейка окна и эмулятора), render (WebGL), audio (гейн, проба частоты),
                      config (генераторы dosbox.conf и DEFAULT.CFG), keys (GLFW-коды), autosave,
                      storage (IndexedDB), iwad (разбор WAD), md5, zip (писатель STORE)
src/input/            keyboard, mouse, touch-layout (чистая геометрия), touch, gamepad-math, gamepad, key-bus
assets/jsdos, assets/doom   бинарники и бандл (см. bundle.md, assets/README.md)
tools/                build-bundle.mjs (офлайн-сборка doom.zip), verify-assets.mjs (хеши)
sandbox/              стенд без таверны: phase0.html + serve.mjs без CSP-заголовков
tests/                dos/, input/, shell/ (node + jsdom), e2e/ (Playwright в живой таверне)
```

Чистая математика (раскладка тача, геймпад, MD5, ZIP, разбор WAD, взвод автосохранения) вынесена в
модули без DOM и гоняется под node.

## Загрузка эмулятора

Берётся низкоуровневый пакет `emulators`, а не плеер `js-dos.js`: в плеере захардкожены домены (облачные
сейвы, sockdrive, аккаунт) и свой UI, а `emulators` не ходит в сеть — только за `wdosbox.js` и
`wdosbox.wasm` по своему `pathPrefix`. Цена: рендер, звук и клавиши пишутся самостоятельно.

`emulators.js` — UMD-бандл, рассчитанный на `<script>`, внутри делает `eval` glue-кода. `dos/loader.js`
вставляет `<script src>`, ждёт `onload`, читает `window.emulators`, кэширует промис,
`pathPrefix` задаёт от `import.meta.url`. CSP SillyTavern (проверено на 1.18.0) `eval`, Worker из `blob:`,
wasm и `AudioWorklet` не запрещает; `.wasm` тянется через XHR и `WebAssembly.compile`, MIME не важен.

Бэкенд — `dosboxWorker` (эмуляция в Web Worker). `dosboxDirect` конкурирует с UI таверны за поток;
`dosboxWorker` + `OffscreenCanvas` — аварийный рычаг, но отнимает контроль над картинкой (`onFrame` не
вызывается). Динамического ядра (`core=dynamic`) в сборке нет — только интерпретатор.

## Рендер

WebGL: полноэкранный quad, текстура `gl.RGB/UNSIGNED_BYTE` (кадр — RGB, `rgba` всегда `null`). Кадры
коалесцируются через `requestAnimationFrame` (это же лимитер частоты). Буфер кадра в `emulators`
переиспользуется, поэтому `pushFrame` копирует кадр в свой буфер (правило 41). Размер подхватывается
вручную сразу после подписки на `onFrameSize`. Backing store равен 320×200, до размера окна картинку
тянет CSS (`image-rendering: pixelated`), 4:3 и леттербокс считаются в JS (правило 17). Сглаживание
включать в CSS, а не в параметрах текстуры. Экран отказа появляется после серии ошибок кадра или
сразу при потере контекста WebGL (правила 30, 46–48).

## Звук

`audioWorklet: true`: `emulators` сам создаёт `AudioContext` на 44100 Гц и гонит сэмплы из wasm в
AudioWorklet. Следствия: `ci.soundFrequency()` возвращает 0, `onSoundPush` не вызывается (правило 5).
Музыка — эмулируемый OPL, инструменты (`GENMIDI`) лежат в самом WAD, MIDI-синтезатор не нужен. Громкость
у эмулятора не регулируется (только `mute`/`unmute`), поэтому ползунок — свой `GainNode`, вставляемый
хуком `installGainHook()` (правила 53–54). Пробу частоты (`probeSampleRate`) нужно делать так же, как
запрашивает js-dos: явно `sampleRate: 44100`; контекст по умолчанию покажет частоту железа и даст ложную
тревогу. Своего `resume()` нет: эмулятор стартует только по жесту игрока (кнопка «Играть»).

## Производительность

Работа на интерпретаторе; признак перекрута `cycles` — не падение fps, а заикания и выпадения звука
(SB-DMA не успевает). Старт `cycles = 20000` (на настольном Chromium около 24 кадров/с при потолке игры
35); около 35000 хватает с запасом. Рычаги по возрастанию потери качества: смена циклов на лету
(`ci.sendBackendEvent({type:'wc-trigger-event', event:'cycles:NNNNN'})`, диапазон 3000…1 000 000,
перезапуск не нужен), `frame_skip`, низкая детализация в игре (`detaillevel 1`), меньший `screenblocks`,
`OffscreenCanvas`. `ci.asyncifyStats()` отдаёт `cpuMetrics` для отладочного оверлея (настройка
`debugOverlay`).

## Сохранение прогресса

`ci.persist(true)` отдаёт ZIP с изменёнными файлами `/home/web_user` (сейвы и перезаписанный
`DEFAULT.CFG`). Хранится в IndexedDB (в `extensionSettings` только настройки: `cycles`, `sound`, `volume`,
`mouseSensitivity`, `touchControls`, `touchLayout`, `debugOverlay`). Сохранение: при закрытии окна, по
`visibilitychange`, и событийно по F2/F6/F10 (`dos/autosave.js`, правила 38, 39, 49). В `stop()` порядок
жёсткий: `persist()`, затем флаг, затем `ci.exit()` — иначе `persist()` молча возвращает `false`.
Порядок `InitFs` при запуске: бандл, свои файлы игрока (IWAD, `DOOM.EXE`), сейвы, строка конфига последней.

## Окно

Попап ST открывается с `allowEscapeClose: false`, `wider` и `large`; закрытие — экранной кнопкой с
подтверждением, если игра запущена; второе окно не открывается. Панель настроек — выдвижная секция внутри
окна (не страница настроек ST и не второй попап: они перехватили бы ввод), содержит справку по
управлению. Аттракт-режим оставлен аутентичным: `DOOM.EXE` запускается без параметров.

## Известные ограничения

- Планшет и геймпад на реальных устройствах не проверялись; на телефоне запускается и управляется, но
  играть тесно, а экран не поворачивается в альбомную ориентацию (нужен Fullscreen API, поведение попапа
  ST в нём непредсказуемо).
- F5, F11, F12 браузер до игры не доводит (перезагрузка, полный экран, инструменты); гамма и шпионская
  камера в игре недоступны.
- Сейвы общие на все IWAD: сохранения shareware видны в слотах коммерческого.
- Раскладка WASD + стрелки-поворот не даёт ходить стрелками (в ванили одна клавиша на действие), поэтому
  справка в панели — часть раскладки.
