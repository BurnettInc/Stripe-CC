/// <reference types="vite/client" />

import { useCallback, useEffect, useState } from 'react';
import { Banner, Box, Button, ContextView, Spinner } from '@stripe/ui-extension-sdk/ui';
import { BASE_URL, LANDING_URL } from '../api';
type Tier = 'standard' | 'pro';
type TrustMode = 'draft' | 'semi_auto' | 'full_auto';
interface SubscriptionResponse { tier: Tier | null; status: 'active' | 'none' }
interface ConnectionResponse { connected: boolean; account_name?: string }

const plans: Array<{ tier: Tier; name: string; price: string; features: string[] }> = [
  { tier: 'standard', name: 'Standard', price: '$15/month', features: ['Up to 50 overdue invoices tracked', '3-stage escalation ladder', 'Custom sender branding', 'Weekly recovery reports', 'Trust Mode selector'] },
  { tier: 'pro', name: 'Pro', price: '$29/month', features: ['Everything in Standard', 'Unlimited overdue invoices', 'Custom escalation timing', 'Late-fee automation', 'Priority support'] },
];
const modes: Array<{ value: TrustMode; label: string; description: string }> = [
  { value: 'draft', label: 'Draft', description: 'Approve every email before it is sent.' },
  { value: 'semi_auto', label: 'Semi-Auto', description: 'Stage 1 reminders send automatically; later stages need approval.' },
  { value: 'full_auto', label: 'Full Auto', description: 'Fully hands-off follow-ups across every escalation stage.' },
];
const steps = ['Welcome', 'Connect', 'Plan', 'Trust Mode', 'Done'];

export default function OnboardingView() {
  const [step, setStep] = useState(0);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [connection, setConnection] = useState<ConnectionResponse | null>(null);
  const [trustMode, setTrustMode] = useState<TrustMode>('draft');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [subscriptionResponse, connectionResponse] = await Promise.all([
        fetch(`${BASE_URL}/subscription`, { credentials: 'include' }),
        fetch(`${BASE_URL}/stripe/connection`, { credentials: 'include' }),
      ]);
      if (!subscriptionResponse.ok || !connectionResponse.ok) throw new Error('Unable to load your setup status.');
      setSubscription((await subscriptionResponse.json()) as SubscriptionResponse);
      setConnection((await connectionResponse.json()) as ConnectionResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load your setup status.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const subscribe = async (tier: Tier) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${BASE_URL}/billing/checkout`, { credentials: 'include', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier }) });
      if (response.status === 401) throw new Error('Connect your Stripe account before subscribing.');
      if (!response.ok) throw new Error('Could not start checkout. Please try again.');
      const result = (await response.json()) as { url?: string };
      if (!result.url) throw new Error('Checkout did not return a valid URL.');
      window.location.assign(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start checkout. Please try again.'); setBusy(false); }
  };

  const saveTrustMode = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${BASE_URL}/settings`, { credentials: 'include', method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trust_mode: trustMode }) });
      if (!response.ok) throw new Error('Could not save Trust Mode. Please try again.');
      setStep(4);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save Trust Mode.'); }
    finally { setBusy(false); }
  };

  const activeTier = subscription?.status === 'active' ? subscription.tier : null;
  const advanceFromConnect = () => { setStep(activeTier ? 3 : 2); };
  return <ContextView title="Collections Copilot"><Box css={{ stack: 'y', gap: 'medium' }}>
    <Box css={{ stack: 'y', gap: 'small' }}>
      <Box css={{ font: 'caption', color: 'secondary' }}>{steps.map((label, index) => `${index < step ? '✓ ' : index === step ? '● ' : '○ '}${label}`).join('  →  ')}</Box>
      <Box css={{ font: 'heading', fontWeight: 'semibold' }}>Set up CollectionsCopilot</Box>
    </Box>
    {error && <Banner type="critical" title="Something went wrong" description={error} actions={<Button onPress={() => { setError(null); void loadStatus(); }}>Retry</Button>} />}
    {loading ? <Spinner /> : step === 0 ? <Box css={{ stack: 'y', gap: 'small' }}>
      <Box>CollectionsCopilot helps you get paid on time by sending thoughtful, personalized reminders for overdue Stripe invoices.</Box>
      <Button type="primary" onPress={() => setStep(connection?.connected ? (activeTier ? 3 : 2) : 1)}>Get Started</Button>
      <Box css={{ color: 'secondary' }}>Want to see the full product before you begin?</Box>
      <Button href={LANDING_URL} target="_blank">Learn more about plans and features</Button>
    </Box> : step === 1 ? <Box css={{ stack: 'y', gap: 'small' }}>
      <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Connect Stripe</Box>
      <Box css={{ color: 'secondary' }}>Connect the Stripe account whose overdue invoices you want CollectionsCopilot to monitor.</Box>
      {connection?.connected ? <Banner type="default" title="✓ Stripe connected" description={`Connected as ${connection.account_name || 'your Stripe account'}.`} /> : <Button type="primary" onPress={() => { window.location.href = `${BASE_URL}/stripe/connect`; }}>Connect Stripe</Button>}
      {connection?.connected && <Button onPress={advanceFromConnect}>Continue</Button>}
    </Box> : step === 2 ? <Box css={{ stack: 'y', gap: 'medium' }}>
      <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Choose your plan</Box>
      <Box css={{ color: 'secondary' }}>Start your collection workflow with a plan that fits your business.</Box>
      {plans.map((plan) => <Box key={plan.tier} css={{ stack: 'y', gap: 'small', backgroundColor: 'surface', padding: 'medium' }}><Box css={{ font: 'subheading', fontWeight: 'semibold' }}>{plan.name}</Box><Box css={{ font: 'heading', fontWeight: 'semibold' }}>{plan.price}</Box><Box css={{ stack: 'y', gap: 'xsmall' }}>{plan.features.map((feature) => <Box key={feature}>✓ {feature}</Box>)}</Box><Button type="primary" disabled={busy} onPress={() => { void subscribe(plan.tier); }}>{busy ? 'Loading…' : `Subscribe to ${plan.name}`}</Button></Box>)}
    </Box> : step === 3 ? <Box css={{ stack: 'y', gap: 'medium' }}>
      <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Choose your Trust Mode</Box><Box css={{ color: 'secondary' }}>Control how much autonomy CollectionsCopilot has when following up on overdue invoices.</Box>
      {modes.map((mode) => <Box key={mode.value} css={{ stack: 'y', gap: 'xsmall', backgroundColor: 'surface', padding: 'medium' }}><Button disabled={busy} onPress={() => setTrustMode(mode.value)}>{trustMode === mode.value ? `✓ ${mode.label}` : mode.label}</Button><Box css={{ color: 'secondary' }}>{mode.description}</Box></Box>)}
      <Button type="primary" disabled={busy} onPress={() => { void saveTrustMode(); }}>{busy ? 'Saving…' : 'Save and continue'}</Button>
    </Box> : <Box css={{ stack: 'y', gap: 'small' }}>
      <Banner type="default" title="You're all set!" description="CollectionsCopilot is ready to help you stay on top of overdue invoices." />
      <Box>Plan: <strong>{activeTier ? plans.find((plan) => plan.tier === activeTier)?.name : 'Active'}</strong></Box><Box>Trust Mode: <strong>{modes.find((mode) => mode.value === trustMode)?.label}</strong></Box><Box>Stripe: <strong>{connection?.connected ? 'Connected' : 'Not connected'}</strong></Box>
      <Button type="primary" href={`${BASE_URL}/dashboard`} target="_blank">Go to Dashboard</Button>
    </Box>}
  </Box></ContextView>;
}
