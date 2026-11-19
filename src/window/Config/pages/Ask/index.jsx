import { DropdownTrigger, DropdownMenu, DropdownItem } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
import { CardBody, Dropdown, Switch, Button, Card } from '@nextui-org/react';
import React, { useEffect, useState } from 'react';

import { useConfig } from '../../../../hooks/useConfig';
import { store } from '../../../../utils/store';
import { getServiceName } from '../../../../utils/service_instance';
import { supportsAsk } from '../../../Ask/utils';

/**
 * Settings for the AI Q&A window.
 *
 * The only real choice is *which* configured translation service answers the
 * questions, since Q&A has no prompt of its own -- it borrows the endpoint,
 * model and key from a translation instance. Only LLM instances are offered;
 * dictionary services (ecdict, bing_dict, ...) have no chat endpoint.
 */
export default function Ask() {
    const [markdownRender, setMarkdownRender] = useConfig('ask_markdown_render', true);
    const [preferred, setPreferred] = useConfig('ask_service_instance', '');
    const [instances, setInstances] = useState([]);
    const { t } = useTranslation();

    // The instance list lives in config, and each instance's display name lives
    // in its own config key -- so resolve them together for a readable label.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const list = (await store.get('translate_service_list')) ?? [];
            const rows = [];
            for (const key of Array.isArray(list) ? list : []) {
                const name = getServiceName(key);
                if (!supportsAsk(name)) continue;
                const cfg = (await store.get(key)) ?? {};
                const display = cfg.instanceName || t(`services.translate.${name}.title`);
                rows.push({ key, label: `${display} (${name})` });
            }
            if (!cancelled) setInstances(rows);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const currentLabel =
        instances.find((i) => i.key === preferred)?.label || t('config.ask.auto_instance');

    return (
        <>
            <Card className='mb-[10px]'>
                <CardBody>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.ask.service_instance')}</h3>
                        {preferred !== null && (
                            <Dropdown>
                                <DropdownTrigger>
                                    <Button variant='bordered'>{currentLabel}</Button>
                                </DropdownTrigger>
                                <DropdownMenu
                                    aria-label='ask service instance'
                                    className='max-h-[50vh] overflow-y-auto'
                                    onAction={(key) => {
                                        setPreferred(key === '__auto__' ? '' : key);
                                    }}
                                >
                                    <DropdownItem key='__auto__'>
                                        {t('config.ask.auto_instance')}
                                    </DropdownItem>
                                    {instances.map((item) => (
                                        <DropdownItem key={item.key}>{item.label}</DropdownItem>
                                    ))}
                                </DropdownMenu>
                            </Dropdown>
                        )}
                    </div>
                    <p className='text-sm text-default-500'>{t('config.ask.service_instance_desc')}</p>
                    <div className='config-item'>
                        <h3 className='my-auto mx-0'>{t('config.ask.markdown_render')}</h3>
                        {markdownRender !== null && (
                            <Switch
                                isSelected={markdownRender}
                                onValueChange={(v) => {
                                    setMarkdownRender(v);
                                }}
                            />
                        )}
                    </div>
                </CardBody>
            </Card>
        </>
    );
}
