/**
 * @file main.tsx
 *
 * Browser entry point for the Calypso Studio UI.
 * Renders StudioPanel into #root.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { StudioPanel } from './components';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

createRoot(rootEl).render(<StudioPanel />);
