/// <reference types="vite/client" />

import { useCallback, useEffect, useState } from 'react';
import { Banner, Box, Button, ContextView, Spinner } from '@stripe/ui-extension-sdk/ui';
import { apiFetch, modeTitleSuffix, setActiveMode, type Mode } from '../api';

type InvoiceStatus = 'active' | 'paused' | 'awaiting_approval';
type PauseReason = 'manual' | 'reply' | null;

interface SummaryInvoice {
  id: number;
  stripe_invoice_id: string;
  customer_name: string;
  amount_due: number;
  currency: string;
  days_overdue: number;
  stage: number;
  status: InvoiceStatus;
  pause_reason: PauseReason;
}

interface RecentReminder {
  invoice_id: number;
  customer_name: string;
  amount_due: number;
  currency: string;
  stage: number;
  sent_at: string;
}

interface OverdueSummary {
  counts: { total: number; active: number; paused: number; awaiting_approval: number };
  invoices: SummaryInvoice[];
  recent_reminders: RecentReminder[];
}

/** Currency-aware amount formatter — mirrors InvoiceDetailView. */
function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: (currency ?? 'usd').toUpperCase(),
  }).format(cents / 100);
}

/** Date formatter — mirrors InvoiceDetailView's formatDate. */
function formatDate(value?: string | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

const statusLabel: Record<InvoiceStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  awaiting_approval: 'Awaiting approval',
};

/**
 * The drawer's substantive home for connected, subscribed merchants: an
 * at-a-glance overdue-invoice summary (count chips, per-invoice Pause/Resume
 * controls, recent reminders) fetched from GET /overdue/summary.
 *
 * A 401 (or any non-OK) response simply means there is no backend session yet
 * — render the small connect note, no error banner. Network-level failures
 * (fetch throws, e.g. CORS) surface the critical Banner with Retry, matching
 * the other views.
 */
export default function OverviewView(props?: { mode?: Mode }) {
  const mode: Mode = props?.mode ?? 'live';
  setActiveMode(mode);
  const [summary, setSummary] = useState<OverdueSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notConnected, setNotConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotConnected(false);
    try {
      const response = await apiFetch('/overdue/summary');
      if (!response.ok) {
        // 401 = no session yet (parent routing normally prevents this state).
        setNotConnected(true);
        return;
      }
      setSummary((await response.json()) as OverdueSummary);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load your overdue invoices.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const togglePause = async (invoice: SummaryInvoice) => {
    const resuming = invoice.status === 'paused';
    setActingOn(invoice.id);
    setError(null);
    try {
      const response = await apiFetch(`/tasks/${resuming ? 'resume' : 'pause'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: invoice.id }),
      });
      if (!response.ok) throw new Error(resuming ? 'Could not resume this invoice.' : 'Could not pause this invoice.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update this invoice.');
    } finally {
      setActingOn(null);
    }
  };

  const counts = summary?.counts ?? { total: 0, active: 0, paused: 0, awaiting_approval: 0 };
  const chips = [
    { label: 'Total', value: counts.total },
    { label: 'Active', value: counts.active },
    { label: 'Paused', value: counts.paused },
    { label: 'Awaiting approval', value: counts.awaiting_approval },
  ];

  return (
    <ContextView title={`Overdue invoices${modeTitleSuffix(mode)}`}>
      <Box css={{ stack: 'y', gap: 'medium' }}>
        {notConnected ? (
          <Box css={{ color: 'secondary' }}>
            Connect your Stripe account first to see overdue invoices.
          </Box>
        ) : error ? (
          <Banner
            type="critical"
            title="Something went wrong"
            description={error}
            actions={<Button onPress={() => { void load(); }}>Retry</Button>}
          />
        ) : loading && !summary ? (
          <Spinner />
        ) : summary ? (
          <>
            {/* Count chips */}
            <Box css={{ stack: 'x', wrap: 'wrap', gap: 'small' }}>
              {chips.map((chip) => (
                <Box
                  key={chip.label}
                  css={{ backgroundColor: 'surface', padding: 'small', borderRadius: 'medium', stack: 'y', gap: 'xsmall' }}
                >
                  <Box css={{ font: 'heading', fontWeight: 'semibold' }}>{chip.value}</Box>
                  <Box css={{ font: 'caption', color: 'secondary' }}>{chip.label}</Box>
                </Box>
              ))}
            </Box>

            {counts.total === 0 ? (
              <Box css={{ color: 'secondary' }}>
                No overdue invoices right now — you're all caught up.
              </Box>
            ) : (
              <Box css={{ stack: 'y', gap: 'small' }}>
                {summary.invoices.map((invoice) => {
                  const isPaused = invoice.status === 'paused';
                  const reason = isPaused && invoice.pause_reason === 'reply'
                    ? 'paused — customer replied'
                    : isPaused && invoice.pause_reason === 'manual'
                      ? 'paused — you paused it'
                      : null;
                  return (
                    <Box
                      key={invoice.id}
                      css={{ stack: 'y', gap: 'xsmall', backgroundColor: 'surface', padding: 'medium', borderRadius: 'medium' }}
                    >
                      <Box css={{ stack: 'x', gap: 'small', alignY: 'center' }}>
                        <Box css={{ stack: 'y', gap: 'xsmall', width: 'fill' }}>
                          <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>{invoice.customer_name}</Box>
                          <Box css={{ color: 'secondary', font: 'caption' }}>
                            {formatAmount(invoice.amount_due, invoice.currency)} · {invoice.days_overdue} days overdue · Stage {invoice.stage}
                          </Box>
                          <Box css={{ color: isPaused ? 'secondary' : 'primary', font: 'caption' }}>
                            {statusLabel[invoice.status]}{reason ? ` — ${reason}` : ''}
                          </Box>
                        </Box>
                        <Button
                          type={isPaused ? 'secondary' : 'primary'}
                          size="small"
                          disabled={actingOn === invoice.id}
                          onPress={() => { void togglePause(invoice); }}
                        >
                          {isPaused ? 'Resume' : 'Pause'}
                        </Button>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            )}

            {/* Recent reminders */}
            <Box css={{ stack: 'y', gap: 'xsmall' }}>
              <Box css={{ font: 'subheading', fontWeight: 'semibold' }}>Recent reminders</Box>
              {summary.recent_reminders.length === 0 ? (
                <Box css={{ color: 'secondary', font: 'caption' }}>No reminders sent yet.</Box>
              ) : (
                summary.recent_reminders.map((reminder, index) => (
                  <Box key={`${reminder.invoice_id}-${index}`} css={{ stack: 'y', gap: 'xsmall' }}>
                    <Box css={{ font: 'caption', fontWeight: 'semibold' }}>{reminder.customer_name}</Box>
                    <Box css={{ color: 'secondary', font: 'caption' }}>
                      {formatAmount(reminder.amount_due, reminder.currency)} · Stage {reminder.stage} · {formatDate(reminder.sent_at)}
                    </Box>
                  </Box>
                ))
              )}
            </Box>

            <Button type="secondary" disabled={loading} onPress={() => { void load(); }}>
              Refresh
            </Button>
          </>
        ) : null}
      </Box>
    </ContextView>
  );
}
