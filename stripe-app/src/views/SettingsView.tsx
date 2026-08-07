/// <reference types="vite/client" />

import { useCallback, useEffect, useState } from 'react';
import { Box, Button, ContextView, Select, Spinner, Banner } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';

const BASE_URL = (import.meta as any).env?.VITE_BACKEND_URL ?? 'https://collectionscopilot.ctonew.app/app';

type TrustMode = 'draft' | 'semi' | 'full';

const modes: Array<{ value: TrustMode; label: string; description: string }> = [
  { value: 'draft', label: 'Draft', description: 'You approve every email before it is sent.' },
  { value: 'semi', label: 'Semi-Auto', description: 'Stage 1 reminders send automatically; later stages need approval.' },
  { value: 'full', label: 'Full Auto', description: 'Fully hands-off follow-ups across every escalation stage.' },
];

interface SettingsResponse { trust_mode: TrustMode }
interface ConnectionResponse { connected: boolean; account_name?: string }

export default function SettingsView(props?: { oauthContext?: ExtensionContextValue['oauthContext'] }) {
  const oauthContext = props?.oauthContext;
  const [trustMode, setTrustMode] = useState<TrustMode | null>(null);
  const [connection, setConnection] = useState<ConnectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, connRes] = await Promise.all([
        fetch(`${BASE_URL}/settings`, { credentials: 'include' }),
        fetch(`${BASE_URL}/stripe/connection`, { credentials: 'include' }),
      ]);
      if (settingsRes.status === 401 || connRes.status === 401) {
        setUnauthenticated(true);
        return;
      }
      if (!settingsRes.ok || !connRes.ok) throw new Error('Unable to load Copilot settings.');
      setTrustMode(((await settingsRes.json()) as SettingsResponse).trust_mode);
      setConnection((await connRes.json()) as ConnectionResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Listen for OAuth popup completion signal
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data === 'oauth-complete') {
        void load();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [load]);

  const save = async (value: TrustMode) => {
    const previous = trustMode;
    setTrustMode(value);
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${BASE_URL}/settings`, {
        credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trust_mode: value }),
      });
      if (!response.ok) throw new Error('Could not save Trust Mode.');
      setTrustMode(((await response.json()) as SettingsResponse).trust_mode ?? value);
    } catch (cause) {
      setTrustMode(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save Trust Mode.');
    } finally {
      setSaving(false);
    }
  };

  const accountName = connection?.account_name;

  return (
    <ContextView title="Collections Copilot">
      <Box css={{ stack: 'y', gap: 'medium' }}>
        {unauthenticated ? (
          <Box css={{ stack: 'y', gap: 'small' }}>
            <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Connect your Stripe account</Box>
            <Box css={{ color: 'secondary' }}>Sign in through Stripe Connect to access Collections Copilot settings.</Box>
            <Button
              onPress={() => {
                const width = 800;
                const height = 700;
                const left = (window.screen.width - width) / 2;
                const top = (window.screen.height - height) / 2;
                window.open(
                  `${BASE_URL}/stripe/connect`,
                  'stripe-connect',
                  `width=${width},height=${height},left=${left},top=${top}`,
                );
              }}
            >
              Connect Stripe
            </Button>
          </Box>
        ) : null}
        {!unauthenticated && (<>
        {/* Connection status */}
        <Box css={{ stack: 'y', gap: 'xsmall' }}>
          <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Stripe connection</Box>
          {loading ? (
            <Spinner />
          ) : connection?.connected || oauthContext ? (
            <Box css={{ color: 'primary' }}>Connected as {accountName || 'your Stripe account'}</Box>
          ) : (
            <Box css={{ color: 'secondary' }}>Not connected — connect your Stripe account</Box>
          )}
        </Box>

        {/* Trust Mode selector */}
        <Box css={{ stack: 'y', gap: 'xsmall' }}>
          <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Trust Mode</Box>
          <Box css={{ color: 'secondary' }}>
            Control how autonomous Copilot is when handling overdue invoices.
          </Box>
          {loading ? (
            <Spinner />
          ) : (
            <Select
              value={trustMode ?? undefined}
              disabled={saving}
              onChange={(event) => {
                void save(event.target.value as TrustMode);
              }}
            >
              {modes.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
          {trustMode && (
            <Box css={{ color: 'secondary', font: 'caption' }}>
              {modes.find((mode) => mode.value === trustMode)?.description}
            </Box>
          )}
        </Box>

        {/* Error banner */}
        {error && (
          <Banner
            type="critical"
            title="Something went wrong"
            description={error}
            actions={<Button onPress={() => { void load(); }}>Retry</Button>}
          />
        )}
        </>)}
      </Box>
    </ContextView>
  );
}
