import { Card, CardBody, Button, Chip, Code, Skeleton } from '@nextui-org/react';
import { fetch } from '@tauri-apps/api/http';
import React, { useEffect, useState } from 'react';
import { appWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/api/shell';
import toast, { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';

import { useConfig, useToastStyle } from '../../hooks';
import { appVersion, osType } from '../../utils/env';

// pot-MD ships from its own repository, so "check update" must read that
// repo's releases. The previous implementation used Tauri's built-in updater
// (checkUpdate/installUpdate), whose endpoint still points at upstream
// pot-app/pot-desktop AND whose manifest signature is made with upstream's
// private key -- so it could never describe, let alone install, a pot-MD
// build. Reading the GitHub Releases API instead gives us the real latest
// version + changelog; the actual download is handed to the browser.
const REPO = 'WalterMitty2005/pot-MD';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

// Split a tag into its numeric components so `1.0.10` > `1.0.9` (a plain
// string compare would get that backwards). Non-numeric chunks (e.g. the "MD"
// in "3.0.7-MD.8") are dropped rather than making the whole thing unparsable.
function parseVersion(v) {
    return String(v || '')
        .replace(/^v/i, '')
        .split(/[.\-+_]/)
        .filter((s) => /^\d+$/.test(s))
        .map((s) => parseInt(s, 10));
}

function isNewer(latest, current) {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    // Identical numeric core (or neither side carried digits at all): fall back
    // to a string compare so a suffix-only bump still counts as an update.
    const norm = (s) => String(s || '').replace(/^v/i, '');
    return norm(latest) !== norm(current);
}

export default function Updater() {
    const [transparent] = useConfig('transparent', true);
    const [body, setBody] = useState('');
    const [loading, setLoading] = useState(true);
    const [latest, setLatest] = useState('');
    const [downloadUrl, setDownloadUrl] = useState('');
    const { t } = useTranslation();
    const toastStyle = useToastStyle();

    useEffect(() => {
        if (appWindow.label === 'updater') {
            appWindow.show();
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(RELEASES_API, {
                    method: 'GET',
                    headers: {
                        Accept: 'application/vnd.github+json',
                        'User-Agent': 'pot-MD',
                    },
                });
                if (!res.ok) {
                    throw new Error(`GitHub API ${res.status}`);
                }
                const list = Array.isArray(res.data) ? res.data : [];
                // Prefer the newest full release; this fork's builds have been
                // published as pre-releases, so fall back to those rather than
                // reporting "no releases" forever.
                const release =
                    list.find((r) => !r.draft && !r.prerelease) ||
                    list.find((r) => !r.draft) ||
                    null;
                if (!release) {
                    throw new Error(t('updater.no_release'));
                }
                if (cancelled) return;

                const tag = release.tag_name || release.name || '';
                const asset = (release.assets || []).find((a) =>
                    /x64-setup\.exe$/i.test(a.name || '')
                );
                setLatest(tag);
                setDownloadUrl(
                    asset && asset.browser_download_url ? asset.browser_download_url : release.html_url
                );

                const notes = release.body || '';
                if (isNewer(tag, appVersion)) {
                    setBody(notes || t('updater.no_notes'));
                } else {
                    setBody(`${t('updater.latest')}\n\n${notes}`);
                }
            } catch (e) {
                if (cancelled) return;
                setBody(`### ${t('updater.failed')}\n\n\`${e.toString()}\``);
                toast.error(e.toString(), { style: toastStyle });
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const hasUpdate = latest !== '' && isNewer(latest, appVersion);

    return (
        <div
            className={`${transparent ? 'bg-background/90' : 'bg-background'} h-screen ${
                osType === 'Linux' && 'rounded-[10px] border-1 border-default-100'
            }`}
        >
            <Toaster />
            <div className='p-[5px] h-[35px] w-full select-none cursor-default'>
                <div
                    data-tauri-drag-region='true'
                    className={`h-full w-full flex ${osType === 'Darwin' ? 'justify-end' : 'justify-start'}`}
                >
                    <img
                        src='icon.png'
                        className='h-[25px] w-[25px] mr-[10px]'
                        draggable={false}
                    />
                    <h2>{t('updater.title')}</h2>
                </div>
            </div>
            <div className='flex items-center justify-center gap-[10px] mx-[80px] mt-[10px] flex-wrap'>
                <Chip
                    size='sm'
                    variant='flat'
                >
                    {t('updater.current_version')}: {appVersion || '-'}
                </Chip>
                <Chip
                    size='sm'
                    variant='flat'
                    color={hasUpdate ? 'success' : 'default'}
                >
                    {t('updater.latest_version')}: {latest || (loading ? '…' : '-')}
                </Chip>
            </div>
            <Card className='mx-[80px] mt-[10px] overscroll-auto h-[calc(100vh-190px)]'>
                <CardBody>
                    {loading ? (
                        <div className='space-y-3'>
                            <Skeleton className='w-3/5 rounded-lg'>
                                <div className='h-3 w-3/5 rounded-lg bg-default-200'></div>
                            </Skeleton>
                            <Skeleton className='w-4/5 rounded-lg'>
                                <div className='h-3 w-4/5 rounded-lg bg-default-200'></div>
                            </Skeleton>
                            <Skeleton className='w-2/5 rounded-lg'>
                                <div className='h-3 w-2/5 rounded-lg bg-default-300'></div>
                            </Skeleton>
                        </div>
                    ) : (
                        <ReactMarkdown
                            className='markdown-body select-text'
                            components={{
                                code: ({ node, ...props }) => {
                                    const { children } = props;
                                    return <Code size='sm'>{children}</Code>;
                                },
                                h2: ({ node, ...props }) => (
                                    <b>
                                        <h2
                                            className='text-[24px]'
                                            {...props}
                                        />
                                        <hr />
                                        <br />
                                    </b>
                                ),
                                h3: ({ node, ...props }) => (
                                    <b>
                                        <br />
                                        <h3
                                            className='text-[18px]'
                                            {...props}
                                        />
                                        <br />
                                    </b>
                                ),
                                li: ({ node, ...props }) => {
                                    const { children } = props;
                                    return (
                                        <li
                                            className='list-disc list-inside'
                                            children={children}
                                        />
                                    );
                                },
                            }}
                        >
                            {body}
                        </ReactMarkdown>
                    )}
                </CardBody>
            </Card>

            <div className='grid gap-4 grid-cols-2 h-[50px] my-[10px] mx-[80px]'>
                <Button
                    variant='flat'
                    color='primary'
                    isDisabled={loading}
                    onPress={() => {
                        open(downloadUrl || RELEASES_PAGE);
                    }}
                >
                    {hasUpdate ? t('updater.download') : t('updater.open_release')}
                </Button>
                <Button
                    variant='flat'
                    color='danger'
                    onPress={() => {
                        appWindow.close();
                    }}
                >
                    {t('updater.cancel')}
                </Button>
            </div>
        </div>
    );
}
