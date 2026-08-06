/// <reference types="vite/client" />

import { useCallback, useEffect, useState } from 'react';
import { Banner, Box, Button, ContextView, Select, Spinner } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';

const BASE_URL = (import.meta as any).env?.VITE_BACKEND_URL ?? 'https://stripecollectionscopilot.ctonew.app/app';

type TrustMode = 'draft' | 'semi' | 'full';
type TrustModeValue = TrustMode | 'global';

type InvoiceDetails = {
  id: string;
  amount?: number;
  amount_due?: number;
  amountDue?: number;
  currency?: string;
  due_date?: string | number | null;
  dueDate?: string | number | null;
  customer_name?: string;
  customerName?: string;
  days_overdue?: number;
  daysOverdue?: number;
  escalation_stage?: number | string;
  escalationStage?: number | string;
  sequence?: {
    emails_sent?: number;
    emailsSent?: number;
    last_send_date?: string | null;
    lastSendDate?: string | null;
    next_scheduled?: string | null;
    nextScheduled?: string | null;
    active?: boolean;
    paused?: boolean;
  };
  sequence_status?: {
    emails_sent?: number;
    emailsSent?: number;
    last_send_date?: string | null;
    lastSendDate?: string | null;
    next_scheduled?: string | null;
    nextScheduled?: string | null;
    active?: boolean;
    paused?: boolean;
  };
  emails_sent?: number;
  emailsSent?: number;
  last_send_date?: string | null;
  lastSendDate?: string | null;
  next_scheduled?: string | null;
  nextScheduled?: string | null;
  sequence_active?: boolean;
  sequenceActive?: boolean;
  sequence_paused?: boolean;
  sequencePaused?: boolean;
};

interface TrustModeResponse { trustMode?: TrustMode | null; trust_mode?: TrustMode | null }

const trustModeOptions: Array<{ value: TrustModeValue; label: string }> = [
  { value: 'global', label: 'Use global default' },
  { value: 'draft', label: 'Draft' },
  { value: 'semi', label: 'Semi-Auto' },
  { value: 'full', label: 'Full Auto' },
];

function formatDate(value?: string | number | null): string {
  if (value === undefined || value === null || value === '') return 'Not scheduled';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

function formatAmount(invoice: InvoiceDetails): string {
  const amount = invoice.amount_due ?? invoice.amount;
  if (amount === undefined || amount === null) return 'Amount unavailable';
  return new Intl.NumberFormat(undefined, {
    style: 'currency', currency: (invoice.currency ?? 'usd').toUpperCase(),
  }).format(amount / 100);
}

type InvoiceDetailProps = {
  invoiceId?: string;
  environment?: ExtensionContextValue['environment'];
};

export default function InvoiceDetailView(props?: InvoiceDetailProps) {
  // Stripe supplies the current object through the extension environment for
  // dashboard detail viewports. Keep invoiceId for local/testing callers.
  const invoiceId = props?.invoiceId ?? props?.environment?.objectContext?.id ?? null;
  const [invoice, setInvoice] = useState<InvoiceDetails | null>(null);
  const [trustMode, setTrustMode] = useState<TrustModeValue>('global');
  const [loading, setLoading] = useState(Boolean(invoiceId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!invoiceId) return;
    setLoading(true);
    setError(null);
    try {
      const [invoiceResponse, modeResponse] = await Promise.all([
        fetch(`${BASE_URL}/invoices/${encodeURIComponent(invoiceId)}`),
        fetch(`${BASE_URL}/invoices/${encodeURIComponent(invoiceId)}/trust-mode`),
      ]);
      if (!invoiceResponse.ok || !modeResponse.ok) throw new Error('Unable to load invoice collection status.');
      const invoicePayload = (await invoiceResponse.json()) as InvoiceDetails | { invoice?: InvoiceDetails };
      const details = 'invoice' in invoicePayload && invoicePayload.invoice ? invoicePayload.invoice : invoicePayload as InvoiceDetails;
      const modePayload = (await modeResponse.json()) as TrustModeResponse;
      setInvoice({ ...details, id: details.id || invoiceId });
      setTrustMode(modePayload.trustMode ?? modePayload.trust_mode ?? 'global');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load invoice collection status.');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => { void load(); }, [load]);

  const saveTrustMode = async (value: TrustModeValue) => {
    if (!invoiceId) return;
    const previous = trustMode;
    setTrustMode(value);
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${BASE_URL}/invoices/${encodeURIComponent(invoiceId)}/trust-mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trust_mode: value === 'global' ? null : value }),
      });
      if (!response.ok) throw new Error('Could not save the invoice Trust Mode override.');
      const result = (await response.json()) as TrustModeResponse;
      setTrustMode(result.trustMode ?? result.trust_mode ?? value);
    } catch (cause) {
      setTrustMode(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save the invoice Trust Mode override.');
    } finally {
      setSaving(false);
    }
  };

  if (!invoiceId) {
    return <ContextView title="Collections Copilot"><Box css={{ color: 'secondary' }}>Select an invoice to view its collection status.</Box></ContextView>;
  }

  const sequence = invoice?.sequence ?? invoice?.sequence_status;
  const emailsSent = sequence?.emails_sent ?? sequence?.emailsSent ?? invoice?.emails_sent ?? invoice?.emailsSent ?? 0;
  const lastSendDate = sequence?.last_send_date ?? sequence?.lastSendDate ?? invoice?.last_send_date ?? invoice?.lastSendDate;
  const nextScheduled = sequence?.next_scheduled ?? sequence?.nextScheduled ?? invoice?.next_scheduled ?? invoice?.nextScheduled;
  const active = sequence?.active ?? invoice?.sequence_active ?? invoice?.sequenceActive;
  const paused = sequence?.paused ?? invoice?.sequence_paused ?? invoice?.sequencePaused;
  const stage = invoice?.escalation_stage ?? invoice?.escalationStage;

  return <ContextView title="Collections Copilot"><Box css={{ stack: 'y', gap: 'medium' }}>
    {error && <Banner type="critical" title="Something went wrong" description={error} actions={<Button onPress={() => { void load(); }}>Retry</Button>} />}
    {loading ? <Spinner /> : invoice ? <>
      <Box css={{ stack: 'y', gap: 'xsmall' }}>
        <Box css={{ font: 'heading', fontWeight: 'semibold' }}>{invoice.id}</Box>
        <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>{formatAmount(invoice)}</Box>
        <Box css={{ color: 'secondary' }}>{invoice.customer_name ?? invoice.customerName ?? 'Customer unavailable'}</Box>
        <Box css={{ color: 'secondary' }}>Due {formatDate(invoice.due_date ?? invoice.dueDate)} · {invoice.days_overdue ?? invoice.daysOverdue ?? 'Unknown'} days overdue</Box>
      </Box>
      <Box css={{ stack: 'y', gap: 'xsmall' }}>
        <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Collection sequence</Box>
        <Box css={{ color: 'secondary' }}>Escalation stage: {stage === undefined ? 'Not available' : `Stage ${stage}`}</Box>
        <Box css={{ color: paused ? 'secondary' : 'primary' }}>Status: {paused ? 'Paused' : active === false ? 'Inactive' : active === true ? 'Active' : 'Unknown'}</Box>
        <Box css={{ color: 'secondary' }}>Emails sent: {emailsSent}</Box>
        <Box css={{ color: 'secondary' }}>Last send: {formatDate(lastSendDate)}</Box>
        <Box css={{ color: 'secondary' }}>Next scheduled: {formatDate(nextScheduled)}</Box>
      </Box>
      <Box css={{ stack: 'y', gap: 'xsmall' }}>
        <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Trust Mode override</Box>
        <Box css={{ color: 'secondary' }}>Choose how Copilot handles this invoice, overriding the global default.</Box>
        <Select value={trustMode} disabled={saving} onChange={(event) => { void saveTrustMode(event.target.value as TrustModeValue); }}>
          {trustModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
        {saving && <Spinner />}
      </Box>
    </> : <Box css={{ color: 'secondary' }}>Invoice details are unavailable.</Box>}
  </Box></ContextView>;
}
