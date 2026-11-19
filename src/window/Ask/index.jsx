import { Card, CardBody, CardFooter, Button, Spinner, Tooltip } from '@nextui-org/react';
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from '@nextui-org/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/api/clipboard';
import { MdContentCopy, MdExpandMore } from 'react-icons/md';
import { AiFillCloseCircle } from 'react-icons/ai';
import { BsPinFill, BsArrowUp } from 'react-icons/bs';
import { TbMarkdown, TbMarkdownOff } from 'react-icons/tb';
import { useTranslation } from 'react-i18next';
import { LuDelete } from 'react-icons/lu';
import toast, { Toaster } from 'react-hot-toast';
import { appWindow, currentMonitor } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';

import Markdown, { looksLikeMarkdown } from '../Translate/components/TargetArea/Markdown';
import { useConfig, useToastStyle } from '../../hooks';
import { store } from '../../utils/store';
import { osType } from '../../utils/env';
import { getServiceName } from '../../utils/service_instance';
import { ASK_HISTORY_LIMIT, buildAskConfig, cleanAnswer, supportsAsk, trimHistory } from './utils';
import * as builtinServices from '../../services/translate';

// What stays on disk after the window closes. Larger than the context window
// (ASK_HISTORY_LIMIT) so reopening the window shows the last exchange even
// after a long session, while only the tail is replayed to the model.
const ASK_STORE_LIMIT = 40;

/**
 * AI Q&A window.
 *
 * Thin chat surface over the LLM services the user already configured for
 * translation: no translation prompt, just the question. The conversation is
 * kept in the config store, so reopening the window (or pressing the hotkey
 * again) resumes where the user left off, and the retained turns are replayed
 * as context so follow-up questions like "再说清楚点" work.
 */
export default function Ask() {
    const [question, setQuestion] = useState('');
    // {role: 'user' | 'assistant', content: string, error?: true}
    const [messages, setMessages] = useState([]);
    const [hydrated, setHydrated] = useState(false);
    const [loading, setLoading] = useState(false);
    const [pined, setPined] = useState(false);
    const [serviceInstanceKey, setServiceInstanceKey] = useState('');
    const [availableInstances, setAvailableInstances] = useState([]);
    const [markdownForce, setMarkdownForce] = useState(null);

    const [appFontSize] = useConfig('app_font_size', 16);
    const [markdownRender] = useConfig('ask_markdown_render', true);
    const [alwaysOnTop] = useConfig('translate_always_on_top', false);
    const [preferredInstance] = useConfig('ask_service_instance', '');

    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const textAreaRef = useRef(null);
    const scrollRef = useRef(null);
    // Bumped on every ask so a slow earlier request cannot overwrite the
    // answer of a newer one (same guard the translate cards use).
    const askIdRef = useRef(0);

    // Restore the conversation from disk. Done once on mount: the window is
    // destroyed on close, so this runs again on the next hotkey press.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const saved = (await store.get('ask_history')) ?? [];
                if (!cancelled && Array.isArray(saved)) {
                    setMessages(
                        saved.filter(
                            (m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant')
                        )
                    );
                }
            } catch {
                // A broken history entry must not block the window from opening.
            } finally {
                if (!cancelled) setHydrated(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Persist, debounced: streaming updates rewrite the last message on every
    // chunk, and each write hits the config file.
    useEffect(() => {
        if (!hydrated) return;
        const timer = setTimeout(() => {
            store
                .set('ask_history', trimHistory(messages, ASK_STORE_LIMIT))
                .then(() => store.save())
                .catch(() => {});
        }, 400);
        return () => clearTimeout(timer);
    }, [messages, hydrated]);

    // Remember where the window was left. Same approach as the translate
    // window: store logical coordinates, so a DPI change does not shift it.
    const saveWindowPosition = async () => {
        try {
            const position = await appWindow.outerPosition();
            const monitor = await currentMonitor();
            if (!monitor) return;
            const logical = position.toLogical(monitor.scaleFactor);
            await store.set('ask_window_position_x', parseInt(logical.x));
            await store.set('ask_window_position_y', parseInt(logical.y));
            await store.save();
        } catch {
            // Position is a convenience; never surface errors for it.
        }
    };

    useEffect(() => {
        let timer = null;
        const unlisten = listen('tauri://move', () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(saveWindowPosition, 120);
        });
        return () => {
            if (timer) clearTimeout(timer);
            unlisten.then((f) => f());
        };
    }, []);

    // Flush the position before the window goes away: dragging and immediately
    // closing would otherwise land inside the debounce window and be lost.
    const closeWindow = async () => {
        await saveWindowPosition();
        void appWindow.close();
    };

    // Pick the backend: the user's explicit choice when it is still a valid
    // LLM instance, else the first LLM instance in the translate service list.
    // Also expose the full candidate list so the header can switch models
    // in place instead of sending the user back to settings.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const list = (await store.get('translate_service_list')) ?? [];
            const keys = (Array.isArray(list) ? list : []).filter((k) =>
                supportsAsk(getServiceName(k))
            );
            const rows = [];
            for (const key of keys) {
                const cfg = (await store.get(key)) ?? {};
                const serviceName = getServiceName(key);
                rows.push({
                    key,
                    serviceName,
                    // instanceName is what the user called this instance; the
                    // service title alone is ambiguous when there are two
                    // OpenAI endpoints with different models.
                    label:
                        cfg.instanceName ||
                        t(`services.translate.${serviceName}.title`, { defaultValue: serviceName }),
                    model: cfg.model || '',
                });
            }
            if (cancelled) return;
            setAvailableInstances(rows);

            let chosen = '';
            if (preferredInstance && supportsAsk(getServiceName(preferredInstance))) {
                chosen = preferredInstance;
            } else if (rows.length > 0) {
                chosen = rows[0].key;
            }
            setServiceInstanceKey(chosen);
        })();
        return () => {
            cancelled = true;
        };
    }, [preferredInstance, t]);

    useEffect(() => {
        if (alwaysOnTop !== null && alwaysOnTop) {
            appWindow.setAlwaysOnTop(true);
            setPined(true);
        }
    }, [alwaysOnTop]);

    // Hotkey pressed while the window is open: keep the conversation, just
    // bring it forward. Clearing here would defeat the point of remembering it.
    useEffect(() => {
        const unlisten = listen('ask_reset', () => {
            appWindow.setFocus();
            textAreaRef.current?.focus();
        });
        return () => {
            unlisten.then((f) => f());
        };
    }, []);

    // Grow the textarea to fit content, like the translate source box.
    useEffect(() => {
        if (textAreaRef.current) {
            textAreaRef.current.style.height = '40px';
            textAreaRef.current.style.height = `${Math.min(textAreaRef.current.scrollHeight, 160)}px`;
        }
    }, [question]);

    // Follow the tail of the conversation (both when sending and while the
    // answer streams in), unless the user has scrolled up to re-read something.
    const stickToBottomRef = useRef(true);
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }, [messages, loading]);

    const appendMessage = (msg) => setMessages((prev) => [...prev, msg]);

    const replaceLastAnswer = (id, text) => {
        if (askIdRef.current !== id) return;
        setMessages((prev) => {
            const next = [...prev];
            const last = next.length - 1;
            if (last >= 0 && next[last].role === 'assistant') {
                next[last] = { role: 'assistant', content: text };
            }
            return next;
        });
    };

    const failLastAnswer = (id, text) => {
        if (askIdRef.current !== id) return;
        setMessages((prev) => {
            const next = [...prev];
            const last = next.length - 1;
            if (last >= 0 && next[last].role === 'assistant') {
                next[last] = { role: 'assistant', content: text, error: true };
            }
            return next;
        });
    };

    const ask = async () => {
        const q = question.trim();
        if (!q || loading) return;

        const serviceName = getServiceName(serviceInstanceKey);
        if (!serviceInstanceKey || !supportsAsk(serviceName)) {
            appendMessage({ role: 'assistant', content: t('ask.no_service'), error: true });
            return;
        }

        const id = ++askIdRef.current;
        // Replay the retained turns, then the new question. Computed before
        // the state update so it reflects what the user has seen so far.
        const turns = [...trimHistory(messages, ASK_HISTORY_LIMIT), { role: 'user', content: q }];

        // Sending is an explicit "take me to the newest message".
        stickToBottomRef.current = true;
        setQuestion('');
        setLoading(true);
        appendMessage({ role: 'user', content: q });
        appendMessage({ role: 'assistant', content: '' });

        try {
            const instanceConfig = (await store.get(serviceInstanceKey)) ?? {};
            const service = builtinServices[serviceName];
            if (!service || typeof service.translate !== 'function') {
                throw new Error(`Service not available: ${serviceName}`);
            }

            // Languages are irrelevant for Q&A; pass 'auto' so provider-side
            // language mapping never gets in the way.
            await service.translate(q, 'auto', 'auto', {
                config: buildAskConfig(instanceConfig, serviceName, turns),
                detect: 'auto',
                setResult: (v) => replaceLastAnswer(id, cleanAnswer(v)),
            }).then((v) => replaceLastAnswer(id, cleanAnswer(v)));
        } catch (e) {
            failLastAnswer(id, e?.toString?.() ?? String(e));
        } finally {
            if (askIdRef.current === id) {
                setLoading(false);
            }
        }
    };

    const keyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            ask();
        }
        if (e.key === 'Escape') {
            void closeWindow();
        }
    };

    const clearConversation = () => {
        askIdRef.current += 1;
        setLoading(false);
        setMessages([]);
        setQuestion('');
        setMarkdownForce(null);
        textAreaRef.current?.focus();
    };

    // Header label: instance name + model, so it reads as "OpenAI · gpt-4o"
    // rather than just the provider. Falls back to the provider alone when the
    // instance has no model field configured.
    const currentInstance = useMemo(
        () => availableInstances.find((i) => i.key === serviceInstanceKey),
        [availableInstances, serviceInstanceKey]
    );
    const currentLabel = currentInstance
        ? currentInstance.model
            ? `${currentInstance.label} · ${currentInstance.model}`
            : currentInstance.label
        : t('ask.no_service_short');

    // Whether answers are currently rendered as Markdown. `markdownForce` is
    // the user's manual override; null means "follow detection + the setting".
    const mdActive =
        markdownForce === null
            ? markdownRender &&
              messages.some(
                  (m) => m.role === 'assistant' && !m.error && looksLikeMarkdown(m.content)
              )
            : markdownForce;

    const renderAnswer = (text) => {
        const show =
            markdownForce === null ? markdownRender && looksLikeMarkdown(text) : markdownForce;
        return show ? (
            <Markdown
                text={text}
                fontSize={appFontSize}
            />
        ) : (
            <p className='whitespace-pre-wrap text-[13px]'>{text}</p>
        );
    };

    return (
        <div className='bg-background h-screen w-screen flex flex-col'>
            <Toaster />
            <div
                className='fixed top-[5px] left-[5px] right-[5px] h-[30px]'
                data-tauri-drag-region='true'
            />
            <div className={`h-[32px] w-full flex ${osType === 'Darwin' ? 'justify-end' : 'justify-between'}`}>
                {/* Clickable model switcher. Swapping here keeps the
                    conversation in place -- they often pick the model *after*
                    seeing that the previous one answered poorly. */}
                <Dropdown
                    placement='bottom-start'
                    isDisabled={availableInstances.length === 0}
                >
                    <DropdownTrigger>
                        <Button
                            size='sm'
                            variant='flat'
                            className='my-auto ml-[8px] h-[24px] min-w-0 px-[8px] text-[12px] max-w-[240px]'
                            endContent={<MdExpandMore className='text-[14px] shrink-0' />}
                        >
                            <span className='truncate'>{currentLabel}</span>
                        </Button>
                    </DropdownTrigger>
                    <DropdownMenu
                        aria-label={t('ask.switch_model')}
                        className='max-h-[50vh] overflow-y-auto'
                        selectionMode='single'
                        selectedKeys={serviceInstanceKey ? [serviceInstanceKey] : []}
                        onAction={(key) => {
                            setServiceInstanceKey(String(key));
                        }}
                    >
                        {availableInstances.map((item) => (
                            <DropdownItem
                                key={item.key}
                                description={item.model || undefined}
                            >
                                {item.label}
                            </DropdownItem>
                        ))}
                    </DropdownMenu>
                </Dropdown>

                <div className='flex'>
                    <Tooltip content={mdActive ? t('ask.markdown_off') : t('ask.markdown_on')}>
                        <Button
                            isIconOnly
                            size='sm'
                            variant='flat'
                            disableAnimation
                            className='my-auto bg-transparent'
                            isDisabled={!messages.some((m) => m.role === 'assistant' && !m.error)}
                            onPress={() => {
                                // Toggle between rendered and plain text. Once
                                // toggled, the manual choice sticks until the
                                // conversation is cleared.
                                setMarkdownForce(!mdActive);
                            }}
                        >
                            {mdActive ? (
                                <TbMarkdown className='text-[18px] text-default-400' />
                            ) : (
                                <TbMarkdownOff className='text-[18px] text-default-400' />
                            )}
                        </Button>
                    </Tooltip>
                    <Button
                        isIconOnly
                        size='sm'
                        variant='flat'
                        disableAnimation
                        className='my-auto bg-transparent'
                        onPress={() => {
                            if (pined) {
                                appWindow.setAlwaysOnTop(false);
                            } else {
                                appWindow.setAlwaysOnTop(true);
                            }
                            setPined(!pined);
                        }}
                    >
                        <BsPinFill className={`text-[18px] ${pined ? 'text-primary' : 'text-default-400'}`} />
                    </Button>
                    <Button
                        isIconOnly
                        size='sm'
                        variant='flat'
                        disableAnimation
                        className={`my-auto ${osType === 'Darwin' && 'hidden'} bg-transparent`}
                        onPress={() => {
                            void closeWindow();
                        }}
                    >
                        <AiFillCloseCircle className='text-[18px] text-default-400' />
                    </Button>
                </div>
            </div>

            <div
                ref={scrollRef}
                className='flex-1 px-[8px] pb-[8px] overflow-y-auto'
                onScroll={(e) => {
                    const el = e.currentTarget;
                    stickToBottomRef.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                }}
            >
                {messages.map((m, index) =>
                    m.role === 'user' ? (
                        <div
                            key={index}
                            className='flex justify-end mb-[8px]'
                        >
                            <div className='max-w-[86%] bg-primary-50 text-[13px] px-[10px] py-[6px] rounded-[10px] whitespace-pre-wrap select-text'>
                                {m.content}
                            </div>
                        </div>
                    ) : (
                        <Card
                            key={index}
                            shadow='none'
                            className={`rounded-[10px] mt-[6px] ${m.error ? 'bg-danger-50' : 'bg-content1'}`}
                        >
                            <CardBody className={`${m.error ? '' : 'bg-content1'} p-[12px] select-text`}>
                                {m.error ? (
                                    <p className='text-[13px] whitespace-pre-wrap select-text'>{m.content}</p>
                                ) : m.content === '' ? (
                                    <div className='flex justify-center py-[4px]'>
                                        <Spinner size='sm' />
                                    </div>
                                ) : (
                                    renderAnswer(m.content)
                                )}
                            </CardBody>
                            {!m.error && m.content !== '' ? (
                                <CardFooter className='bg-content1 rounded-none rounded-b-[10px] flex justify-end px-[12px] p-[5px]'>
                                    <Tooltip content={t('ask.copy')}>
                                        <Button
                                            isIconOnly
                                            variant='light'
                                            size='sm'
                                            onPress={() => {
                                                writeText(m.content).then(() => {
                                                    toast.success(t('common.copy_success'), {
                                                        style: toastStyle,
                                                    });
                                                });
                                            }}
                                        >
                                            <MdContentCopy className='text-[16px]' />
                                        </Button>
                                    </Tooltip>
                                </CardFooter>
                            ) : null}
                        </Card>
                    )
                )}
            </div>

            <div className='px-[8px] pb-[8px]'>
                <Card
                    shadow='none'
                    className='bg-content1 rounded-[10px]'
                >
                    <CardBody className='bg-content1 p-[12px] pb-0'>
                        <textarea
                            autoFocus
                            ref={textAreaRef}
                            className={`text-[${appFontSize}px] bg-content1 resize-none outline-none`}
                            style={{ fontSize: `${appFontSize}px` }}
                            placeholder={t('ask.placeholder')}
                            value={question}
                            onKeyDown={keyDown}
                            onChange={(e) => setQuestion(e.target.value)}
                        />
                    </CardBody>
                    <CardFooter className='bg-content1 rounded-none rounded-b-[10px] flex justify-between px-[12px] p-[5px]'>
                        <div className='flex justify-start'>
                            <Tooltip content={t('ask.clear')}>
                                <Button
                                    isIconOnly
                                    variant='light'
                                    size='sm'
                                    isDisabled={question === '' && messages.length === 0}
                                    onPress={clearConversation}
                                >
                                    <LuDelete className='text-[16px]' />
                                </Button>
                            </Tooltip>
                        </div>
                        <Tooltip content={t('ask.send')}>
                            <Button
                                isIconOnly
                                size='sm'
                                color='primary'
                                variant='flat'
                                isLoading={loading}
                                isDisabled={question.trim() === ''}
                                onPress={ask}
                            >
                                <BsArrowUp className='text-[16px]' />
                            </Button>
                        </Tooltip>
                    </CardFooter>
                </Card>
            </div>
        </div>
    );
}
