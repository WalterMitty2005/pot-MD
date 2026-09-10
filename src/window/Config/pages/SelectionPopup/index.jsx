import { invoke } from '@tauri-apps/api';
import { open } from '@tauri-apps/api/dialog';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
    Button,
    Card,
    CardBody,
    Chip,
    Input,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Radio,
    RadioGroup,
    Slider,
    Spinner,
    Switch,
} from '@nextui-org/react';
import { MdAdd, MdApps, MdFolderOpen, MdRefresh, MdSearch } from 'react-icons/md';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useConfig } from '../../../../hooks/useConfig';
import { useToastStyle } from '../../../../hooks';

export default function SelectionPopup() {
    const { t } = useTranslation();
    const toastStyle = useToastStyle();
    const [popupEnabled, setPopupEnabled] = useConfig('popup_enabled', false);
    const [listMode, setListMode] = useConfig('popup_list_mode', 'blacklist');
    const [processList, setProcessList] = useConfig('popup_process_list', []);
    const [popupOpacity, setPopupOpacity] = useConfig('popup_opacity', 1);
    const [popupOffsetX, setPopupOffsetX] = useConfig('popup_offset_x', 8);
    const [popupOffsetY, setPopupOffsetY] = useConfig('popup_offset_y', 8);
    const [popupFadeDistance, setPopupFadeDistance] = useConfig('popup_fade_distance', 140);
    const [newProcess, setNewProcess] = useState('');
    const [foregroundProcess, setForegroundProcess] = useState('');
    // Application picker: the list is read from Rust (visible top-level windows
    // -> owning exe name), refreshed every time the popover opens so apps
    // launched after the settings page was opened still show up.
    const [apps, setApps] = useState([]);
    const [appsLoading, setAppsLoading] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [appSearch, setAppSearch] = useState('');
    // Guards against a slow refresh overwriting a newer one's result.
    const appsReqId = useRef(0);

    const loadApps = useCallback(() => {
        const id = ++appsReqId.current;
        setAppsLoading(true);
        invoke('popup_list_applications')
            .then((list) => {
                if (id === appsReqId.current) {
                    setApps(Array.isArray(list) ? list : []);
                }
            })
            .catch(() => {
                if (id === appsReqId.current) {
                    setApps([]);
                }
            })
            .finally(() => {
                if (id === appsReqId.current) {
                    setAppsLoading(false);
                }
            });
    }, []);

    useEffect(() => {
        if (popupEnabled) {
            invoke('popup_get_foreground_process').then((name) => {
                setForegroundProcess(name);
            });
        }
    }, [popupEnabled]);

    // Refresh on every open: the user may have launched the app they want to
    // pick after this settings page was already loaded.
    useEffect(() => {
        if (pickerOpen) {
            loadApps();
        } else {
            setAppSearch('');
        }
    }, [pickerOpen, loadApps]);

    // The exe names are compared case-insensitively so the picker and the Rust
    // monitor agree on what counts as "already in the list".
    const addedSet = useMemo(
        () => new Set((processList || []).map((p) => p.toLowerCase())),
        [processList]
    );

    const filteredApps = useMemo(() => {
        const q = appSearch.trim().toLowerCase();
        if (!q) return apps;
        return apps.filter(
            (a) =>
                (a.process || '').toLowerCase().includes(q) ||
                (a.title || '').toLowerCase().includes(q)
        );
    }, [apps, appSearch]);

    async function handleEnable(v) {
        setPopupEnabled(v);
        await invoke('popup_set_enabled', { enabled: v });
        if (v) {
            toast.success(t('popup.enabled_success'), { style: toastStyle });
        }
    }

    // The popup monitor matches on the executable name, so a full path picked
    // from the file manager is reduced to its basename (and lowercased, to match
    // the Rust-side comparison).
    function baseName(path) {
        return String(path || '')
            .split(/[\\/]/)
            .pop()
            .trim();
    }

    // Adds one or more exe names in a single state write. useConfig's setter has
    // no functional-update form, so batching here (instead of looping over
    // addProcess) is what keeps a multi-file selection from collapsing to the
    // last entry.
    function addProcesses(names) {
        const toAdd = (names || [])
            .map((n) => (n || '').trim().toLowerCase())
            .filter(Boolean);
        if (toAdd.length === 0) return;
        const current = processList || [];
        const merged = [...current];
        toAdd.forEach((n) => {
            if (!merged.includes(n)) merged.push(n);
        });
        if (merged.length !== current.length) {
            setProcessList(merged);
        }
    }

    function addProcess(name) {
        addProcesses([name]);
    }

    function removeProcess(name) {
        setProcessList((processList || []).filter((p) => p !== name));
    }

    // Pick executables straight from the file manager. The running-app list above
    // only covers apps that currently own a visible window, so this is the way to
    // add something not running yet, a portable exe, or a Start Menu shortcut's
    // target.
    async function pickExeFile() {
        try {
            const selected = await open({
                multiple: true,
                directory: false,
                filters: [
                    {
                        name: '*.exe',
                        extensions: ['exe'],
                    },
                ],
            });
            if (!selected) return;
            const paths = Array.isArray(selected) ? selected : [selected];
            addProcesses(paths.map(baseName));
        } catch (e) {
            toast.error(e.toString(), { style: toastStyle });
        }
    }

    return (
        <div>
            <Toaster />
            <Card className='mb-[10px]'>
                <CardBody className='p-[10px]'>
                    <Switch
                        isSelected={popupEnabled || false}
                        onValueChange={handleEnable}
                        color='primary'
                        size='sm'
                    >
                        {t('popup.enable')}
                    </Switch>
                </CardBody>
            </Card>
            {popupEnabled ? (
                <Card className='mb-[10px]'>
                    <CardBody className='p-[10px]'>
                        <RadioGroup
                            label={t('popup.list_mode')}
                            orientation='horizontal'
                            value={listMode || 'blacklist'}
                            onValueChange={(v) => {
                                setListMode(v);
                            }}
                            size='sm'
                        >
                            <Radio value='whitelist'>{t('popup.whitelist')}</Radio>
                            <Radio value='blacklist'>{t('popup.blacklist')}</Radio>
                        </RadioGroup>
                        <p className='text-sm text-default-500 mt-[5px]'>
                            {listMode === 'whitelist'
                                ? t('popup.whitelist_desc')
                                : t('popup.blacklist_desc')}
                        </p>
                    </CardBody>
                </Card>
            ) : null}
            {popupEnabled ? (
                <Card className='mb-[10px]'>
                    <CardBody className='p-[10px]'>
                        <div className='flex items-center gap-[5px] mb-[10px]'>
                            <Popover
                                placement='bottom-start'
                                offset={8}
                                isOpen={pickerOpen}
                                onOpenChange={setPickerOpen}
                            >
                                <PopoverTrigger>
                                    {/* No onPress here: PopoverTrigger already toggles
                                        the popover on press, so adding our own would
                                        fire twice and cancel itself out. */}
                                    <Button
                                        size='sm'
                                        color='primary'
                                        variant='flat'
                                        startContent={<MdApps className='text-[16px]' />}
                                    >
                                        {t('popup.select_app')}
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className='p-[10px] w-[360px]'>
                                    <div className='w-full'>
                                        <div className='flex items-center gap-[5px]'>
                                            <Input
                                                size='sm'
                                                autoFocus
                                                isClearable
                                                onClear={() => {
                                                    setAppSearch('');
                                                }}
                                                placeholder={t('popup.select_app_search')}
                                                startContent={
                                                    <MdSearch className='text-[16px] text-default-400 shrink-0' />
                                                }
                                                value={appSearch}
                                                onValueChange={setAppSearch}
                                            />
                                            <Button
                                                size='sm'
                                                isIconOnly
                                                variant='flat'
                                                title={t('popup.select_app_refresh')}
                                                onPress={() => {
                                                    loadApps();
                                                }}
                                            >
                                                <MdRefresh className='text-[16px]' />
                                            </Button>
                                        </div>
                                        <div className='mt-[8px] max-h-[260px] overflow-y-auto overscroll-contain'>
                                            {appsLoading ? (
                                                <div className='flex justify-center py-[20px]'>
                                                    <Spinner size='sm' />
                                                </div>
                                            ) : filteredApps.length === 0 ? (
                                                <p className='text-sm text-default-500 text-center py-[20px]'>
                                                    {t('popup.select_app_empty')}
                                                </p>
                                            ) : (
                                                filteredApps.map((app) => {
                                                    const added = addedSet.has(
                                                        (app.process || '').toLowerCase()
                                                    );
                                                    return (
                                                        <button
                                                            key={app.process}
                                                            type='button'
                                                            disabled={added}
                                                            onClick={() => {
                                                                addProcess(app.process);
                                                            }}
                                                            className={`w-full text-left px-[8px] py-[6px] rounded-[6px] flex items-center justify-between gap-[8px] ${
                                                                added
                                                                    ? 'opacity-40 cursor-default'
                                                                    : 'hover:bg-default-100 cursor-pointer'
                                                            }`}
                                                        >
                                                            <span className='min-w-0'>
                                                                <span className='block text-sm truncate'>
                                                                    {app.process}
                                                                </span>
                                                                {app.title ? (
                                                                    <span className='block text-xs text-default-400 truncate'>
                                                                        {app.title}
                                                                    </span>
                                                                ) : null}
                                                            </span>
                                                            {added ? (
                                                                <span className='text-xs text-default-400 shrink-0'>
                                                                    {t('popup.select_app_added')}
                                                                </span>
                                                            ) : null}
                                                        </button>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </div>
                                </PopoverContent>
                            </Popover>
                            <Button
                                size='sm'
                                variant='flat'
                                color='primary'
                                startContent={<MdFolderOpen className='text-[16px]' />}
                                onPress={() => {
                                    pickExeFile();
                                }}
                            >
                                {t('popup.select_app_browse')}
                            </Button>
                        </div>
                        <div className='flex items-center gap-[5px] mb-[10px]'>
                            <Input
                                size='sm'
                                placeholder={t('popup.process_name_placeholder')}
                                value={newProcess}
                                onValueChange={setNewProcess}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        addProcess(newProcess);
                                        setNewProcess('');
                                    }
                                }}
                            />
                            <Button
                                size='sm'
                                color='primary'
                                isIconOnly
                                onPress={() => {
                                    addProcess(newProcess);
                                    setNewProcess('');
                                }}
                            >
                                <MdAdd className='text-[18px]' />
                            </Button>
                        </div>
                        {foregroundProcess ? (
                            <div className='mb-[10px]'>
                                <p className='text-sm text-default-500 mb-[5px]'>
                                    {t('popup.current_process')}: {foregroundProcess}
                                </p>
                                <Button
                                    size='sm'
                                    variant='flat'
                                    color='primary'
                                    startContent={<MdApps className='text-[16px]' />}
                                    onPress={() => {
                                        addProcess(foregroundProcess);
                                    }}
                                >
                                    {t('popup.add_current')}
                                </Button>
                            </div>
                        ) : null}
                        <div className='flex flex-wrap gap-[5px]'>
                            {(processList || []).map((process) => (
                                <Chip
                                    key={process}
                                    size='sm'
                                    variant='flat'
                                    onClose={() => {
                                        removeProcess(process);
                                    }}
                                >
                                    {process}
                                </Chip>
                            ))}
                        </div>
                    </CardBody>
                </Card>
            ) : null}
            {popupEnabled ? (
                <Card className='mb-[10px]'>
                    <CardBody className='p-[10px]'>
                        <div className='flex justify-between items-center'>
                            <p className='text-sm font-medium'>{t('popup.opacity')}</p>
                            <p className='text-sm text-default-500'>
                                {Math.round((popupOpacity ?? 1) * 100)}%
                            </p>
                        </div>
                        <Slider
                            size='sm'
                            aria-label={t('popup.opacity')}
                            minValue={0}
                            maxValue={1}
                            step={0.05}
                            value={popupOpacity ?? 1}
                            onChange={(v) => {
                                setPopupOpacity(Array.isArray(v) ? v[0] : v);
                            }}
                        />
                        <p className='text-sm font-medium mt-[10px] mb-[5px]'>
                            {t('popup.position_offset')}
                        </p>
                        <div className='flex gap-[10px]'>
                            <Input
                                type='number'
                                size='sm'
                                label={t('popup.offset_x')}
                                value={`${popupOffsetX ?? 8}`}
                                onValueChange={(v) => {
                                    setPopupOffsetX(parseInt(v, 10) || 0);
                                }}
                            />
                            <Input
                                type='number'
                                size='sm'
                                label={t('popup.offset_y')}
                                value={`${popupOffsetY ?? 8}`}
                                onValueChange={(v) => {
                                    setPopupOffsetY(parseInt(v, 10) || 0);
                                }}
                            />
                            <Input
                                type='number'
                                size='sm'
                                label={t('popup.fade_distance')}
                                value={`${popupFadeDistance ?? 140}`}
                                onValueChange={(v) => {
                                    setPopupFadeDistance(parseInt(v, 10) || 140);
                                }}
                            />
                        </div>
                    </CardBody>
                </Card>
            ) : null}
        </div>
    );
}
