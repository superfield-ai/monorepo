/**
 * @file main.tsx
 *
 * Browser entry point for the Superfield Studio UI.
 * Renders ControlPanel into #root.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { ControlPanel } from './components';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

createRoot(rootEl).render(<ControlPanel />);
