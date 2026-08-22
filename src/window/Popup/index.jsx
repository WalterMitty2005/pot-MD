import { appWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/tauri';
import { writeText } from '@tauri-apps/api/clipboard';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@nextui-org/react';
import { PiTranslateFill } from 'react-icons/pi';
import { MdContentCopy } from 'react-icons/md';
import React, { useEffect, useRef, useState } from 'react';

export default function Popup() {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [popupOpacity, setPopupOpacity] = useState(1);
    const timerRef = useRef(null);

    function armAutoClose() {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(async () => {
            await appWindow.hide();
        }, 8000);
    }

    useEffect(() => {
        // The Rust side emits "popup_text" right after window creation, which
        // races with page load (listener not yet registered). So on mount we
        // fetch the stored text first, then rely on events for updates.
        (async () => {
            try {
                const stored = await invoke('popup_get_text');
                if (stored && stored.trim()) {
                    setText(stored);
                    // Reset opacity in case the popup was faded out by the
                    // mouse-move-away logic on the Rust side.
                    setPopupOpacity(1);
                    await appWindow.show();
                    armAutoClose();
                }
            } catch (e) {
                // ignore
            }
        })();

        const unlisten = listen('popup_text', async (event) => {
            setText(event.payload);
            setPopupOpacity(1);
            await appWindow.show();
            armAutoClose();
        });

        // The Rust side computes how far the mouse is from the popup and emits
        // a 0..1 opacity so the card fades out smoothly as you move away, then
        // hides it. We just apply it to the card via CSS (Tauri 1.8 has no
        // window-level setOpacity API).
        const unlistenOpacity = listen('popup_opacity', (event) => {
            setPopupOpacity(event.payload);
        });

        // Hide when the popup loses focus (user clicked elsewhere). The Rust
        // side also dismisses on mouse-move-away, but this covers clicks that
        // don't move the cursor.
        const unlistenBlur = listen('tauri://blur', async () => {
            await appWindow.hide();
        });

        return () => {
            unlisten.then((fn) => fn());
            unlistenBlur.then((fn) => fn());
            unlistenOpacity.then((fn) => fn());
            if (timerRef.current) {
                clearTimeout(timerRef.current);
            }
        };
    }, []);

    async function handleTranslate() {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }
        // Trigger the same pipeline as the configured translate hotkey
        // (e.g. Ctrl+1). Rust refocuses the source app and re-reads the
        // selection, then the frontend closes this popup.
        await invoke('popup_translate');
        await appWindow.hide();
    }

    async function handleCopy() {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }
        await writeText(text);
        await appWindow.hide();
    }

    return (
        <div className='w-screen h-screen flex items-center justify-center bg-white/70 backdrop-blur-xl rounded-2xl ring-1 ring-white/60 border border-white/40 overflow-hidden select-none transition-opacity duration-150' style={{ opacity: popupOpacity }}>
            <div className='flex gap-[4px] p-[4px]'>
                <Tooltip content={t('popup.translate')} placement='bottom' delay={500}>
                    <Button
                        isIconOnly
                        size='sm'
                        variant='light'
                        radius='sm'
                        onPress={handleTranslate}
                    >
                        <PiTranslateFill className='text-[18px]' />
                    </Button>
                </Tooltip>
                <Tooltip content={t('popup.copy')} placement='bottom' delay={500}>
                    <Button
                        isIconOnly
                        size='sm'
                        variant='light'
                        radius='sm'
                        onPress={handleCopy}
                    >
                        <MdContentCopy className='text-[18px]' />
                    </Button>
                </Tooltip>
            </div>
        </div>
    );
}
