import { invoke } from '@tauri-apps/api';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
    Button,
    Card,
    CardBody,
    Chip,
    Input,
    Radio,
    RadioGroup,
    Slider,
    Switch,
} from '@nextui-org/react';
import { MdAdd, MdApps } from 'react-icons/md';
import React, { useEffect, useState } from 'react';

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

    useEffect(() => {
        if (popupEnabled) {
            invoke('popup_get_foreground_process').then((name) => {
                setForegroundProcess(name);
            });
        }
    }, [popupEnabled]);

    async function handleEnable(v) {
        setPopupEnabled(v);
        await invoke('popup_set_enabled', { enabled: v });
        if (v) {
            toast.success(t('popup.enabled_success'), { style: toastStyle });
        }
    }

    function addProcess(name) {
        const trimmed = name.trim().toLowerCase();
        if (!trimmed) return;
        if (processList && processList.includes(trimmed)) return;
        setProcessList([...(processList || []), trimmed]);
    }

    function removeProcess(name) {
        setProcessList((processList || []).filter((p) => p !== name));
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
