import { Divider, Button } from '@nextui-org/react';
import { appLogDir, appConfigDir } from '@tauri-apps/api/path';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/api/shell';
import { invoke } from '@tauri-apps/api';
import React from 'react';

import { appVersion } from '../../../../utils/env';

// Single source of truth for the fork's own pages. pot-MD lives in its own
// repository, so GitHub / issue links must point there instead of upstream
// pot-app/pot-desktop (otherwise bug reports land on the wrong project).
const REPO_URL = 'https://github.com/WalterMitty2005/pot-MD';
const ISSUES_URL = `${REPO_URL}/issues`;
// Upstream's official site: kept as a reference link, relabelled so users do
// not mistake it for this fork's site.
const UPSTREAM_SITE_URL = 'https://pot-app.com';

export default function About() {
    const { t } = useTranslation();

    return (
        <div className='h-full w-full py-[80px] px-[100px]'>
            <img
                src='icon.png'
                className='mx-auto h-[100px] mb-[5px]'
                draggable={false}
            />
            <div className='content-center'>
                <h1 className='font-bold text-2xl text-center'>pot-MD</h1>
                <p className='text-center text-sm text-gray-500 mb-[5px]'>{appVersion}</p>
                <Divider />
                <div className='flex justify-center gap-[20px]'>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={() => {
                            open(UPSTREAM_SITE_URL);
                        }}
                    >
                        {t('config.about.website')}
                    </Button>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={() => {
                            open(REPO_URL);
                        }}
                    >
                        {t('config.about.github')}
                    </Button>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={() => {
                            open(ISSUES_URL);
                        }}
                    >
                        {t('config.about.feedback')}
                    </Button>
                </div>
                <Divider />
            </div>
            <div className='content-center px-[40px]'>
                <div className='flex justify-between'>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={() => {
                            invoke('updater_window');
                        }}
                    >
                        {t('config.about.check_update')}
                    </Button>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={async () => {
                            const dir = await appLogDir();
                            open(dir);
                        }}
                    >
                        {t('config.about.view_log')}
                    </Button>
                    <Button
                        variant='light'
                        className='my-[5px]'
                        size='sm'
                        onPress={async () => {
                            const dir = await appConfigDir();
                            open(dir);
                        }}
                    >
                        {t('config.about.view_config')}
                    </Button>
                </div>

                <Divider />
            </div>
            <div className='content-center px-[40px] mt-[20px]'>
                <p className='text-center text-xs text-gray-500 leading-relaxed'>
                    本软件基于原开源项目二次修改，修改者：
                    <span
                        className='text-primary cursor-pointer underline'
                        onClick={() => {
                            open('https://github.com/WalterMitty2005');
                        }}
                    >
                        WalterMitty（GitHub：WalterMitty2005）
                    </span>
                    <br />
                    This software is modified based on the original open-source project. Modified by{' '}
                    <span
                        className='text-primary cursor-pointer underline'
                        onClick={() => {
                            open('https://github.com/WalterMitty2005');
                        }}
                    >
                        WalterMitty
                    </span>{' '}
                    (GitHub: WalterMitty2005).
                </p>
            </div>
        </div>
    );
}
