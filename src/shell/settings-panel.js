// Панель настроек (план, Фаза 4).
//
// Панель — выдвижная секция ВНУТРИ .stdoom-frame, а не второй попап таверны. Это
// принципиально: попап ST поверх нашего перехватил бы клики и клавиатуру, то есть
// сломал бы игру ровно в тот момент, когда игрок пытается её настроить (§10 плана,
// строка «попап поверх попапа»).
//
// ⚠ Escape панель НЕ обрабатывает. Он принадлежит DOOM (§4.7), и вешать на него
// закрытие панели нельзя: привыкнув, игрок нажмёт его в игре и получит не меню DOOM,
// а что-то своё. Панель закрывается той же кнопкой «Настройки» и кнопкой «Готово».
//
// Перехват клавиатуры панели не мешает: keyboard.js включается только когда фокус
// стоит на канвасе (§4.7), а фокус в поле панели — это уже не канвас. Поэтому в
// input/select можно спокойно печатать.
//
// Всё, что панель меняет, ложится в extensionSettings.STDoom (src/settings.js).
// Сейвы там не живут и жить не будут — они в IndexedDB (§4.10); кнопка «Сбросить
// прогресс» ходит именно туда, через clearChanges().

import { getCtx, toast } from '../ctx.js';
import { logError } from '../log.js';
import { DEFAULTS, getSettings, normalizeTouchMode, saveSettings } from '../settings.js';
// Из config.js, а не из runtime.js: последний утянул бы в граф импортов окна весь
// слой эмулятора ради одного чистого хелпера (§3.2).
import { CYCLES_MIN, CYCLES_MAX, clampCycles } from '../dos/config.js';
import {
    clearChanges, clearUserFile, loadUserFileMeta, saveUserFile,
} from '../dos/storage.js';
import { formatSize, inspectExe, inspectIwad } from '../dos/iwad.js';

/** Шаг поля циклов: тюнинг идёт тысячами, а не единицами (§4.9). */
export const CYCLES_STEP = 1000;

// Границы нашего собственного множителя дельт мыши. Множители в DEFAULT.CFG и
// dosbox.conf при этом остаются нейтральными и не трогаются (§4.8); в частности,
// mouse_sensitivity ≥ 31 роняет DOOM при заходе в Options.
// Громкость в процентах: 0 — тишина, 100 — как отдаёт игра. Шаг 5 — чтобы ползунок
// брался пальцем и не требовал снайперской точности.
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;
export const VOLUME_STEP = 5;

export function clampVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULTS.volume;
    return Math.round(Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, number)));
}

export const SENSITIVITY_MIN = 0.2;
export const SENSITIVITY_MAX = 3;
export const SENSITIVITY_STEP = 0.1;

/** Кламп чувствительности с округлением до шага — чтобы в настройках не копились хвосты. */
export function clampSensitivity(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULTS.mouseSensitivity;
    const clamped = Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, number));
    return Math.round(clamped * 10) / 10;
}

/**
 * Собирает панель настроек.
 *
 * @param {object} [params]
 * @param {(key: string, value: any) => void} [params.onChange]
 *        Зовётся после того, как значение уже записано в настройки и сохранено.
 *        Применение к живой сессии — забота вызывающего (dos/session.js).
 * @returns {{
 *   element: HTMLElement, open: Function, close: Function, toggle: Function,
 *   refresh: Function, destroy: Function, isOpen: boolean,
 * }}
 */
export function createSettingsPanel({ onChange = null } = {}) {
    const element = document.createElement('section');
    element.className = 'stdoom-settings-panel';
    element.hidden = true;
    element.setAttribute('aria-label', 'Настройки STDoom');

    const title = document.createElement('h3');
    title.className = 'stdoom-panel-title';
    title.textContent = 'Настройки';

    const fields = document.createElement('div');
    fields.className = 'stdoom-panel-fields';

    // --- Циклы DOSBox
    const cycles = document.createElement('input');
    cycles.type = 'number';
    cycles.className = 'stdoom-field stdoom-field-cycles';
    cycles.min = String(CYCLES_MIN);
    cycles.max = String(CYCLES_MAX);
    cycles.step = String(CYCLES_STEP);
    const cyclesRow = makeRow(
        'Циклы DOSBox',
        cycles,
        `${CYCLES_MIN}…${CYCLES_MAX}. Меняются на лету, перезапуск не нужен. `
        + 'Признак перекрута — не падение частоты кадров, а заикания и выпадения звука.',
    );

    // --- Звук
    const sound = document.createElement('input');
    sound.type = 'checkbox';
    sound.className = 'stdoom-field stdoom-field-sound';
    const soundRow = makeCheckRow('Звук', sound, 'То же, что кнопка «Звук» в рамке окна.');

    // --- Громкость
    const volume = document.createElement('input');
    volume.type = 'range';
    volume.className = 'stdoom-field stdoom-field-volume';
    volume.min = String(VOLUME_MIN);
    volume.max = String(VOLUME_MAX);
    volume.step = String(VOLUME_STEP);
    const volumeValue = document.createElement('output');
    volumeValue.className = 'stdoom-field-value stdoom-volume-value';
    const volumeRow = makeRow(
        'Громкость',
        wrap(volume, volumeValue),
        'Меняется на лету и сохраняется. Регулятора громкости у DOSBox нет — это '
        + 'наш собственный, поверх звука игры; её внутренние ползунки в Options '
        + 'работают независимо.',
    );

    // --- Чувствительность мыши
    const sensitivity = document.createElement('input');
    sensitivity.type = 'range';
    sensitivity.className = 'stdoom-field stdoom-field-sensitivity';
    sensitivity.min = String(SENSITIVITY_MIN);
    sensitivity.max = String(SENSITIVITY_MAX);
    sensitivity.step = String(SENSITIVITY_STEP);
    const sensitivityValue = document.createElement('output');
    sensitivityValue.className = 'stdoom-field-value stdoom-sensitivity-value';
    const sensitivityRow = makeRow(
        'Чувствительность мыши',
        wrap(sensitivity, sensitivityValue),
        'Наш собственный множитель дельт. Применяется сразу, на следующем движении мыши.',
    );

    // --- Тач-контролы
    //
    // Тумблер нужен обеим сторонам: на планшете-«два-в-одном» с клавиатурой авто-режим
    // покажет кнопки поверх картинки тому, кто играет мышью, а на десктопе с сенсорным
    // монитором — наоборот, не покажет тому, кто хочет ими играть.
    const touch = document.createElement('select');
    touch.className = 'stdoom-field stdoom-field-touch';
    for (const [value, label] of [
        ['auto', 'Авто (по наличию сенсора)'],
        ['on', 'Всегда включены'],
        ['off', 'Выключены'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        touch.appendChild(option);
    }
    const touchRow = makeRow(
        'Тач-контролы',
        touch,
        'Виртуальный стик, кнопки огня и свайп-поворот поверх картинки. '
        + 'Применяется сразу, перезапуск не нужен.',
    );

    // --- Отладочный оверлей
    const debug = document.createElement('input');
    debug.type = 'checkbox';
    debug.className = 'stdoom-field stdoom-field-debug';
    const debugRow = makeCheckRow(
        'Отладочный оверлей',
        debug,
        'Показывает cpuMetrics эмулятора поверх картинки.',
    );

    fields.append(cyclesRow, soundRow, volumeRow, sensitivityRow, touchRow, debugRow);

    // --- Свой IWAD (Фаза 6)
    //
    // Коммерческих IWAD в репозитории нет и не будет (§1.2) — их приносит игрок.
    // ⚠ Флага `-iwad` в ванильном DOOM нет (§5.3): WAD подкладывается ФАЙЛОМ под
    // именем, которое движок ищет сам. Имя выводится из содержимого файла
    // (src/dos/iwad.js), а не из того, как файл назван на диске.
    const files = document.createElement('div');
    files.className = 'stdoom-panel-files';

    const filesTitle = document.createElement('h4');
    filesTitle.className = 'stdoom-panel-subtitle';
    filesTitle.textContent = 'Свой IWAD';

    const iwadSlot = makeFileSlot({
        cls: 'iwad',
        label: 'Файл IWAD',
        accept: '.wad,.WAD',
        hint: 'DOOM.WAD, DOOM2.WAD, TNT.WAD, PLUTONIA.WAD — тот файл, что лежит рядом '
            + 'с купленной игрой. Имя внутри DOS расширение подберёт само, по содержимому. '
            + 'PWAD (наборы карт) сюда не годятся.',
    });

    const exeSlot = makeFileSlot({
        cls: 'exe',
        label: 'Свой DOOM.EXE',
        accept: '.exe,.EXE',
        hint: 'Необязательно. В репозитории лежит shareware DOOM.EXE — он рассчитан на '
            + 'DOOM1.WAD. Для коммерческого IWAD, скорее всего, понадобится DOOM.EXE '
            + 'из той же покупки.',
    });

    const filesNote = document.createElement('p');
    filesNote.className = 'stdoom-panel-note stdoom-files-note';
    filesNote.textContent = 'Файлы никуда не отправляются: они лежат в хранилище этого '
        + 'браузера, рядом с сейвами. Замена применится при СЛЕДУЮЩЕМ открытии окна — '
        + 'DOSBox читает игру один раз, при запуске. И учтите: сейвы у DOOM общие, '
        + 'сохранения от другой игры в новом IWAD будут выглядеть мусором.';

    files.append(filesTitle, iwadSlot.root, exeSlot.root, filesNote);

    // --- Действия
    const actions = document.createElement('div');
    actions.className = 'stdoom-panel-actions';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'stdoom-btn stdoom-reset';
    reset.textContent = 'Сбросить прогресс';
    reset.title = 'Удалить сейвы DOOM из хранилища браузера';

    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'stdoom-btn stdoom-panel-done';
    done.textContent = 'Готово';

    actions.append(reset, done);

    const note = document.createElement('p');
    note.className = 'stdoom-panel-note';
    // Честное предупреждение: clearChanges() чистит IndexedDB, но текущая сессия при
    // закрытии окна сохранится заново — её сейвы вернутся (§4.10).
    note.textContent = 'Сброс удаляет сейвы из хранилища браузера. Запущенная игра '
        + 'при закрытии окна сохранится заново, поэтому сбрасывать лучше до старта '
        + 'или сразу закрывать окно после сброса.';

    element.append(title, fields, files, makeControlsHelp(), actions, note);

    let busy = false;
    // Слоты пользовательских файлов заняты чтением/записью по одному: файл на
    // мегабайты читается заметное время, и второй клик по кнопке в этот момент
    // устроил бы гонку за один и тот же ключ хранилища.
    const slotBusy = { iwad: false, exe: false };
    // Поколение чтения хранилища: см. refreshFiles().
    let filesGeneration = 0;

    // --- Чтение и запись

    function read() {
        try {
            return getSettings();
        } catch (err) {
            logError('панель настроек: не удалось прочитать настройки', err);
            return null;
        }
    }

    /** Пишет одно поле и сообщает наружу. Сохранение уже дебаунсится самой таверной. */
    function commit(key, value) {
        const settings = read();
        if (!settings) return;
        settings[key] = value;
        try {
            saveSettings();
        } catch (err) {
            logError('панель настроек: не удалось сохранить настройки', err);
        }
        try {
            onChange?.(key, value);
        } catch (err) {
            logError('панель настроек: обработчик изменения упал', err);
        }
    }

    /**
     * Подтягивает ТОЛЬКО галочку звука. Отдельно от refresh() потому, что звук правят
     * не только отсюда: в рамке окна есть своя кнопка звука, и она обязана двигать
     * галочку следом. Полный refresh() ради этого звать нельзя — он ходит в
     * IndexedDB за сведениями о своих файлах и попутно затирает текст отказа
     * («файл не подошёл: …»), который игрок ещё не успел прочитать.
     */
    function refreshSound() {
        const settings = read() ?? DEFAULTS;
        sound.checked = settings.sound !== false;
    }

    /** Заливает текущие значения в поля. Зовётся при каждом открытии панели. */
    function refresh() {
        const settings = read() ?? DEFAULTS;
        cycles.value = String(clampCycles(settings.cycles));
        sound.checked = settings.sound !== false;
        const vol = clampVolume(settings.volume);
        volume.value = String(vol);
        volumeValue.textContent = `${vol}%`;
        const sens = clampSensitivity(settings.mouseSensitivity);
        sensitivity.value = String(sens);
        sensitivityValue.textContent = formatSensitivity(sens);
        touch.value = normalizeTouchMode(settings.touchControls);
        debug.checked = settings.debugOverlay === true;
        // Сведения о своих файлах лежат в IndexedDB, то есть читаются асинхронно.
        // Ждать их здесь нельзя: refresh() зовётся из open(), и панель должна
        // открыться сразу, а не после похода в базу.
        refreshFiles().catch((err) => logError('панель настроек: чтение своих файлов упало', err));
    }

    /**
     * Подтягивает подписи «что загружено» из хранилища.
     *
     * Счётчик поколений нужен из-за гонки, которую иначе видно только глазами:
     * чтение базы асинхронно, и пока оно идёт, игрок успевает выбрать файл. Ответ
     * базы, пришедший после этого, затёр бы свежую подпись (или текст отказа)
     * устаревшим «не загружен».
     */
    async function refreshFiles() {
        const generation = ++filesGeneration;
        for (const slot of [iwadSlot, exeSlot]) {
            const meta = await loadUserFileMeta(slot.name);
            if (generation !== filesGeneration) return;
            slot.setMeta(meta);
        }
    }

    // --- Обработчики полей
    //
    // Циклы применяем по 'change' (не по каждому нажатию клавиши): каждое изменение
    // уходит в эмулятор отдельным событием, и слать их посимвольно бессмысленно.
    // Чувствительность — наоборот, по 'input': её крутят ползунком и оценивают на ощупь.

    cycles.addEventListener('change', () => {
        const value = clampCycles(cycles.value);
        cycles.value = String(value);
        commit('cycles', value);
    });

    sound.addEventListener('change', () => commit('sound', sound.checked));

    // По 'input', как у чувствительности: громкость крутят на слух и оценивают сразу,
    // а не после отпускания ползунка.
    volume.addEventListener('input', () => {
        const value = clampVolume(volume.value);
        volumeValue.textContent = `${value}%`;
        commit('volume', value);
    });

    sensitivity.addEventListener('input', () => {
        const value = clampSensitivity(sensitivity.value);
        sensitivityValue.textContent = formatSensitivity(value);
        commit('mouseSensitivity', value);
    });

    touch.addEventListener('change', () => {
        const value = normalizeTouchMode(touch.value);
        touch.value = value;
        commit('touchControls', value);
    });

    debug.addEventListener('change', () => commit('debugOverlay', debug.checked));

    reset.addEventListener('click', () => {
        resetProgress().catch((err) => logError('сброс прогресса упал', err));
    });

    // --- Свои файлы: загрузка и удаление

    for (const slot of [iwadSlot, exeSlot]) {
        slot.input.addEventListener('change', () => {
            const file = slot.input.files?.[0] ?? null;
            // Поле очищаем сразу: иначе повторный выбор ТОГО ЖЕ файла не даст события
            // change, и игрок решит, что кнопка сломалась.
            slot.input.value = '';
            if (file) {
                acceptFile(slot, file).catch((err) => {
                    logError('загрузка своего файла упала', err);
                    slot.setError('не удалось прочитать файл — подробности в консоли');
                });
            }
        });

        slot.clear.addEventListener('click', () => {
            removeFile(slot).catch((err) => logError('удаление своего файла упало', err));
        });
    }

    /**
     * Разбирает выбранный файл и кладёт его в хранилище.
     * Ошибка распознавания — это отказ с внятным текстом, а не молчание: игрок должен
     * понять, что именно не так с его файлом.
     */
    async function acceptFile(slot, file) {
        if (slotBusy[slot.name]) return;
        slotBusy[slot.name] = true;
        // Действие игрока свежее любого незавершённого чтения хранилища.
        filesGeneration++;
        slot.setBusy(true);
        try {
            const bytes = new Uint8Array(await readFileBytes(file));
            const info = slot.inspect(bytes, file.name ?? '');
            if (!info.ok) {
                slot.setError(info.error);
                toast('error', `Файл не подошёл: ${info.error}`);
                return;
            }

            const meta = {
                fileName: file.name ?? '',
                dosName: info.dosName ?? slot.dosName,
                kind: info.kind ?? null,
                md5: info.md5,
                size: info.size,
                versionName: info.versionName ?? null,
                known: info.known === true,
                savedAt: Date.now(),
            };

            const saved = await saveUserFile(slot.name, bytes, meta);
            if (!saved) {
                slot.setError('не удалось сохранить файл в хранилище браузера');
                toast('error', 'Не удалось сохранить файл — подробности в консоли');
                return;
            }

            slot.setMeta(meta);
            // Честно: DOSBox читает игру один раз, при запуске. Подменить её на лету
            // нельзя ни при каком старании.
            toast(
                info.warning ? 'warning' : 'success',
                `${meta.dosName} загружен. Применится при следующем открытии окна.`
                + (info.warning ? ` ${info.warning}` : ''),
            );
            notify(slot.changeKey, meta);
        } finally {
            slotBusy[slot.name] = false;
            slot.setBusy(false);
        }
    }

    async function removeFile(slot) {
        if (slotBusy[slot.name]) return;
        slotBusy[slot.name] = true;
        filesGeneration++;
        slot.setBusy(true);
        try {
            const ok = await clearUserFile(slot.name);
            if (ok) {
                slot.setMeta(null);
                toast('success', `${slot.label} убран. Вернётся при следующем открытии окна.`);
                notify(slot.changeKey, null);
            } else {
                toast('error', 'Не удалось убрать файл — подробности в консоли');
            }
        } finally {
            slotBusy[slot.name] = false;
            slot.setBusy(false);
        }
    }

    /** Сообщение наружу, которое не является настройкой (как progressCleared). */
    function notify(key, value) {
        try {
            onChange?.(key, value);
        } catch (err) {
            logError('панель настроек: обработчик изменения упал', err);
        }
    }

    done.addEventListener('click', () => close());

    async function resetProgress() {
        if (busy) return;
        busy = true;
        reset.disabled = true;
        try {
            if (!(await confirmReset())) return;
            const ok = await clearChanges();
            if (ok) {
                toast('success', 'Прогресс сброшен');
                notify('progressCleared', true);
            } else {
                toast('error', 'Не удалось сбросить прогресс — подробности в консоли');
            }
        } finally {
            busy = false;
            reset.disabled = false;
        }
    }

    // --- Открытие и закрытие

    function open() {
        refresh();
        element.hidden = false;
        // Фокус в первое поле: пока он здесь, перехват клавиатуры выключен (§4.7),
        // и цифры действительно вводятся, а не улетают в DOOM.
        try {
            cycles.focus({ preventScroll: true });
        } catch { /* jsdom и старые браузеры фокус могут не дать */ }
    }

    function close() {
        element.hidden = true;
    }

    function toggle() {
        if (element.hidden) open();
        else close();
        return !element.hidden;
    }

    function destroy() {
        element.remove();
    }

    refresh();

    return {
        element,
        open,
        close,
        toggle,
        refresh,
        refreshSound,
        destroy,
        get isOpen() { return !element.hidden; },
    };
}

// Подтверждение — тем же способом, что и выход из игры в modal.js: попап ST, а если
// его нет — window.confirm. Сброс прогресса необратим, спрашивать обязательно.
async function confirmReset() {
    const message = 'Удалить сохранённый прогресс DOOM? Отменить это будет нельзя.';
    try {
        const ctx = getCtx();
        if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE?.CONFIRM) {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM, '', {
                okButton: 'Удалить',
                cancelButton: 'Отмена',
            });
            return Boolean(result);
        }
        if (typeof globalThis.confirm === 'function') return globalThis.confirm(message);
    } catch (err) {
        logError('не удалось показать подтверждение сброса', err);
    }
    // В отличие от закрытия окна, молчаливое «да» здесь недопустимо: там ценой
    // ошибки была партия, здесь — все сейвы.
    return false;
}

// --- Свои файлы игры (Фаза 6)

/** Настройки слота: что в него кладут, как это проверять и как звать наружу. */
const SLOT_SPEC = Object.freeze({
    iwad: {
        dosName: 'DOOM.WAD',
        changeKey: 'userIwad',
        inspect: (bytes, fileName) => inspectIwad(bytes, fileName),
        empty: 'не загружен — играем на штатном shareware DOOM1.WAD',
    },
    exe: {
        dosName: 'DOOM.EXE',
        changeKey: 'userExe',
        inspect: (bytes) => inspectExe(bytes),
        empty: 'не загружен — используется shareware DOOM.EXE из комплекта',
    },
});

/**
 * Строит один слот файла: поле выбора, подпись «что загружено» и кнопку «Убрать».
 * Обработчики вешаются снаружи — слот сам ничего не знает ни про хранилище, ни про
 * тосты.
 */
function makeFileSlot({ cls, label, accept, hint }) {
    const spec = SLOT_SPEC[cls];

    const root = document.createElement('div');
    root.className = `stdoom-file-slot stdoom-file-slot-${cls}`;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.className = `stdoom-field stdoom-field-file stdoom-field-${cls}`;

    const row = makeRow(label, input, hint);

    const status = document.createElement('p');
    status.className = `stdoom-file-status stdoom-${cls}-status`;

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = `stdoom-btn stdoom-file-clear stdoom-${cls}-clear`;
    clear.textContent = 'Убрать';
    clear.disabled = true;

    root.append(row, status, clear);

    let hasMeta = false;

    function setMeta(meta) {
        hasMeta = Boolean(meta);
        status.classList.remove('stdoom-file-status-error');
        status.textContent = meta ? describeFile(meta) : spec.empty;
        clear.disabled = !hasMeta;
    }

    function setError(text) {
        status.classList.add('stdoom-file-status-error');
        status.textContent = `файл не подошёл: ${text}`;
    }

    function setBusy(busy) {
        input.disabled = busy;
        clear.disabled = busy || !hasMeta;
    }

    setMeta(null);

    return {
        name: cls,
        label,
        root,
        input,
        status,
        clear,
        dosName: spec.dosName,
        changeKey: spec.changeKey,
        inspect: spec.inspect,
        setMeta,
        setError,
        setBusy,
    };
}

/** Подпись загруженного файла: имя в DOS, опознанная версия, размер и MD5. */
function describeFile(meta) {
    const parts = [];
    if (meta.dosName) parts.push(meta.dosName);
    parts.push(meta.versionName ?? 'версия не опознана');
    if (meta.size) parts.push(formatSize(meta.size));
    if (meta.md5) parts.push(`md5 ${meta.md5}`);
    if (meta.fileName && meta.fileName !== meta.dosName) parts.push(`из «${meta.fileName}»`);
    return parts.join(' · ');
}

/**
 * Байты выбранного файла. File.arrayBuffer() есть везде, где работает наш эмулятор,
 * но в тестах и в старых сборках его может не быть — оттуда запасной FileReader.
 */
function readFileBytes(file) {
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error ?? new Error('файл не прочитался'));
        reader.readAsArrayBuffer(file);
    });
}

// --- Мелочи разметки

function formatSensitivity(value) {
    return `×${value.toFixed(1)}`;
}

function wrap(...nodes) {
    const box = document.createElement('div');
    box.className = 'stdoom-field-box';
    box.append(...nodes);
    return box;
}

/**
 * Справка по управлению.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ. Раскладка у нас не оригинальная: движение на WASD, а стрелки крутят
 * камеру и НЕ ходят (§5.2). В ванильном DOOM одна клавиша на действие, поэтому
 * «и WASD, и стрелки на движение» выразить нечем — выбран современный вариант. Игрок,
 * который по привычке 1993 года жмёт стрелки, поворачивается на месте и делает
 * единственный доступный вывод: «я застрял в первой комнате». Так и случилось на живой
 * проверке, поэтому раскладка написана прямо в окне, а не оставлена на догадки.
 *
 * Место выбрано здесь, а не на стартовом экране: там текст читают один раз и мимо, а
 * за справкой возвращаются ровно тогда, когда что-то не выходит.
 */
function makeControlsHelp() {
    const box = document.createElement('div');
    box.className = 'stdoom-panel-controls';

    const heading = document.createElement('h4');
    heading.className = 'stdoom-panel-subtitle';
    heading.textContent = 'Управление';
    box.appendChild(heading);

    const list = document.createElement('dl');
    list.className = 'stdoom-controls-list';

    const ROWS = [
        ['W A S D', 'ходить: вперёд, назад и шагом вбок'],
        ['← →', 'поворот камеры (вперёд НЕ идут — для этого W)'],
        ['Пробел', 'открыть дверь, нажать переключатель'],
        ['Ctrl', 'огонь'],
        ['Shift', 'бег'],
        ['1…7', 'выбор оружия'],
        ['Мышь', 'поворот; ЛКМ — огонь, ПКМ — шагом вбок, средняя — вперёд'],
        ['Esc', 'меню DOOM — окно таверны этим не закрывается'],
        ['Tab', 'карта уровня'],
        ['F2 / F3', 'сохранить и загрузить игру'],
    ];

    for (const [keys, what] of ROWS) {
        const term = document.createElement('dt');
        term.className = 'stdoom-controls-keys';
        term.textContent = keys;
        const desc = document.createElement('dd');
        desc.className = 'stdoom-controls-what';
        desc.textContent = what;
        list.append(term, desc);
    }

    box.appendChild(list);
    return box;
}

function makeRow(labelText, control, hintText) {
    const row = document.createElement('label');
    row.className = 'stdoom-panel-row';

    const label = document.createElement('span');
    label.className = 'stdoom-panel-label';
    label.textContent = labelText;

    row.append(label, control);
    if (hintText) row.appendChild(makeHint(hintText));
    return row;
}

function makeCheckRow(labelText, control, hintText) {
    const row = document.createElement('label');
    row.className = 'stdoom-panel-row stdoom-panel-row-check';

    const label = document.createElement('span');
    label.className = 'stdoom-panel-label';
    label.textContent = labelText;

    row.append(control, label);
    if (hintText) row.appendChild(makeHint(hintText));
    return row;
}

function makeHint(text) {
    const hint = document.createElement('span');
    hint.className = 'stdoom-panel-hint';
    hint.textContent = text;
    return hint;
}
