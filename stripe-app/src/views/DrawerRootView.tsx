/// <reference types="vite/client" />
import { useCallback, useEffect, useState } from 'react';
import { Banner, Box, Button, ContextView, Spinner } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import OverviewView from './OverviewView';
import { apiFetch, DASHBOARD_URL, installUrlFor, modeTitleSuffix, setActiveMode, type Mode } from '../api';
type Tier = 'standard' | 'pro';
interface SubscriptionResponse { tier: Tier | null; status: 'active' | 'none'; dev_pro?: boolean }
/**
 * Gate for the drawer default viewport. The drawer is the OPERATIONAL surface:
 * the overdue-invoice summary + controls (OverviewView). Plan & billing live in
 * the app's settings page (viewport "settings" → SettingsView)
 * per reviewer blocker 3c (2026-08-15), so the drawer deliberately has no
 * subscribe UI — free-plan merchants get a pointer to Settings instead.
 *
 * Unauthenticated merchants (no session cookie yet) get an inline "Connect your
 * Stripe account" card (the web onboarding flow lives on the dashboard).
 */
export default function DrawerRootView(props?: { environment?: ExtensionContextValue['environment'] }) {
  // Stripe supplies the active Dashboard mode ('live'|'test') via the
  // environment prop — register it so every apiFetch carries X-Stripe-Mode.
  const mode: Mode = props?.environment?.mode ?? 'live';
  setActiveMode(mode);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = `Collections Copilot${modeTitleSuffix(mode)}`;
  const loadSubscription = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnauthenticated(false);
    try {
      const response = await apiFetch('/subscription');
      if (response.status === 401) {
        setUnauthenticated(true);
        return;
      }
      if (!response.ok) throw new Error('Unable to check your subscription.');
      setSubscription((await response.json()) as SubscriptionResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to check your subscription.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void loadSubscription(); }, [loadSubscription]);
  if (loading) {
    return (
      <ContextView title={title}>
        <Box css={{ stack: 'y', gap: 'medium' }}>
          <Spinner />
        </Box>
      </ContextView>
    );
  }
  if (unauthenticated) {
    return (
      <ContextView
        title={title}
        externalLink={{ label: 'Open full dashboard', href: DASHBOARD_URL }}
      >
        <Box css={{ stack: 'y', gap: 'small' }}>
          <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Connect your Stripe account</Box>
          <Box css={{ color: 'secondary' }}>Sign in through Stripe Connect to start Collections Copilot.</Box>
          <Button type="primary" href={installUrlFor(mode)} target="_blank">Connect Stripe</Button>
          <Box css={{ color: 'secondary', font: 'caption' }}>Connecting opens a new tab. When you've finished onboarding there, come back and check your status.</Box>
          <Button type="secondary" onPress={() => { void loadSubscription(); }}>Check status</Button>
        </Box>
      </ContextView>
    );
  }
  if (error) {
    return (
      <ContextView
        title={title}
        externalLink={{ label: 'Open full dashboard', href: DASHBOARD_URL }}
      >
        <Box css={{ stack: 'y', gap: 'medium' }}>
          <Banner
            type="critical"
            title="Something went wrong"
            description={error}
            actions={<Button onPress={() => { void loadSubscription(); }}>Retry</Button>}
          />
        </Box>
      </ContextView>
    );
  }
  // Operational drawer: overdue-invoice summary + controls, then the web
  // dashboard escape hatch. Free-plan merchants get a de-emphasized pointer to
  // the Settings viewport for billing — no subscribe UI in the drawer.
  return (
    <Box css={{ stack: 'y', gap: 'small' }}>
      <OverviewView mode={mode} />
      {subscription?.status !== 'active' && (
        <Banner
          type="default"
          title="Free plan"
          description="Manage your plan and billing in the app's Settings view — open the app from the Apps menu, or use the web dashboard."
        />
      )}
      <Button href={DASHBOARD_URL} target="_blank" type="secondary">
        Open full dashboard
      </Button>
    </Box>
  );
}
