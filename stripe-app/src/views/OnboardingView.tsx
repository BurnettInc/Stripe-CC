/// <reference types="vite/client" />

import { useCallback, useEffect, useState } from 'react';
import { Banner, Box, Button, ContextView, Spinner } from '@stripe/ui-extension-sdk/ui';

const BASE_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3001';
type Tier = 'standard' | 'pro';
interface SubscriptionResponse { tier: Tier | null; status: 'active' | 'none' }
const plans: Array<{ tier: Tier; name: string; price: string; features: string[] }> = [
  { tier: 'standard', name: 'Standard', price: '$15/month', features: ['Up to 50 overdue invoices tracked', '3-stage escalation ladder', 'Custom sender branding', 'Weekly recovery reports', 'Trust Mode selector'] },
  { tier: 'pro', name: 'Pro', price: '$29/month', features: ['Everything in Standard', 'Unlimited overdue invoices', 'Custom escalation timing', 'Late-fee automation', 'Priority support'] },
];

export default function OnboardingView() {
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutTier, setCheckoutTier] = useState<Tier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSubscription = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${BASE_URL}/subscription`);
      if (!response.ok) throw new Error('Unable to check your subscription.');
      setSubscription((await response.json()) as SubscriptionResponse);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to check your subscription.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadSubscription(); }, [loadSubscription]);
  const subscribe = async (tier: Tier) => {
    setCheckoutTier(tier); setError(null);
    try {
      const merchantResponse = await fetch(`${BASE_URL}/merchant`);
      if (!merchantResponse.ok) throw new Error('Unable to identify your merchant account.');
      const merchant = (await merchantResponse.json()) as { id?: number };
      if (typeof merchant.id !== 'number') throw new Error('Merchant account is unavailable.');
      const response = await fetch(`${BASE_URL}/billing/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier, merchantId: merchant.id }) });
      if (!response.ok) throw new Error('Could not start checkout. Please try again.');
      const result = (await response.json()) as { url?: string };
      if (!result.url) throw new Error('Checkout did not return a valid URL.');
      window.location.assign(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start checkout. Please try again.'); setCheckoutTier(null); }
  };
  const activeTier = subscription?.status === 'active' ? subscription.tier : null;
  return <ContextView title="Collections Copilot"><Box css={{ stack: 'y', gap: 'medium' }}>
    <Box css={{ stack: 'y', gap: 'xsmall' }}><Box css={{ font: 'heading', fontWeight: 'semibold' }}>Welcome to Collections Copilot</Box><Box css={{ color: 'secondary' }}>Automatically send thoughtful, escalating reminders for overdue Stripe invoices and get paid on time.</Box></Box>
    {error && <Banner type="critical" title="Something went wrong" description={error} actions={<Button onPress={() => { void loadSubscription(); }}>Retry</Button>} />}
    {loading ? <Spinner /> : activeTier ? <Banner type="default" title={`You're on the ${activeTier} plan`} description="Your Collections Copilot subscription is active. Manage your collection settings from the Settings view." /> : <Box css={{ stack: 'y', gap: 'medium' }}>
      <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Choose your plan</Box>
      {plans.map((plan) => <Box key={plan.tier} css={{ stack: 'y', gap: 'small', backgroundColor: 'surface', padding: 'medium' }}><Box css={{ font: 'subheading', fontWeight: 'semibold' }}>{plan.name}</Box><Box css={{ font: 'heading', fontWeight: 'semibold' }}>{plan.price}</Box><Box css={{ stack: 'y', gap: 'xsmall' }}>{plan.features.map((feature) => <Box key={feature} css={{ color: 'primary' }}>• {feature}</Box>)}</Box><Button type="primary" disabled={checkoutTier !== null} onPress={() => { void subscribe(plan.tier); }}>{checkoutTier === plan.tier ? 'Loading…' : `Subscribe to ${plan.name}`}</Button></Box>)}
    </Box>}
  </Box></ContextView>;
}
