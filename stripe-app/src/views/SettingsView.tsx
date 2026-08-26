/// <reference types="vite/client" />

import { useCallback, useEffect, useState } from 'react';
import { Box, Button, ContextView, Select, Spinner, Banner } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import { apiFetch, BASE_URL, installUrlFor, modeTitleSuffix, setActiveMode, type Mode } from '../api';

type TrustMode = 'draft' | 'semi' | 'full';
type Tier = 'standard' | 'pro';

interface SubscriptionResponse {
  tier: Tier | null;
  status: 'active' | 'none';
  dev_pro?: boolean;
}
interface SettingsResponse { trust_mode: TrustMode }
interface ConnectionResponse { connected: boolean; account_name?: string }

const modes: Array<{ value: TrustMode; label: string; description: string }> = [
  { value: 'draft', label: 'Draft', description: 'You approve every email before it is sent.' },
  { value: 'semi', label: 'Semi-Auto', description: 'Stage 1 reminders send automatically; later stages need approval.' },
  { value: 'full', label: 'Full Auto', description: 'Fully hands-off follow-ups across every escalation stage.' },
];

const planNames: Record<Tier, string> = { standard: 'Standard', pro: 'Pro' };
const planPrices: Record<Tier, string> = { standard: '$7/month', pro: '$15/month' };

/**
 * App-level settings view (viewport "settings") — the home for account-level
 * configuration: plan & billing (subscribe / manage subscription), Trust Mode,
 * and Stripe connection status.
 *
 * Billing lives HERE (reviewer blocker 3c, 2026-08-15): the Dashboard drawer is
 * operational (overdue invoices), and plan/subscription management moved out of
 * it into this settings surface, which is where merchants expect account-level
 * config. The reviewer's message named the viewport "stripe.dashboard.app.settings";
 * that string is not accepted by the app schema/CLI, and neither is the
 * fullpage viewport for marketplace review (stripe.dashboard.fullpage is a
 * public-preview surface — apps declaring it fail submit-for-review with
 * "invalid request"). The stable, documented settings viewport is the bare
 * string "settings" (see docs.stripe.com/stripe-apps/app-settings), which is
 * what this view is registered for.
 */
export default function SettingsView(props?: { oauthContext?: ExtensionContextValue['oauthContext']; environment?: ExtensionContextValue['environment'] }) {
  const oauthContext = props?.oauthContext;
  const mode: Mode = props?.environment?.mode ?? 'live';
  setActiveMode(mode);
  const [trustMode, setTrustMode] = useState<TrustMode | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [connection, setConnection] = useState<ConnectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, subRes, connRes] = await Promise.all([
        apiFetch('/settings'),
        apiFetch('/subscription'),
        apiFetch('/stripe/connection'),
      ]);
      if (settingsRes.status === 401 || subRes.status === 401 || connRes.status === 401) {
        setUnauthenticated(true);
        return;
      }
      if (!settingsRes.ok || !subRes.ok || !connRes.ok) throw new Error('Unable to load Copilot settings.');
      setTrustMode(((await settingsRes.json()) as SettingsResponse).trust_mode);
      setSubscription((await subRes.json()) as SubscriptionResponse);
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
      const response = await apiFetch('/settings', {
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
  const active = subscription?.status === 'active' && (subscription.tier === 'standard' || subscription.tier === 'pro');
  const activeTier = active ? subscription.tier! : null;
  const planLabel = subscription?.dev_pro
    ? 'Pro (developer preview)'
    : activeTier
      ? `${planNames[activeTier]} — ${planPrices[activeTier]}`
      : 'Free plan';

  return (
    <ContextView title={`Collections Copilot${modeTitleSuffix(mode)}`}>
      <Box css={{ stack: 'y', gap: 'medium' }}>
        {unauthenticated ? (
          <Box css={{ stack: 'y', gap: 'small' }}>
            <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Connect your Stripe account</Box>
            <Box css={{ color: 'secondary' }}>Sign in through Stripe Connect to access Collections Copilot settings.</Box>
            <Button type="primary" href={installUrlFor(mode)} target="_blank">Connect Stripe</Button>
            <Box css={{ color: 'secondary', font: 'caption' }}>Connecting opens a new tab. When you've finished onboarding there, come back and check your status.</Box>
            <Button type="secondary" onPress={() => { void load(); }}>Check status</Button>
          </Box>
        ) : null}
        {!unauthenticated && (<>
        {/* Plan & billing — the settings viewport is the home for subscription
            management (reviewer blocker 3c). Subscribe buttons open Checkout in
            a new tab (GET /billing/checkout?tier=… 302s to Stripe); active
            subscribers manage via the Customer Portal (GET /billing/portal). */}
        <Box css={{ stack: 'y', gap: 'xsmall' }}>
          <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Plan &amp; billing</Box>
          {loading ? (
            <Spinner />
          ) : (
            <>
              <Box css={{ color: 'secondary' }}>Current plan</Box>
              <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>{planLabel}</Box>
              {activeTier ? (
                <Button type="secondary" href={`${BASE_URL}/billing/portal`} target="_blank">Manage subscription</Button>
              ) : (
                <>
                  <Box css={{ stack: 'x', gap: 'small', wrap: 'wrap' }}>
                    <Button type="primary" href={`${BASE_URL}/billing/checkout?tier=standard`} target="_blank">Subscribe to Standard — $7/mo</Button>
                    <Button type="primary" href={`${BASE_URL}/billing/checkout?tier=pro`} target="_blank">Subscribe to Pro — $15/mo</Button>
                  </Box>
                  <Box css={{ color: 'secondary', font: 'caption' }}>
                    Checkout opens in a new tab. Have a coupon? Apply it at checkout.
                  </Box>
                </>
              )}
            </>
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
