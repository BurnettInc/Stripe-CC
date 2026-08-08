/// <reference types="vite/client" />

import { useCallback, useEffect, useState } from 'react';
import { Banner, Box, Button, ContextView, Spinner } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';
import SettingsView from './SettingsView';
import OnboardingView from './OnboardingView';

const BASE_URL = (import.meta as any).env?.VITE_BACKEND_URL ?? 'https://collectionscopilot.ctonew.app/api';

type Tier = 'standard' | 'pro';
interface SubscriptionResponse { tier: Tier | null; status: 'active' | 'none' }

/**
 * Gate for the drawer default viewport. Checks subscription status and routes
 * merchants to OnboardingView (plan selection) when they have no active
 * subscription, or SettingsView (Trust Mode) when they do.
 *
 * Unauthenticated merchants (no session cookie yet) are routed to SettingsView,
 * which already renders the "Connect your Stripe account" UI — OnboardingView
 * does not handle the no-OAuth state.
 */
export default function DrawerRootView(props?: { oauthContext?: ExtensionContextValue['oauthContext'] }) {
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSubscription = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnauthenticated(false);
    try {
      const response = await fetch(`${BASE_URL}/subscription`, { credentials: 'include' });
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
      <ContextView title="Collections Copilot">
        <Box css={{ stack: 'y', gap: 'medium' }}>
          <Spinner />
        </Box>
      </ContextView>
    );
  }

  if (unauthenticated) {
    // SettingsView renders the "Connect your Stripe account" UI for the
    // no-OAuth state, so it is the right fallback before onboarding.
    return <SettingsView {...props} />;
  }

  if (error) {
    return (
      <ContextView title="Collections Copilot">
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

  if (subscription?.status === 'active') {
    return <SettingsView {...props} />;
  }

  return <OnboardingView />;
}
