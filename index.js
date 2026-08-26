// Точка входа STDoom. Тонкий файл: только связывает модули, вся логика — в src/.

import { getCtx, getEventTypes } from './src/ctx.js';
import { logError, logInfo } from './src/log.js';
import { initSlashCommands, initWandButton } from './src/shell/launcher.js';

const VERSION = '0.1.0';

// Кнопка в wand-меню и слэш-команда появляются только после того, как ST отрисовал свой
// интерфейс, — это APP_READY. Если событие уже прошло (или его имени нет в этой версии
// ST), страхуемся отложенной попыткой, чтобы не потерять UI совсем. Гвард done не даёт
// сработать обеим страховкам сразу.
function initUI() {
    let done = false;
    const run = () => {
        if (done) return;
        done = true;

        try {
            initWandButton();
        } catch (err) {
            logError('initWandButton упал', err);
        }

        try {
            initSlashCommands();
        } catch (err) {
            logError('initSlashCommands упал', err);
        }
    };

    try {
        const ctx = getCtx();
        const et = getEventTypes(ctx);
        if (et.APP_READY) ctx.eventSource.on(et.APP_READY, run);
    } catch (err) {
        logError('не удалось подписаться на APP_READY', err);
    }

    setTimeout(run, 3000);
}

jQuery(async () => {
    try {
        initUI();
        logInfo(`v${VERSION} загружен`);
    } catch (err) {
        logError('инициализация упала', err);
    }
});
