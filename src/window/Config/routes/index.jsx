import { Navigate } from 'react-router-dom';

import Translate from '../pages/Translate';
import Recognize from '../pages/Recognize';
import General from '../pages/General';
import Service from '../pages/Service';
import History from '../pages/History';
import Hotkey from '../pages/Hotkey';
import Backup from '../pages/Backup';
import About from '../pages/About';
import SelectionPopup from '../pages/SelectionPopup';

const routes = [
    {
        path: '/general',
        element: <General />,
    },
    {
        path: '/translate',
        element: <Translate />,
    },
    {
        path: '/recognize',
        element: <Recognize />,
    },
    {
        path: '/hotkey',
        element: <Hotkey />,
    },
    {
        path: '/selection_popup',
        element: <SelectionPopup />,
    },
    {
        path: '/service',
        element: <Service />,
    },
    {
        path: '/history',
        element: <History />,
    },
    {
        path: '/backup',
        element: <Backup />,
    },
    {
        path: '/about',
        element: <About />,
    },
    {
        path: '/',
        element: <Navigate to='/general' />,
    },
];

export default routes;
