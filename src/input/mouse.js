// Мышь и Pointer Lock.
//
// Ключевое решение: movementY НЕ пробрасывается вообще. В ванильном DOOM вертикальная
// ось мыши двигает вперёд/назад (forward += mousey в g_game.c), свободного взгляда
// нет. Проброс Y означал бы, что игрок, пытаясь прицелиться выше, уезжает вперёд.
// Это браузерный эквивалент DOS-утилиты novert, и это правильное поведение, а не
// упрощение — не «чинить».

import { logWarn } from '../log.js';

/** Кламп дельты за кадр: рывок мыши не должен закручивать игрока волчком. */
export const MAX_DELTA = 50;

/** Кнопки DOOM: 0 — огонь, 1 — стрейф-модификатор, 2 — вперёд (двойной клик = use). */
const BUTTON_MAP = { 0: 0, 2: 1, 1: 2 };

/**
 * @param {object} params
 * @param {object} params.ci CommandInterface
 * @param {HTMLElement} params.surface канвас
 * @param {() => number} [params.getSensitivity] наш собственный множитель дельт
 */
export function createMouse({ ci, surface, getSensitivity }) {
    let attached = false;
    // Остаток дроби: при малой чувствительности целочисленные дельты иначе
    // теряются, и медленное ведение мыши не поворачивает вообще.
    let carry = 0;

    function locked() {
        return document.pointerLockElement === surface;
    }

    async function requestLock() {
        try {
            // unadjustedMovement отключает акселерацию ОС — прицеливание становится
            // предсказуемым. Поддерживается не везде, поэтому есть фолбэк.
            await surface.requestPointerLock({ unadjustedMovement: true });
        } catch {
            try {
                await surface.requestPointerLock();
            } catch (err) {
                logWarn('Pointer Lock недоступен', err);
            }
        }
    }

    function onPointerDown(event) {
        if (!locked()) {
            // Первый клик по полю захватывает мышь, в игру он не идёт.
            requestLock();
            return;
        }
        const button = BUTTON_MAP[event.button];
        if (button === undefined) return;
        event.preventDefault();
        try { ci.sendMouseButton(button, true); } catch (err) { logWarn('sendMouseButton', err); }
    }

    function onPointerUp(event) {
        if (!locked()) return;
        const button = BUTTON_MAP[event.button];
        if (button === undefined) return;
        event.preventDefault();
        try { ci.sendMouseButton(button, false); } catch (err) { logWarn('sendMouseButton', err); }
    }

    function onMouseMove(event) {
        if (!locked()) return;
        const sensitivity = getSensitivity?.() ?? 1;
        // Только X. Y выбрасывается намеренно — см. шапку файла.
        const raw = event.movementX * sensitivity + carry;
        const clamped = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, raw));
        const whole = Math.trunc(clamped);
        carry = clamped - whole;
        if (whole === 0) return;
        try { ci.sendMouseRelativeMotion(whole, 0); } catch (err) { logWarn('sendMouseRelativeMotion', err); }
    }

    // Иначе правая кнопка (стрейф) откроет меню браузера поверх игры.
    function onContextMenu(event) { event.preventDefault(); }

    /**
     * Гасит все кнопки мыши и накопленный остаток дельты. Кнопки перечисляются
     * скопом, а не по учтённым: их всего две, а промах здесь дороже лишнего
     * события — вернуться к непрерывно стреляющему персонажу игрок не должен.
     */
    function releaseAll() {
        carry = 0;
        for (const button of Object.values(BUTTON_MAP)) {
            try { ci.sendMouseButton(button, false); } catch { /* сессия могла закрыться */ }
        }
    }

    function onLockChange() {
        if (locked()) return;
        // Мышь отпустили (обычно по Escape) — гасим зажатые кнопки.
        releaseAll();
    }

    function attach() {
        if (attached) return;
        attached = true;
        surface.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointerup', onPointerUp);
        document.addEventListener('mousemove', onMouseMove);
        surface.addEventListener('contextmenu', onContextMenu);
        document.addEventListener('pointerlockchange', onLockChange);
    }

    function detach() {
        if (!attached) return;
        attached = false;
        // Кнопки гасим ЯВНО, как это делают keyboard.js и touch.js в своих detach().
        // Полагаться здесь на onLockChange нельзя вдвойне: слушатель снимается ниже,
        // а выход из Pointer Lock и без того происходит после снятия — то есть при
        // закрытии окна с зажатой ЛКМ отпускание не ушло бы вообще никуда.
        releaseAll();
        surface.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('mousemove', onMouseMove);
        surface.removeEventListener('contextmenu', onContextMenu);
        document.removeEventListener('pointerlockchange', onLockChange);
        if (locked()) {
            try { document.exitPointerLock(); } catch { /* уже отпущено */ }
        }
    }

    return { attach, detach, releaseAll, requestLock, get attached() { return attached; }, get locked() { return locked(); } };
}
