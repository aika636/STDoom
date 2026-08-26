// Точки запуска: кнопка в wand-меню и слэш-команда /doom.

import { getCtx } from '../ctx.js';
import { logError, logInfo, warnOnce } from '../log.js';
import { openShell } from './modal.js';
import { createDoomSession } from '../dos/session.js';

const WAND_BUTTON_ID = 'stdoom_wand_button';

// Кнопка в выпадающем меню «волшебной палочки». ST раз в секунду проверяет, есть ли у
// #extensionsMenu видимые дети, и сам показывает кнопку меню — достаточно добавить свой
// пункт в любой момент после загрузки.
export function initWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        warnOnce('no-extensions-menu', 'wand-меню не найдено — кнопка запуска не добавлена');
        return false;
    }
    if (document.getElementById(WAND_BUTTON_ID)) return true; // идемпотентность

    const button = document.createElement('div');
    button.id = WAND_BUTTON_ID;
    button.className = 'list-group-item flex-container flexGap5';
    button.title = 'Открыть STDoom — DOOM в таверне';

    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-skull extensionsMenuExtensionButton';

    const label = document.createElement('span');
    label.textContent = 'STDoom';

    button.append(icon, label);
    button.addEventListener('click', () => {
        openShell(createDoomSession()).catch((err) => logError('openShell упал', err));
    });

    menu.appendChild(button);
    return true;
}

// Слэш-команда /doom. Регистрируется через SlashCommandParser; если его в этой версии
// ST нет, пробуем устаревший registerSlashCommand, а если нет и его — молча живём
// с одной кнопкой.
export function initSlashCommands() {
    const ctx = getCtx();

    const open = () => {
        openShell(createDoomSession()).catch((err) => logError('openShell упал', err));
        return '';
    };

    try {
        if (ctx.SlashCommandParser?.addCommandObject && ctx.SlashCommand?.fromProps) {
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: 'doom',
                callback: open,
                helpString: 'Открывает окно с DOOM.',
                unnamedArgumentList: [],
            }));
            logInfo('слэш-команда /doom зарегистрирована');
            return true;
        }

        if (typeof ctx.registerSlashCommand === 'function') {
            ctx.registerSlashCommand('doom', open, [], 'Открывает окно с DOOM.', false, true);
            logInfo('слэш-команда /doom зарегистрирована (устаревший API)');
            return true;
        }

        warnOnce('no-slash-api', 'API слэш-команд не найдено — /doom недоступна');
        return false;
    } catch (err) {
        logError('не удалось зарегистрировать слэш-команду', err);
        return false;
    }
}
