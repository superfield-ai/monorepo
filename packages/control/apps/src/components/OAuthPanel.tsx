/**
 * @file OAuthPanel
 *
 * Renders the Claude OAuth connection panel in the Studio chat sidebar.
 * All API calls are delegated to OAuthController — this component contains
 * no fetch() calls or direct localStorage access.
 *
 * Canonical docs: docs/studio-mode.md — "OAuth"
 */

import React, { useState, useEffect, useRef } from 'react';
import { Link, Unlink, Copy, Check, AlertCircle } from 'lucide-react';
import { OAuthController, type OAuthControllerState } from '../controllers/OAuthController';

interface OAuthPanelProps {
  /** Base URL for API calls; defaults to empty string (same origin) */
  baseUrl?: string;
  /** Optional pre-constructed controller instance (for testing) */
  controller?: OAuthController;
}

export function OAuthPanel({ baseUrl = '', controller: controllerProp }: OAuthPanelProps) {
  const controllerRef = useRef<OAuthController>(
    controllerProp ?? new OAuthController({ baseUrl }),
  );

  const [oauthState, setOauthState] = useState<OAuthControllerState>(
    controllerRef.current.getState(),
  );
  const [confirmationCode, setConfirmationCode] = useState('');
  const [copied, setCopied] = useState(false);

  // Subscribe to controller state changes
  useEffect(() => {
    const unsub = controllerRef.current.subscribe(setOauthState);
    void controllerRef.current.checkStatus();
    return unsub;
  }, []);

  function copyToClipboard() {
    if (oauthState.oauthUrl) {
      navigator.clipboard.writeText(oauthState.oauthUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const { status, oauthUrl, error, loading } = oauthState;

  if (loading) {
    return null;
  }

  if (status === 'connected') {
    return (
      <div className="px-4 py-3 border-b border-zinc-700 bg-zinc-800/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-400 text-sm">
            <Link size={16} />
            <span>Claude Code Connected</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-zinc-700 bg-zinc-800/50">
      {error && (
        <div className="mb-3 flex items-center gap-2 text-red-400 text-xs bg-red-900/20 px-3 py-2 rounded-lg">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {!oauthUrl ? (
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-400">Connect Claude Code</span>
          <button
            type="button"
            onClick={() => void controllerRef.current.initiateOAuth()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
          >
            <Unlink size={14} />
            Connect
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-zinc-400">
            <p className="font-medium text-zinc-300 mb-1">Authorization URL:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[10px] bg-zinc-900 px-2 py-1.5 rounded break-all">
                {oauthUrl}
              </code>
              <button
                type="button"
                onClick={copyToClipboard}
                className="p-1.5 bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
                aria-label="Copy URL"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          </div>

          <div className="text-xs text-zinc-400">
            <p className="font-medium text-zinc-300 mb-1">
              After authenticating, paste the confirmation code below:
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={confirmationCode}
                onChange={(e) => setConfirmationCode(e.target.value)}
                placeholder="Confirmation code"
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={() => void controllerRef.current.completeOAuth(confirmationCode)}
                disabled={status === 'pending' && oauthState.loading}
                className="px-3 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {oauthState.loading ? 'Connecting...' : 'Submit'}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => controllerRef.current.cancelPending()}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
