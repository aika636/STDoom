// Загрузка js-dos API (`emulators`) в ES-модульном расширении.
//
// `assets/jsdos/emulators.js` — browserify-UMD-бандл: он рассчитан на классический
// <script> и вешает глобальный `window.emulators`. Импортировать его как ES-модуль
// нельзя, поэтому вставляем <script src> и ждём onload.
//
// Отдельная грабля: внутри бандл делает `eval.call(window, ...)` для glue-кода
// wdosbox.js и создаёт Worker из blob:-URL. Если CSP таверны это запретит — падение
// произойдёт именно здесь, поэтому диагностика ошибки должна быть внятной.

import { logInfo, logError } from '../log.js';

/** Промис загрузки; кешируется, чтобы <script> вставился ровно один раз. */
let loading = null;

/** Базовый URL каталога с wdosbox.js / wdosbox.wasm / emulators.js. */
export function jsdosPathPrefix() {
    return new URL('../../assets/jsdos/', import.meta.url).href;
}

/**
 * Грузит `emulators.js` и возвращает глобальный объект `emulators`.
 * Повторные вызовы отдают тот же промис.
 * @returns {Promise<object>}
 */
export function loadEmulators() {
    if (loading) return loading;

    loading = new Promise((resolve, reject) => {
        // Бандл мог быть загружен кем-то ещё (например, повторная инициализация
        // расширения без перезагрузки страницы) — тогда работы нет.
        if (globalThis.emulators) {
            resolve(globalThis.emulators);
            return;
        }

        const prefix = jsdosPathPrefix();
        const script = document.createElement('script');
        script.src = prefix + 'emulators.js';
        script.async = true;

        script.addEventListener('load', () => {
            const api = globalThis.emulators;
            if (!api) {
                reject(new Error('emulators.js загружен, но window.emulators не появился'));
                return;
            }
            // pathPrefix обязан оканчиваться слэшем: пакет просто склеивает строки.
            api.pathPrefix = prefix;
            logInfo('js-dos API загружен, pathPrefix =', prefix);
            resolve(api);
        });

        script.addEventListener('error', () => {
            // Тег убираем за собой: неудачу мы не кешируем (см. ниже), и следующая
            // попытка добавит свой <script> — без уборки они копились бы в <head>
            // по одному на каждое открытие окна.
            script.remove();
            reject(new Error('не удалось загрузить ' + script.src));
        });

        document.head.appendChild(script);
    });

    // Неудачу не кешируем: следующая попытка открыть окно должна пробовать заново.
    loading.catch((err) => {
        logError('загрузка js-dos не удалась', err);
        loading = null;
    });

    return loading;
}
