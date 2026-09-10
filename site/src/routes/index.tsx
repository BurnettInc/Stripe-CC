import { useState, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { readFile } from "node:fs/promises";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  Check,
  TYPE,
} from "../components/ui";

const INSTALL_URL =
  "https://marketplace.stripe.com/apps/install/link/com.stripecollectionscopilot.app?redirect_uri=https%3A%2F%2Fstripe-cc-production.up.railway.app%2Foauth%2Fcallback&state=CC_VID";

const getBusinessName = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const cfg = JSON.parse(await readFile("site.json", "utf8")) as {
      businessName?: string;
    };
    return cfg.businessName?.trim() ?? "";
  } catch {
    return "";
  }
});

export const Route = createFileRoute("/")({
  loader: () => getBusinessName(),
  component: Home,
});

function TrustBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[15px] font-medium text-ink">
      <svg
        width="16"
        height="16"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          d="M2.5 7.25 5.5 10.25 11.5 3.75"
          stroke="#5B4FE0"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </span>
  );
}

function Home() {
  const businessName = Route.useLoaderData();
  return (
    <div className="min-h-dvh">
      <SiteNav businessName={businessName} />

      {/* 2. Hero — approx 55/45 split */}
      <section className="max-w-6xl mx-auto px-6 pt-14 pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-[55fr_45fr] gap-12 items-center">
          <div className="text-left">
            <div className="mb-6 flex flex-wrap gap-x-5 gap-y-2">
              <TrustBadge label="Stripe-native" />
              <TrustBadge label="No credit card required" />
              <TrustBadge label="Cancel anytime" />
            </div>
            <h1 className={TYPE.hero}>Stop chasing unpaid invoices.</h1>
            <p className={`mt-6 max-w-[46ch] ${TYPE.bodyLg}`}>
              Collections Copilot automatically follows up with customers when
              Stripe invoices go overdue — so you can get paid without sending
              another awkward reminder.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-4">
              <div className="flex flex-col items-center sm:items-start">
                <a href={INSTALL_URL} className={BTN_PRIMARY}>
                  Download from Stripe Marketplace
                </a>
                <p className="mt-3 text-[13px] text-muted">
                  Connects to your real Stripe account
                </p>
              </div>
              <div className="flex flex-col items-center sm:items-start">
                <a href="/demo" className={BTN_SECONDARY}>
                  See the demo
                </a>
                <p className="mt-3 text-[13px] text-muted">
                  No Stripe connection needed
                </p>
              </div>
            </div>
          </div>

          {/* Right: real invoice example card */}
          <div>
            <div className="mx-auto max-w-md rounded-[14px] border border-hairline bg-white shadow-sm p-6">
              <p className="font-display text-[36px] sm:text-[44px] font-semibold tracking-[-0.01em] text-ink leading-none">
                $450 overdue
              </p>
              <p className="mt-2 text-[13px] text-muted">
                Acme Design Co. — Invoice #1048 · 14 days late
              </p>
              <div className="mt-5 border-t border-hairline pt-4">
                <div className="relative pl-6">
                  <span
                    aria-hidden="true"
                    className="absolute left-[5px] top-2 bottom-2 w-px bg-hairline"
                  />
                  <div className="relative flex items-center justify-between gap-3 py-2">
                    <span
                      aria-hidden="true"
                      className="absolute top-1/2 h-[11px] w-[11px] -translate-y-1/2 rounded-full border border-hairline bg-white"
                      style={{ left: "-24px" }}
                    />
                    <p className="text-[13.5px] text-ink">
                      Day 1 — Friendly reminder sent
                    </p>
                    <span className="shrink-0 text-[13px] text-muted">
                      (Delivered)
                    </span>
                  </div>
                  <div className="relative flex items-center justify-between gap-3 py-2">
                    <span
                      aria-hidden="true"
                      className="absolute top-1/2 h-[11px] w-[11px] -translate-y-1/2 rounded-full border border-hairline bg-white"
                      style={{ left: "-24px" }}
                    />
                    <p className="text-[13.5px] text-ink">
                      Day 4 — Second follow-up sent
                    </p>
                    <span className="shrink-0 text-[13px] text-muted">
                      (Delivered)
                    </span>
                  </div>
                  <div className="relative flex items-center justify-between gap-3 py-2">
                    <span
                      aria-hidden="true"
                      className="absolute top-1/2 h-[13px] w-[13px] -translate-y-1/2 rounded-full bg-success-text ring-4 ring-success-bg"
                      style={{ left: "-25px" }}
                    />
                    <p className="font-display text-[17px] font-semibold text-success-text">
                      Customer paid — $450
                    </p>
                    <span className="shrink-0 text-[13px] font-medium text-success-text">
                      (Paid)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. From overdue to paid, automatically */}
      <section className="max-w-6xl mx-auto px-6 py-8">
        <div className="rounded-3xl bg-band px-6 py-14 sm:px-12">
          <h2 className={`${TYPE.h2} text-center`}>
            From overdue to paid, automatically.
          </h2>
          <p className={`mt-4 text-center max-w-2xl mx-auto ${TYPE.bodyLg}`}>
            Collections Copilot detects overdue invoices, sends the right
            follow-ups, and stops the moment the customer pays.
          </p>
          <div className="relative mt-10">
            <span
              aria-hidden="true"
              className="absolute left-4 right-4 top-4 hidden h-px bg-hairline lg:block"
            />
            <div className="relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              {
                n: "1",
                title: "Invoice overdue",
                desc: "Detected automatically from your Stripe account.",
              },
              {
                n: "2",
                title: "Follow-ups sent",
                desc: "Personalized, escalating reminder emails.",
              },
              {
                n: "3",
                title: "Customer pays",
                desc: "Money goes straight to your Stripe account.",
              },
              {
                n: "4",
                title: "Paid — $450",
                desc: "No chasing. No awkward follow-up emails.",
                paid: true,
              },
            ].map((s) => (
              <div key={s.n} className="text-center sm:text-left">
                {s.paid ? (
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-success-bg ring-2 ring-success-text">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M3 8.5 6.5 12 13 4.5"
                        stroke="#1C6B4E"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                ) : (
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand font-display text-[15px] font-semibold text-white">
                    {s.n}
                  </span>
                )}
                <p className="mt-3 text-[15px] font-semibold text-ink">
                  {s.title}
                </p>
                <p className="mt-1 text-[13.5px] text-muted leading-relaxed">
                  {s.desc}
                </p>
              </div>
            ))}
            </div>
          </div>
        </div>
      </section>

      {/* 4. Dashboard + trust ladder */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 lg:grid-cols-[55fr_45fr] gap-12 items-center">
          {/* Left: product-screenshot-style card */}
          <div className="overflow-hidden rounded-[14px] border border-hairline bg-white shadow-sm">
            <div className="border-b border-hairline bg-band px-5 py-3">
              <p className="text-[15px] font-semibold text-ink">
                Overdue invoices
              </p>
            </div>
            <div className="border-b border-hairline px-5 py-4">
              <p className="text-[13px] text-muted">Currently overdue</p>
              <p className="mt-1 font-display text-[28px] font-semibold leading-none text-warn-text">
                $1,935
              </p>
              <p className="mt-1.5 text-[13px] text-muted">
                4 invoices need attention
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="border-b border-hairline text-left">
                    <th
                      scope="col"
                      className="px-5 py-3 font-medium text-muted"
                    >
                      Customer
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-3 font-medium text-muted"
                    >
                      Amount
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-3 font-medium text-muted"
                    >
                      Status
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-right font-medium text-muted"
                    >
                      Copilot
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {[
                    { name: "Acme Design Co.", amount: "$450", late: "14 days late" },
                    { name: "Brightworks Studio", amount: "$230", late: "9 days late" },
                    { name: "Northwind Traders", amount: "$1,180", late: "6 days late" },
                    { name: "Harbor & Finch", amount: "$75", late: "3 days late" },
                  ].map((row) => (
                    <tr key={row.name}>
                      <td className="px-5 py-3 font-medium text-ink whitespace-nowrap">
                        {row.name}
                      </td>
                      <td className="px-3 py-3 font-display font-semibold text-ink whitespace-nowrap">
                        {row.amount}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <span className="inline-block rounded-full bg-warn-bg px-2.5 py-0.5 text-[13px] font-medium text-warn-text">
                          {row.late}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span
                          className="inline-flex h-6 w-11 items-center rounded-full bg-brand px-0.5"
                          role="switch"
                          aria-checked="true"
                          aria-label={`Copilot on for ${row.name}`}
                        >
                          <span className="ml-auto h-5 w-5 rounded-full bg-white" />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right: trust ladder */}
          <div>
            <h2 className={TYPE.h2}>You stay in control.</h2>
            <p className={`mt-4 ${TYPE.bodyLg}`}>
              Choose how much control to hand over, with a trust ladder you move
              up as you get comfortable — and can dial back anytime.
            </p>
            <TrustLadder />
          </div>
        </div>
      </section>

      {/* 5. Trust strip */}
      <section className="max-w-6xl mx-auto px-6 py-8">
        <div className="rounded-3xl bg-band px-6 py-14 sm:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
            <div>
              <h2 className={TYPE.h2}>
                Built for Stripe. Read-only by design.
              </h2>
              <p className={`mt-4 ${TYPE.bodyLg}`}>
                Collections Copilot connects directly to your Stripe account
                with read-only access. It can&apos;t edit invoices, charge
                customers, or change payment methods.
              </p>
              <a
                href="/trust"
                className="mt-4 inline-block text-[15px] font-medium text-brand-deep hover:underline"
              >
                See exactly what data we access →
              </a>
            </div>
            <div className="space-y-5">
              {[
                {
                  title: "Stripe connection",
                  desc: "No separate payment system — works with your existing invoices.",
                  icon: (
                    <path
                      d="M9 15.5 15.5 9m0 0H11m4.5 0V13.5M5 8.5 11.5 2M11.5 2H7m4.5 0v4.5"
                      stroke="#5B4FE0"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ),
                },
                {
                  title: "Message control",
                  desc: "Review and customize every sequence before it sends.",
                  icon: (
                    <path
                      d="M3 5.5A1.5 1.5 0 0 1 4.5 4h9A1.5 1.5 0 0 1 15 5.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3.6 2.9a.4.4 0 0 1-.65-.3V5.5Z"
                      stroke="#5B4FE0"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ),
                },
                {
                  title: "Read-only access",
                  desc: "Customers still pay through your existing Stripe checkout.",
                  icon: (
                    <path
                      d="M9 2.8 4.2 4.6v4c0 3.2 2 5.7 4.8 6.6 2.8-.9 4.8-3.4 4.8-6.6v-4L9 2.8Zm2.6 5.4-2.2 2.2-.9-.9"
                      stroke="#5B4FE0"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ),
                },
              ].map((row) => (
                <div key={row.title} className="flex items-start gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white border border-hairline">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 18 18"
                      fill="none"
                      aria-hidden="true"
                    >
                      {row.icon}
                    </svg>
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink">{row.title}</p>
                    <p className="mt-0.5 text-[13px] text-muted leading-relaxed">
                      {row.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 6. Pricing */}
      <section id="pricing" className="max-w-6xl mx-auto px-6 py-16">
        <h2 className={TYPE.h2Center}>Simple, transparent pricing</h2>
        <p className={`mt-4 text-center ${TYPE.bodyLg}`}>
          Start free. Upgrade when you&apos;re ready. No hidden fees.
        </p>
        <div className="mt-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
          {/* Free */}
          <div className="flex flex-col rounded-[14px] border border-hairline bg-white p-7 shadow-sm">
            <h3 className="text-base font-semibold text-ink">
              Free — Draft Mode
            </h3>
            <p className="mt-3 font-display text-[30px] font-semibold text-ink leading-none">
              $0
            </p>
            <p className="mt-1.5 text-[13px] text-muted">
              Free forever, no card required.
            </p>
            <ul className="mt-5 space-y-2.5 text-[13.5px] text-ink">
              {[
                "Unlimited AI-drafted reminders",
                "Connect your real Stripe invoices",
                "Review every email before sending",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            <a
              href={INSTALL_URL}
              className={`${BTN_SECONDARY} mt-6 w-full !px-4 !py-2.5 !text-[15px]`}
            >
              Try it free
            </a>
          </div>

          {/* Standard */}
          <div className="flex flex-col rounded-[14px] border border-hairline bg-white p-7 shadow-sm">
            <h3 className="text-base font-semibold text-ink">Standard</h3>
            <p className="mt-3 font-display text-[30px] font-semibold text-ink leading-none">
              $7<span className="font-sans text-[15px] font-normal text-muted">/mo</span>
            </p>
            <p className="mt-1.5 text-[13px] text-muted">
              or $50/year — save $34.
            </p>
            <ul className="mt-5 space-y-2.5 text-[13.5px] text-ink">
              {[
                "Up to 50 invoices tracked",
                "3-stage escalation ladder",
                "Custom sender branding",
                "Weekly recovery reports",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            <a
              href={INSTALL_URL}
              className={`${BTN_SECONDARY} mt-6 w-full !px-4 !py-2.5 !text-[15px]`}
            >
              Get started
            </a>
          </div>

          {/* Pro — most popular */}
          <div className="flex flex-col rounded-[14px] border-2 border-brand bg-white p-7 pb-8 shadow-sm">
            <span className="inline-block w-fit rounded-full bg-brand px-2.5 py-0.5 text-xs font-medium text-white">
              Most popular
            </span>
            <h3 className="mt-2.5 text-base font-semibold text-ink">Pro</h3>
            <p className="mt-3 font-display text-[30px] font-semibold text-ink leading-none">
              $15<span className="font-sans text-[15px] font-normal text-muted">/mo</span>
            </p>
            <p className="mt-1.5 text-[13px] text-muted">
              or $100/year — save $80.
            </p>
            <p className="mt-1.5 text-[13px] text-muted">
              Every feature unlocked.
            </p>
            <ul className="mt-5 space-y-2.5 text-[13.5px] text-ink">
              {[
                "Everything in Standard",
                "Unlimited invoices tracked",
                "Open and click tracking",
                "Late-fee automation",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            <a
              href={INSTALL_URL}
              className={`${BTN_PRIMARY} mt-6 w-full !px-4 !py-2.5 !text-[15px]`}
            >
              Get started
            </a>
            <p className="mt-5 mb-0 text-[11px] leading-snug text-muted/80">
              Late fee legality and limits vary by state/country — you&apos;re
              responsible for confirming your late fee terms comply with
              applicable law before enabling this feature.
            </p>
          </div>

          {/* Calculator */}
          <CalculatorCard />
        </div>
      </section>

      <SiteFooter businessName={businessName} />
    </div>
  );
}

function CalculatorCard() {
  const [avg, setAvg] = useState(450);
  const [count, setCount] = useState(6);
  const total = (Number.isFinite(avg) ? avg : 0) * (Number.isFinite(count) ? count : 0);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(total);
  return (
    <div className="flex flex-col rounded-[14px] bg-band p-7">
      <h3 className="text-base font-semibold text-ink">
        How much are overdue invoices costing you?
      </h3>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-[13px] font-medium text-muted">
            Avg. overdue invoice
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={Number.isFinite(avg) ? avg : ""}
            onChange={(e) =>
              setAvg(e.target.value === "" ? NaN : Number(e.target.value))
            }
            className="mt-1.5 w-full rounded-lg border border-hairline bg-white px-3 py-2 text-[15px] text-ink focus:border-brand focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-[13px] font-medium text-muted">
            Invoices overdue
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={Number.isFinite(count) ? count : ""}
            onChange={(e) =>
              setCount(e.target.value === "" ? NaN : Number(e.target.value))
            }
            className="mt-1.5 w-full rounded-lg border border-hairline bg-white px-3 py-2 text-[15px] text-ink focus:border-brand focus:outline-none"
          />
        </label>
      </div>
      <p className="mt-4 font-display text-xl font-semibold text-brand-deep">
        {formatted} potentially unpaid
      </p>
      <p className="mt-2 text-[13px] text-muted leading-relaxed">
        Standard costs $7/month. Recover one invoice and it&apos;s already paid
        for itself.
      </p>
    </div>
  );
}

const TRUST_MODES = [
  {
    id: "draft",
    label: "Draft Mode",
    title: "Draft Mode",
    body: "AI writes reminders. You review and send manually.",
  },
  {
    id: "semi",
    label: "Semi-Auto",
    title: "Semi-Auto",
    body: "Friendly reminders send automatically. You approve escalation.",
  },
  {
    id: "copilot",
    label: "Copilot Mode",
    title: "Copilot Mode",
    body: "End-to-end: drafts, sends, and follow-ups handled automatically until paid.",
  },
] as const;

type TrustModeId = (typeof TRUST_MODES)[number]["id"];

function TrustLadder() {
  const [active, setActive] = useState<TrustModeId>("semi");
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const current = TRUST_MODES.find((m) => m.id === active)!;

  const dotLeft = (id: TrustModeId) =>
    id === "draft" ? "1.5rem" : id === "semi" ? "50%" : "calc(100% - 1.5rem)";

  const selectFromPointer = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (TRUST_MODES.length - 1));
    setActive(TRUST_MODES[idx].id);
  };

  return (
    <div className="mt-6">
      <div
        ref={trackRef}
        role="slider"
        aria-label="Trust mode"
        aria-valuemin={0}
        aria-valuemax={TRUST_MODES.length - 1}
        aria-valuenow={TRUST_MODES.findIndex((m) => m.id === active)}
        className="relative h-12 cursor-pointer touch-none select-none"
        onPointerDown={(e) => {
          dragging.current = true;
          trackRef.current?.setPointerCapture?.(e.pointerId);
          selectFromPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) selectFromPointer(e.clientX);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <span
          aria-hidden="true"
          className="absolute left-6 right-6 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-hairline"
        />
        <span
          aria-hidden="true"
          className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-brand transition-all duration-150"
          style={{
            left: "1.5rem",
            right:
              active === "draft" ? "calc(100% - 1.5rem)" : active === "semi" ? "50%" : "1.5rem",
          }}
        />
        {TRUST_MODES.map((m) => (
          <span
            key={m.id}
            aria-hidden="true"
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-150 ${
              active === m.id
                ? "h-5 w-5 bg-brand ring-4 ring-brand/20"
                : "h-4 w-4 border-2 border-hairline bg-white"
            }`}
            style={{ left: dotLeft(m.id) }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[13.5px]">
        {TRUST_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setActive(m.id)}
            aria-pressed={active === m.id}
            className={
              active === m.id
                ? "font-semibold text-brand-deep"
                : "text-muted hover:text-ink"
            }
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-[14px] border border-hairline bg-white p-5 shadow-sm">
        <p className="text-[15px] font-semibold text-ink">{current.title}</p>
        <p className="mt-1.5 text-[13px] text-muted leading-relaxed">{current.body}</p>
      </div>
    </div>
  );
}
