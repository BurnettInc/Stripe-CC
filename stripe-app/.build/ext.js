"use strict";
var __StripeExtExports = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined")
      return require.apply(this, arguments);
    throw new Error('Dynamic require of "' + x + '" is not supported');
  });
  var __commonJS = (cb, mod) => function __require2() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // node_modules/@stripe/ui-extension-sdk/version.js
  var require_version = __commonJS({
    "node_modules/@stripe/ui-extension-sdk/version.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.SDK_VERSION = void 0;
      exports.SDK_VERSION = "9.1.0";
    }
  });

  // node_modules/@stripe/ui-extension-sdk/ui/index.js
  var require_ui = __commonJS({
    "node_modules/@stripe/ui-extension-sdk/ui/index.js"(exports) {
      "use strict";
      Object.defineProperty(exports, "__esModule", { value: true });
      exports.TableHeaderCell = exports.TableHead = exports.TableFooter = exports.TableCell = exports.TableBody = exports.Tab = exports.TabPanels = exports.TabPanel = exports.TabList = exports.Switch = exports.StripeFileUploader = exports.Spinner = exports.Sparkline = exports.SignInView = exports.SettingsView = exports.Select = exports.Radio = exports.PropertyList = exports.PropertyListItem = exports.PlatformConfigurationView = exports.OnboardingView = exports.Menu = exports.MenuItem = exports.MenuGroup = exports.List = exports.ListItem = exports.Link = exports.LineChart = exports.Inline = exports.Img = exports.Icon = exports.FormFieldGroup = exports.FocusView = exports.Divider = exports.DetailPageTable = exports.DetailPagePropertyList = exports.DetailPageModule = exports.DateField = exports.ContextView = exports.Chip = exports.ChipList = exports.Checkbox = exports.Button = exports.ButtonGroup = exports.Box = exports.BarChart = exports.Banner = exports.Badge = exports.Accordion = exports.AccordionItem = void 0;
      exports.Tooltip = exports.TextField = exports.TextArea = exports.TaskList = exports.TaskListItem = exports.Tabs = exports.TableRow = exports.Table = void 0;
      var jsx_runtime_1 = __require("react/jsx-runtime");
      var react_1 = __require("@remote-ui/react");
      var version_1 = require_version();
      var withSdkProps = (Component) => {
        const wrappedComponentName = Component.displayName || Component.toString();
        const WithSdkProps = (props) => (0, jsx_runtime_1.jsx)(Component, { ...props, wrappedComponentName, sdkVersion: version_1.SDK_VERSION, schemaVersion: "v9" });
        WithSdkProps.wrappedComponentName = wrappedComponentName;
        return WithSdkProps;
      };
      var defineComponent = (name, fragmentProps, wrapWithSdkProps) => {
        const remoteComponent = (0, react_1.createRemoteReactComponent)(name, {
          fragmentProps
        });
        if (!wrapWithSdkProps) {
          return remoteComponent;
        }
        return withSdkProps(remoteComponent);
      };
      exports.AccordionItem = defineComponent("AccordionItem", ["title", "actions", "media", "subtitle"], true);
      exports.Accordion = defineComponent("Accordion", [], true);
      exports.Badge = defineComponent("Badge", [], true);
      exports.Banner = defineComponent("Banner", ["actions", "description", "title"], true);
      exports.BarChart = defineComponent("BarChart", [], true);
      exports.Box = defineComponent("Box", [], true);
      exports.ButtonGroup = defineComponent("ButtonGroup", ["menuTrigger"], true);
      exports.Button = defineComponent("Button", [], true);
      exports.Checkbox = defineComponent("Checkbox", ["label"], true);
      exports.ChipList = defineComponent("ChipList", [], true);
      exports.Chip = defineComponent("Chip", [], true);
      exports.ContextView = defineComponent("ContextView", ["actions", "banner", "footerContent", "primaryAction", "secondaryAction"], true);
      exports.DateField = defineComponent("DateField", ["label"], true);
      exports.DetailPageModule = defineComponent("DetailPageModule", [], true);
      exports.DetailPagePropertyList = defineComponent("DetailPagePropertyList", [], true);
      exports.DetailPageTable = defineComponent("DetailPageTable", [], true);
      exports.Divider = defineComponent("Divider", [], true);
      exports.FocusView = defineComponent("FocusView", ["footerContent", "primaryAction", "secondaryAction"], true);
      exports.FormFieldGroup = defineComponent("FormFieldGroup", [], true);
      exports.Icon = defineComponent("Icon", [], true);
      exports.Img = defineComponent("Img", [], true);
      exports.Inline = defineComponent("Inline", [], true);
      exports.LineChart = defineComponent("LineChart", [], true);
      exports.Link = defineComponent("Link", [], true);
      exports.ListItem = defineComponent("ListItem", ["icon", "image", "secondaryTitle", "title", "value"], true);
      exports.List = defineComponent("List", [], true);
      exports.MenuGroup = defineComponent("MenuGroup", ["title"], true);
      exports.MenuItem = defineComponent("MenuItem", [], true);
      exports.Menu = defineComponent("Menu", ["trigger"], true);
      exports.OnboardingView = defineComponent("OnboardingView", ["error"], true);
      exports.PlatformConfigurationView = defineComponent("PlatformConfigurationView", [], true);
      exports.PropertyListItem = defineComponent("PropertyListItem", ["label", "value"], true);
      exports.PropertyList = defineComponent("PropertyList", [], true);
      exports.Radio = defineComponent("Radio", ["label"], true);
      exports.Select = defineComponent("Select", ["label"], true);
      exports.SettingsView = defineComponent("SettingsView", [], true);
      exports.SignInView = defineComponent("SignInView", ["descriptionActionContents", "footerContent"], true);
      exports.Sparkline = defineComponent("Sparkline", [], true);
      exports.Spinner = defineComponent("Spinner", [], true);
      exports.StripeFileUploader = defineComponent("StripeFileUploader", [], true);
      exports.Switch = defineComponent("Switch", ["label"], true);
      exports.TabList = defineComponent("TabList", [], true);
      exports.TabPanel = defineComponent("TabPanel", [], true);
      exports.TabPanels = defineComponent("TabPanels", [], true);
      exports.Tab = defineComponent("Tab", [], true);
      exports.TableBody = defineComponent("TableBody", [], true);
      exports.TableCell = defineComponent("TableCell", [], true);
      exports.TableFooter = defineComponent("TableFooter", [], true);
      exports.TableHead = defineComponent("TableHead", [], true);
      exports.TableHeaderCell = defineComponent("TableHeaderCell", [], true);
      exports.Table = defineComponent("Table", [], true);
      exports.TableRow = defineComponent("TableRow", [], true);
      exports.Tabs = defineComponent("Tabs", [], true);
      exports.TaskListItem = defineComponent("TaskListItem", [], true);
      exports.TaskList = defineComponent("TaskList", [], true);
      exports.TextArea = defineComponent("TextArea", ["label"], true);
      exports.TextField = defineComponent("TextField", ["label"], true);
      exports.Tooltip = defineComponent("Tooltip", ["trigger"], true);
    }
  });

  // .build/manifest.js
  var manifest_exports = {};
  __export(manifest_exports, {
    BUILD_TIME: () => BUILD_TIME,
    InvoiceDetailView: () => InvoiceDetailView,
    SettingsView: () => SettingsView,
    default: () => manifest_default
  });

  // src/views/SettingsView.tsx
  var import_react = __require("react");
  var import_ui = __toESM(require_ui(), 1);
  var import_jsx_runtime = __require("react/jsx-runtime");
  var import_meta = {};
  var BASE_URL = import_meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";
  var modes = [
    { value: "draft", label: "Draft", description: "You approve every email before it is sent." },
    { value: "semi", label: "Semi-Auto", description: "Stage 1 reminders send automatically; later stages need approval." },
    { value: "full", label: "Full Auto", description: "Fully hands-off follow-ups across every escalation stage." }
  ];
  function SettingsView(props) {
    const oauthContext = props?.oauthContext;
    const [trustMode, setTrustMode] = (0, import_react.useState)(null);
    const [connection, setConnection] = (0, import_react.useState)(null);
    const [loading, setLoading] = (0, import_react.useState)(true);
    const [saving, setSaving] = (0, import_react.useState)(false);
    const [error, setError] = (0, import_react.useState)(null);
    const load = (0, import_react.useCallback)(async () => {
      setLoading(true);
      setError(null);
      try {
        const [settingsRes, connRes] = await Promise.all([
          fetch(`${BASE_URL}/settings`),
          fetch(`${BASE_URL}/stripe/connection`)
        ]);
        if (!settingsRes.ok || !connRes.ok)
          throw new Error("Unable to load Copilot settings.");
        setTrustMode((await settingsRes.json()).trust_mode);
        setConnection(await connRes.json());
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to load settings.");
      } finally {
        setLoading(false);
      }
    }, []);
    (0, import_react.useEffect)(() => {
      void load();
    }, [load]);
    const save = async (value) => {
      const previous = trustMode;
      setTrustMode(value);
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(`${BASE_URL}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trust_mode: value })
        });
        if (!response.ok)
          throw new Error("Could not save Trust Mode.");
        setTrustMode((await response.json()).trust_mode ?? value);
      } catch (cause) {
        setTrustMode(previous);
        setError(cause instanceof Error ? cause.message : "Could not save Trust Mode.");
      } finally {
        setSaving(false);
      }
    };
    const accountName = connection?.account_name;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.ContextView, {
      title: "Collections Copilot",
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_ui.Box, {
        css: { stack: "y", gap: "medium" },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_ui.Box, {
            css: { stack: "y", gap: "xsmall" },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Box, {
                css: { font: "subheading", fontWeight: "semibold" },
                children: "Stripe connection"
              }),
              loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Spinner, {}) : connection?.connected || oauthContext ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_ui.Box, {
                css: { color: "primary" },
                children: [
                  "Connected as ",
                  accountName || "your Stripe account"
                ]
              }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Box, {
                css: { color: "secondary" },
                children: "Not connected \u2014 connect your Stripe account"
              })
            ]
          }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_ui.Box, {
            css: { stack: "y", gap: "xsmall" },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Box, {
                css: { font: "subheading", fontWeight: "semibold" },
                children: "Trust Mode"
              }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Box, {
                css: { color: "secondary" },
                children: "Control how autonomous Copilot is when handling overdue invoices."
              }),
              loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Spinner, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Select, {
                value: trustMode ?? void 0,
                disabled: saving,
                onChange: (event) => {
                  void save(event.target.value);
                },
                children: modes.map(({ value, label }) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", {
                  value,
                  children: label
                }, value))
              }),
              trustMode && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Box, {
                css: { color: "secondary", font: "caption" },
                children: modes.find((mode) => mode.value === trustMode)?.description
              })
            ]
          }),
          error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Banner, {
            type: "critical",
            title: "Something went wrong",
            description: error,
            actions: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_ui.Button, {
              onPress: () => {
                void load();
              },
              children: "Retry"
            })
          })
        ]
      })
    });
  }

  // src/views/InvoiceDetailView.tsx
  var import_react2 = __require("react");
  var import_ui2 = __toESM(require_ui(), 1);
  var import_jsx_runtime2 = __require("react/jsx-runtime");
  var import_meta2 = {};
  var BASE_URL2 = import_meta2.env.VITE_BACKEND_URL ?? "http://localhost:3001";
  var trustModeOptions = [
    { value: "global", label: "Use global default" },
    { value: "draft", label: "Draft" },
    { value: "semi", label: "Semi-Auto" },
    { value: "full", label: "Full Auto" }
  ];
  function formatDate(value) {
    if (value === void 0 || value === null || value === "")
      return "Not scheduled";
    const date = typeof value === "number" ? new Date(value * 1e3) : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
  }
  function formatAmount(invoice) {
    const amount = invoice.amount_due ?? invoice.amount;
    if (amount === void 0 || amount === null)
      return "Amount unavailable";
    return new Intl.NumberFormat(void 0, {
      style: "currency",
      currency: (invoice.currency ?? "usd").toUpperCase()
    }).format(amount / 100);
  }
  function InvoiceDetailView(props) {
    const invoiceId = props?.invoiceId;
    const [invoice, setInvoice] = (0, import_react2.useState)(null);
    const [trustMode, setTrustMode] = (0, import_react2.useState)("global");
    const [loading, setLoading] = (0, import_react2.useState)(Boolean(invoiceId));
    const [saving, setSaving] = (0, import_react2.useState)(false);
    const [error, setError] = (0, import_react2.useState)(null);
    const load = (0, import_react2.useCallback)(async () => {
      if (!invoiceId)
        return;
      setLoading(true);
      setError(null);
      try {
        const [invoiceResponse, modeResponse] = await Promise.all([
          fetch(`${BASE_URL2}/invoices/${encodeURIComponent(invoiceId)}`),
          fetch(`${BASE_URL2}/invoices/${encodeURIComponent(invoiceId)}/trust-mode`)
        ]);
        if (!invoiceResponse.ok || !modeResponse.ok)
          throw new Error("Unable to load invoice collection status.");
        const invoicePayload = await invoiceResponse.json();
        const details = "invoice" in invoicePayload && invoicePayload.invoice ? invoicePayload.invoice : invoicePayload;
        const modePayload = await modeResponse.json();
        setInvoice({ ...details, id: details.id || invoiceId });
        setTrustMode(modePayload.trustMode ?? modePayload.trust_mode ?? "global");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to load invoice collection status.");
      } finally {
        setLoading(false);
      }
    }, [invoiceId]);
    (0, import_react2.useEffect)(() => {
      void load();
    }, [load]);
    const saveTrustMode = async (value) => {
      if (!invoiceId)
        return;
      const previous = trustMode;
      setTrustMode(value);
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(`${BASE_URL2}/invoices/${encodeURIComponent(invoiceId)}/trust-mode`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trust_mode: value === "global" ? null : value })
        });
        if (!response.ok)
          throw new Error("Could not save the invoice Trust Mode override.");
        const result = await response.json();
        setTrustMode(result.trustMode ?? result.trust_mode ?? value);
      } catch (cause) {
        setTrustMode(previous);
        setError(cause instanceof Error ? cause.message : "Could not save the invoice Trust Mode override.");
      } finally {
        setSaving(false);
      }
    };
    if (!invoiceId) {
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.ContextView, {
        title: "Collections Copilot",
        children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Box, {
          css: { color: "secondary" },
          children: "Select an invoice to view its collection status."
        })
      });
    }
    const sequence = invoice?.sequence ?? invoice?.sequence_status;
    const emailsSent = sequence?.emails_sent ?? sequence?.emailsSent ?? invoice?.emails_sent ?? invoice?.emailsSent ?? 0;
    const lastSendDate = sequence?.last_send_date ?? sequence?.lastSendDate ?? invoice?.last_send_date ?? invoice?.lastSendDate;
    const nextScheduled = sequence?.next_scheduled ?? sequence?.nextScheduled ?? invoice?.next_scheduled ?? invoice?.nextScheduled;
    const active = sequence?.active ?? invoice?.sequence_active ?? invoice?.sequenceActive;
    const paused = sequence?.paused ?? invoice?.sequence_paused ?? invoice?.sequencePaused;
    const stage = invoice?.escalation_stage ?? invoice?.escalationStage;
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.ContextView, {
      title: "Collections Copilot",
      children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
        css: { stack: "y", gap: "medium" },
        children: [
          error && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Banner, {
            type: "critical",
            title: "Something went wrong",
            description: error,
            actions: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Button, {
              onPress: () => {
                void load();
              },
              children: "Retry"
            })
          }),
          loading ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Spinner, {}) : invoice ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, {
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                css: { stack: "y", gap: "xsmall" },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Box, {
                    css: { font: "heading", fontWeight: "semibold" },
                    children: invoice.id
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Box, {
                    css: { font: "subheading", fontWeight: "semibold" },
                    children: formatAmount(invoice)
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Box, {
                    css: { color: "secondary" },
                    children: invoice.customer_name ?? invoice.customerName ?? "Customer unavailable"
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                    css: { color: "secondary" },
                    children: [
                      "Due ",
                      formatDate(invoice.due_date ?? invoice.dueDate),
                      " \xB7 ",
                      invoice.days_overdue ?? invoice.daysOverdue ?? 0,
                      " days overdue"
                    ]
                  })
                ]
              }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                css: { stack: "y", gap: "xsmall" },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Box, {
                    css: { font: "subheading", fontWeight: "semibold" },
                    children: "Collection sequence"
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                    css: { color: "secondary" },
                    children: [
                      "Escalation stage: ",
                      stage === void 0 ? "Not available" : `Stage ${stage}`
                    ]
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                    css: { color: paused ? "secondary" : "primary" },
                    children: [
                      "Status: ",
                      paused ? "Paused" : active === false ? "Inactive" : "Active"
                    ]
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                    css: { color: "secondary" },
                    children: [
                      "Emails sent: ",
                      emailsSent
                    ]
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                    css: { color: "secondary" },
                    children: [
                      "Last send: ",
                      formatDate(lastSendDate)
                    ]
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                    css: { color: "secondary" },
                    children: [
                      "Next scheduled: ",
                      formatDate(nextScheduled)
                    ]
                  })
                ]
              }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_ui2.Box, {
                css: { stack: "y", gap: "xsmall" },
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Box, {
                    css: { font: "subheading", fontWeight: "semibold" },
                    children: "Trust Mode override"
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Box, {
                    css: { color: "secondary" },
                    children: "Choose how Copilot handles this invoice, overriding the global default."
                  }),
                  /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Select, {
                    value: trustMode,
                    disabled: saving,
                    onChange: (event) => {
                      void saveTrustMode(event.target.value);
                    },
                    children: trustModeOptions.map((option) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", {
                      value: option.value,
                      children: option.label
                    }, option.value))
                  }),
                  saving && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Spinner, {})
                ]
              })
            ]
          }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_ui2.Box, {
            css: { color: "secondary" },
            children: "Invoice details are unavailable."
          })
        ]
      })
    });
  }

  // .build/manifest.js
  __reExport(manifest_exports, __toESM(require_version(), 1));
  var BUILD_TIME = "2026-08-05 16:42:18.577036349 +0000 UTC m=+2.451285717";
  var manifest_default = {
    "$schema": "https://stripe.com/stripe-app.schema.json",
    "icon": "./icon.png",
    "id": "com.stripecollectionscopilot.app",
    "name": "Stripe Collections Copilot",
    "permissions": [
      {
        "permission": "invoice_read",
        "purpose": ""
      },
      {
        "permission": "customer_read",
        "purpose": ""
      }
    ],
    "ui_extension": {
      "views": [
        {
          "component": "SettingsView",
          "viewport": "stripe.dashboard.drawer.default"
        },
        {
          "component": "InvoiceDetailView",
          "viewport": "stripe.dashboard.invoice.detail"
        }
      ]
    },
    "version": "0.1.0"
  };
  return __toCommonJS(manifest_exports);
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vbm9kZV9tb2R1bGVzL0BzdHJpcGUvdWktZXh0ZW5zaW9uLXNkay92ZXJzaW9uLmpzIiwgIi4uL25vZGVfbW9kdWxlcy9Ac3RyaXBlL3VpLWV4dGVuc2lvbi1zZGsvdWkvaW5kZXguanMiLCAibWFuaWZlc3QuanMiLCAiLi4vc3JjL3ZpZXdzL1NldHRpbmdzVmlldy50c3giLCAiLi4vc3JjL3ZpZXdzL0ludm9pY2VEZXRhaWxWaWV3LnRzeCJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiXCJ1c2Ugc3RyaWN0XCI7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoZXhwb3J0cywgXCJfX2VzTW9kdWxlXCIsIHsgdmFsdWU6IHRydWUgfSk7XG5leHBvcnRzLlNES19WRVJTSU9OID0gdm9pZCAwO1xuZXhwb3J0cy5TREtfVkVSU0lPTiA9ICc5LjEuMCc7XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoZXhwb3J0cywgXCJfX2VzTW9kdWxlXCIsIHsgdmFsdWU6IHRydWUgfSk7XG5leHBvcnRzLlRhYmxlSGVhZGVyQ2VsbCA9IGV4cG9ydHMuVGFibGVIZWFkID0gZXhwb3J0cy5UYWJsZUZvb3RlciA9IGV4cG9ydHMuVGFibGVDZWxsID0gZXhwb3J0cy5UYWJsZUJvZHkgPSBleHBvcnRzLlRhYiA9IGV4cG9ydHMuVGFiUGFuZWxzID0gZXhwb3J0cy5UYWJQYW5lbCA9IGV4cG9ydHMuVGFiTGlzdCA9IGV4cG9ydHMuU3dpdGNoID0gZXhwb3J0cy5TdHJpcGVGaWxlVXBsb2FkZXIgPSBleHBvcnRzLlNwaW5uZXIgPSBleHBvcnRzLlNwYXJrbGluZSA9IGV4cG9ydHMuU2lnbkluVmlldyA9IGV4cG9ydHMuU2V0dGluZ3NWaWV3ID0gZXhwb3J0cy5TZWxlY3QgPSBleHBvcnRzLlJhZGlvID0gZXhwb3J0cy5Qcm9wZXJ0eUxpc3QgPSBleHBvcnRzLlByb3BlcnR5TGlzdEl0ZW0gPSBleHBvcnRzLlBsYXRmb3JtQ29uZmlndXJhdGlvblZpZXcgPSBleHBvcnRzLk9uYm9hcmRpbmdWaWV3ID0gZXhwb3J0cy5NZW51ID0gZXhwb3J0cy5NZW51SXRlbSA9IGV4cG9ydHMuTWVudUdyb3VwID0gZXhwb3J0cy5MaXN0ID0gZXhwb3J0cy5MaXN0SXRlbSA9IGV4cG9ydHMuTGluayA9IGV4cG9ydHMuTGluZUNoYXJ0ID0gZXhwb3J0cy5JbmxpbmUgPSBleHBvcnRzLkltZyA9IGV4cG9ydHMuSWNvbiA9IGV4cG9ydHMuRm9ybUZpZWxkR3JvdXAgPSBleHBvcnRzLkZvY3VzVmlldyA9IGV4cG9ydHMuRGl2aWRlciA9IGV4cG9ydHMuRGV0YWlsUGFnZVRhYmxlID0gZXhwb3J0cy5EZXRhaWxQYWdlUHJvcGVydHlMaXN0ID0gZXhwb3J0cy5EZXRhaWxQYWdlTW9kdWxlID0gZXhwb3J0cy5EYXRlRmllbGQgPSBleHBvcnRzLkNvbnRleHRWaWV3ID0gZXhwb3J0cy5DaGlwID0gZXhwb3J0cy5DaGlwTGlzdCA9IGV4cG9ydHMuQ2hlY2tib3ggPSBleHBvcnRzLkJ1dHRvbiA9IGV4cG9ydHMuQnV0dG9uR3JvdXAgPSBleHBvcnRzLkJveCA9IGV4cG9ydHMuQmFyQ2hhcnQgPSBleHBvcnRzLkJhbm5lciA9IGV4cG9ydHMuQmFkZ2UgPSBleHBvcnRzLkFjY29yZGlvbiA9IGV4cG9ydHMuQWNjb3JkaW9uSXRlbSA9IHZvaWQgMDtcbmV4cG9ydHMuVG9vbHRpcCA9IGV4cG9ydHMuVGV4dEZpZWxkID0gZXhwb3J0cy5UZXh0QXJlYSA9IGV4cG9ydHMuVGFza0xpc3QgPSBleHBvcnRzLlRhc2tMaXN0SXRlbSA9IGV4cG9ydHMuVGFicyA9IGV4cG9ydHMuVGFibGVSb3cgPSBleHBvcnRzLlRhYmxlID0gdm9pZCAwO1xuY29uc3QganN4X3J1bnRpbWVfMSA9IHJlcXVpcmUoXCJyZWFjdC9qc3gtcnVudGltZVwiKTtcbmNvbnN0IHJlYWN0XzEgPSByZXF1aXJlKFwiQHJlbW90ZS11aS9yZWFjdFwiKTtcbmNvbnN0IHZlcnNpb25fMSA9IHJlcXVpcmUoXCIuLi92ZXJzaW9uXCIpO1xuY29uc3Qgd2l0aFNka1Byb3BzID0gKENvbXBvbmVudCkgPT4ge1xuICAgIGNvbnN0IHdyYXBwZWRDb21wb25lbnROYW1lID0gQ29tcG9uZW50LmRpc3BsYXlOYW1lIHx8IENvbXBvbmVudC50b1N0cmluZygpO1xuICAgIGNvbnN0IFdpdGhTZGtQcm9wcyA9IChwcm9wcykgPT4gKCgwLCBqc3hfcnVudGltZV8xLmpzeCkoQ29tcG9uZW50LCB7IC4uLnByb3BzLCB3cmFwcGVkQ29tcG9uZW50TmFtZTogd3JhcHBlZENvbXBvbmVudE5hbWUsIHNka1ZlcnNpb246IHZlcnNpb25fMS5TREtfVkVSU0lPTiwgc2NoZW1hVmVyc2lvbjogXCJ2OVwiIH0pKTtcbiAgICBXaXRoU2RrUHJvcHMud3JhcHBlZENvbXBvbmVudE5hbWUgPSB3cmFwcGVkQ29tcG9uZW50TmFtZTtcbiAgICByZXR1cm4gV2l0aFNka1Byb3BzO1xufTtcbmNvbnN0IGRlZmluZUNvbXBvbmVudCA9IChuYW1lLCBmcmFnbWVudFByb3BzLCB3cmFwV2l0aFNka1Byb3BzKSA9PiB7XG4gICAgY29uc3QgcmVtb3RlQ29tcG9uZW50ID0gKDAsIHJlYWN0XzEuY3JlYXRlUmVtb3RlUmVhY3RDb21wb25lbnQpKG5hbWUsIHtcbiAgICAgICAgZnJhZ21lbnRQcm9wcyxcbiAgICB9KTtcbiAgICBpZiAoIXdyYXBXaXRoU2RrUHJvcHMpIHtcbiAgICAgICAgcmV0dXJuIHJlbW90ZUNvbXBvbmVudDtcbiAgICB9XG4gICAgcmV0dXJuIHdpdGhTZGtQcm9wcyhyZW1vdGVDb21wb25lbnQpO1xufTtcbmV4cG9ydHMuQWNjb3JkaW9uSXRlbSA9IGRlZmluZUNvbXBvbmVudCgnQWNjb3JkaW9uSXRlbScsIFsndGl0bGUnLCAnYWN0aW9ucycsICdtZWRpYScsICdzdWJ0aXRsZSddLCB0cnVlKTtcbmV4cG9ydHMuQWNjb3JkaW9uID0gZGVmaW5lQ29tcG9uZW50KCdBY2NvcmRpb24nLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLkJhZGdlID0gZGVmaW5lQ29tcG9uZW50KCdCYWRnZScsIFtdLCB0cnVlKTtcbmV4cG9ydHMuQmFubmVyID0gZGVmaW5lQ29tcG9uZW50KCdCYW5uZXInLCBbJ2FjdGlvbnMnLCAnZGVzY3JpcHRpb24nLCAndGl0bGUnXSwgdHJ1ZSk7XG5leHBvcnRzLkJhckNoYXJ0ID0gZGVmaW5lQ29tcG9uZW50KCdCYXJDaGFydCcsIFtdLCB0cnVlKTtcbmV4cG9ydHMuQm94ID0gZGVmaW5lQ29tcG9uZW50KCdCb3gnLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLkJ1dHRvbkdyb3VwID0gZGVmaW5lQ29tcG9uZW50KCdCdXR0b25Hcm91cCcsIFsnbWVudVRyaWdnZXInXSwgdHJ1ZSk7XG5leHBvcnRzLkJ1dHRvbiA9IGRlZmluZUNvbXBvbmVudCgnQnV0dG9uJywgW10sIHRydWUpO1xuZXhwb3J0cy5DaGVja2JveCA9IGRlZmluZUNvbXBvbmVudCgnQ2hlY2tib3gnLCBbJ2xhYmVsJ10sIHRydWUpO1xuZXhwb3J0cy5DaGlwTGlzdCA9IGRlZmluZUNvbXBvbmVudCgnQ2hpcExpc3QnLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLkNoaXAgPSBkZWZpbmVDb21wb25lbnQoJ0NoaXAnLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLkNvbnRleHRWaWV3ID0gZGVmaW5lQ29tcG9uZW50KCdDb250ZXh0VmlldycsIFsnYWN0aW9ucycsICdiYW5uZXInLCAnZm9vdGVyQ29udGVudCcsICdwcmltYXJ5QWN0aW9uJywgJ3NlY29uZGFyeUFjdGlvbiddLCB0cnVlKTtcbmV4cG9ydHMuRGF0ZUZpZWxkID0gZGVmaW5lQ29tcG9uZW50KCdEYXRlRmllbGQnLCBbJ2xhYmVsJ10sIHRydWUpO1xuZXhwb3J0cy5EZXRhaWxQYWdlTW9kdWxlID0gZGVmaW5lQ29tcG9uZW50KCdEZXRhaWxQYWdlTW9kdWxlJywgW10sIHRydWUpO1xuZXhwb3J0cy5EZXRhaWxQYWdlUHJvcGVydHlMaXN0ID0gZGVmaW5lQ29tcG9uZW50KCdEZXRhaWxQYWdlUHJvcGVydHlMaXN0JywgW10sIHRydWUpO1xuZXhwb3J0cy5EZXRhaWxQYWdlVGFibGUgPSBkZWZpbmVDb21wb25lbnQoJ0RldGFpbFBhZ2VUYWJsZScsIFtdLCB0cnVlKTtcbmV4cG9ydHMuRGl2aWRlciA9IGRlZmluZUNvbXBvbmVudCgnRGl2aWRlcicsIFtdLCB0cnVlKTtcbmV4cG9ydHMuRm9jdXNWaWV3ID0gZGVmaW5lQ29tcG9uZW50KCdGb2N1c1ZpZXcnLCBbJ2Zvb3RlckNvbnRlbnQnLCAncHJpbWFyeUFjdGlvbicsICdzZWNvbmRhcnlBY3Rpb24nXSwgdHJ1ZSk7XG5leHBvcnRzLkZvcm1GaWVsZEdyb3VwID0gZGVmaW5lQ29tcG9uZW50KCdGb3JtRmllbGRHcm91cCcsIFtdLCB0cnVlKTtcbmV4cG9ydHMuSWNvbiA9IGRlZmluZUNvbXBvbmVudCgnSWNvbicsIFtdLCB0cnVlKTtcbmV4cG9ydHMuSW1nID0gZGVmaW5lQ29tcG9uZW50KCdJbWcnLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLklubGluZSA9IGRlZmluZUNvbXBvbmVudCgnSW5saW5lJywgW10sIHRydWUpO1xuZXhwb3J0cy5MaW5lQ2hhcnQgPSBkZWZpbmVDb21wb25lbnQoJ0xpbmVDaGFydCcsIFtdLCB0cnVlKTtcbmV4cG9ydHMuTGluayA9IGRlZmluZUNvbXBvbmVudCgnTGluaycsIFtdLCB0cnVlKTtcbmV4cG9ydHMuTGlzdEl0ZW0gPSBkZWZpbmVDb21wb25lbnQoJ0xpc3RJdGVtJywgWydpY29uJywgJ2ltYWdlJywgJ3NlY29uZGFyeVRpdGxlJywgJ3RpdGxlJywgJ3ZhbHVlJ10sIHRydWUpO1xuZXhwb3J0cy5MaXN0ID0gZGVmaW5lQ29tcG9uZW50KCdMaXN0JywgW10sIHRydWUpO1xuZXhwb3J0cy5NZW51R3JvdXAgPSBkZWZpbmVDb21wb25lbnQoJ01lbnVHcm91cCcsIFsndGl0bGUnXSwgdHJ1ZSk7XG5leHBvcnRzLk1lbnVJdGVtID0gZGVmaW5lQ29tcG9uZW50KCdNZW51SXRlbScsIFtdLCB0cnVlKTtcbmV4cG9ydHMuTWVudSA9IGRlZmluZUNvbXBvbmVudCgnTWVudScsIFsndHJpZ2dlciddLCB0cnVlKTtcbmV4cG9ydHMuT25ib2FyZGluZ1ZpZXcgPSBkZWZpbmVDb21wb25lbnQoJ09uYm9hcmRpbmdWaWV3JywgWydlcnJvciddLCB0cnVlKTtcbmV4cG9ydHMuUGxhdGZvcm1Db25maWd1cmF0aW9uVmlldyA9IGRlZmluZUNvbXBvbmVudCgnUGxhdGZvcm1Db25maWd1cmF0aW9uVmlldycsIFtdLCB0cnVlKTtcbmV4cG9ydHMuUHJvcGVydHlMaXN0SXRlbSA9IGRlZmluZUNvbXBvbmVudCgnUHJvcGVydHlMaXN0SXRlbScsIFsnbGFiZWwnLCAndmFsdWUnXSwgdHJ1ZSk7XG5leHBvcnRzLlByb3BlcnR5TGlzdCA9IGRlZmluZUNvbXBvbmVudCgnUHJvcGVydHlMaXN0JywgW10sIHRydWUpO1xuZXhwb3J0cy5SYWRpbyA9IGRlZmluZUNvbXBvbmVudCgnUmFkaW8nLCBbJ2xhYmVsJ10sIHRydWUpO1xuZXhwb3J0cy5TZWxlY3QgPSBkZWZpbmVDb21wb25lbnQoJ1NlbGVjdCcsIFsnbGFiZWwnXSwgdHJ1ZSk7XG5leHBvcnRzLlNldHRpbmdzVmlldyA9IGRlZmluZUNvbXBvbmVudCgnU2V0dGluZ3NWaWV3JywgW10sIHRydWUpO1xuZXhwb3J0cy5TaWduSW5WaWV3ID0gZGVmaW5lQ29tcG9uZW50KCdTaWduSW5WaWV3JywgWydkZXNjcmlwdGlvbkFjdGlvbkNvbnRlbnRzJywgJ2Zvb3RlckNvbnRlbnQnXSwgdHJ1ZSk7XG5leHBvcnRzLlNwYXJrbGluZSA9IGRlZmluZUNvbXBvbmVudCgnU3BhcmtsaW5lJywgW10sIHRydWUpO1xuZXhwb3J0cy5TcGlubmVyID0gZGVmaW5lQ29tcG9uZW50KCdTcGlubmVyJywgW10sIHRydWUpO1xuZXhwb3J0cy5TdHJpcGVGaWxlVXBsb2FkZXIgPSBkZWZpbmVDb21wb25lbnQoJ1N0cmlwZUZpbGVVcGxvYWRlcicsIFtdLCB0cnVlKTtcbmV4cG9ydHMuU3dpdGNoID0gZGVmaW5lQ29tcG9uZW50KCdTd2l0Y2gnLCBbJ2xhYmVsJ10sIHRydWUpO1xuZXhwb3J0cy5UYWJMaXN0ID0gZGVmaW5lQ29tcG9uZW50KCdUYWJMaXN0JywgW10sIHRydWUpO1xuZXhwb3J0cy5UYWJQYW5lbCA9IGRlZmluZUNvbXBvbmVudCgnVGFiUGFuZWwnLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLlRhYlBhbmVscyA9IGRlZmluZUNvbXBvbmVudCgnVGFiUGFuZWxzJywgW10sIHRydWUpO1xuZXhwb3J0cy5UYWIgPSBkZWZpbmVDb21wb25lbnQoJ1RhYicsIFtdLCB0cnVlKTtcbmV4cG9ydHMuVGFibGVCb2R5ID0gZGVmaW5lQ29tcG9uZW50KCdUYWJsZUJvZHknLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLlRhYmxlQ2VsbCA9IGRlZmluZUNvbXBvbmVudCgnVGFibGVDZWxsJywgW10sIHRydWUpO1xuZXhwb3J0cy5UYWJsZUZvb3RlciA9IGRlZmluZUNvbXBvbmVudCgnVGFibGVGb290ZXInLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLlRhYmxlSGVhZCA9IGRlZmluZUNvbXBvbmVudCgnVGFibGVIZWFkJywgW10sIHRydWUpO1xuZXhwb3J0cy5UYWJsZUhlYWRlckNlbGwgPSBkZWZpbmVDb21wb25lbnQoJ1RhYmxlSGVhZGVyQ2VsbCcsIFtdLCB0cnVlKTtcbmV4cG9ydHMuVGFibGUgPSBkZWZpbmVDb21wb25lbnQoJ1RhYmxlJywgW10sIHRydWUpO1xuZXhwb3J0cy5UYWJsZVJvdyA9IGRlZmluZUNvbXBvbmVudCgnVGFibGVSb3cnLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLlRhYnMgPSBkZWZpbmVDb21wb25lbnQoJ1RhYnMnLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLlRhc2tMaXN0SXRlbSA9IGRlZmluZUNvbXBvbmVudCgnVGFza0xpc3RJdGVtJywgW10sIHRydWUpO1xuZXhwb3J0cy5UYXNrTGlzdCA9IGRlZmluZUNvbXBvbmVudCgnVGFza0xpc3QnLCBbXSwgdHJ1ZSk7XG5leHBvcnRzLlRleHRBcmVhID0gZGVmaW5lQ29tcG9uZW50KCdUZXh0QXJlYScsIFsnbGFiZWwnXSwgdHJ1ZSk7XG5leHBvcnRzLlRleHRGaWVsZCA9IGRlZmluZUNvbXBvbmVudCgnVGV4dEZpZWxkJywgWydsYWJlbCddLCB0cnVlKTtcbmV4cG9ydHMuVG9vbHRpcCA9IGRlZmluZUNvbXBvbmVudCgnVG9vbHRpcCcsIFsndHJpZ2dlciddLCB0cnVlKTtcbiIsICIvLyBBVVRPR0VORVJBVEVEIC0gRE8gTk9UIE1PRElGWVxuXG4vLyBWaWV3IGNvbXBvbmVudCBpbXBvcnRzIFx1MjAxNCBvbmUgcGVyIHZpZXdwb3J0IGRlY2xhcmVkIGluIHVpX2V4dGVuc2lvbi52aWV3c1xuaW1wb3J0IFNldHRpbmdzVmlldyBmcm9tICcuLi9zcmMvdmlld3MvU2V0dGluZ3NWaWV3JztcbmltcG9ydCBJbnZvaWNlRGV0YWlsVmlldyBmcm9tICcuLi9zcmMvdmlld3MvSW52b2ljZURldGFpbFZpZXcnO1xuXG4vLyBFeHBvc2VzIHRoZSBTREsgdmVyc2lvbiBzbyB0aGUgRGFzaGJvYXJkIGNhbiB2ZXJpZnkgY29tcGF0aWJpbGl0eVxuZXhwb3J0ICogZnJvbSAnQHN0cmlwZS91aS1leHRlbnNpb24tc2RrL3ZlcnNpb24nO1xuXG4vLyBOYW1lZCBleHBvcnRzIG1ha2UgZWFjaCB2aWV3IGNvbXBvbmVudCBhY2Nlc3NpYmxlIHRvIHRoZSBEYXNoYm9hcmQgcnVudGltZVxuXG5leHBvcnQgeyBcbiAgU2V0dGluZ3NWaWV3LFxuXG4gIEludm9pY2VEZXRhaWxWaWV3XG4gfTtcblxuLy8gVGltZXN0YW1wIGNoYW5nZXMgb24gZXZlcnkgZXhwb3J0LCBlbnN1cmluZyB0aGUgZGV2IHNlcnZlciBkZXRlY3RzIGEgcmVidWlsZFxuZXhwb3J0IGNvbnN0IEJVSUxEX1RJTUUgPSAnMjAyNi0wOC0wNSAxNjo0MjoxOC41NzcwMzYzNDkgKzAwMDAgVVRDIG09KzIuNDUxMjg1NzE3JztcblxuLy8gQXBwIG1hbmlmZXN0IFx1MjAxNCBjb25zdW1lZCBieSB0aGUgRGFzaGJvYXJkIHRvIGNvbmZpZ3VyZSB0aGUgYXBwXG5leHBvcnQgZGVmYXVsdCB7XG4gIFwiJHNjaGVtYVwiOiBcImh0dHBzOi8vc3RyaXBlLmNvbS9zdHJpcGUtYXBwLnNjaGVtYS5qc29uXCIsXG4gIFwiaWNvblwiOiBcIi4vaWNvbi5wbmdcIixcbiAgXCJpZFwiOiBcImNvbS5zdHJpcGVjb2xsZWN0aW9uc2NvcGlsb3QuYXBwXCIsXG4gIFwibmFtZVwiOiBcIlN0cmlwZSBDb2xsZWN0aW9ucyBDb3BpbG90XCIsXG4gIFwicGVybWlzc2lvbnNcIjogW1xuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcImludm9pY2VfcmVhZFwiLFxuICAgICAgXCJwdXJwb3NlXCI6IFwiXCJcbiAgICB9LFxuICAgIHtcbiAgICAgIFwicGVybWlzc2lvblwiOiBcImN1c3RvbWVyX3JlYWRcIixcbiAgICAgIFwicHVycG9zZVwiOiBcIlwiXG4gICAgfVxuICBdLFxuICBcInVpX2V4dGVuc2lvblwiOiB7XG4gICAgXCJ2aWV3c1wiOiBbXG4gICAgICB7XG4gICAgICAgIFwiY29tcG9uZW50XCI6IFwiU2V0dGluZ3NWaWV3XCIsXG4gICAgICAgIFwidmlld3BvcnRcIjogXCJzdHJpcGUuZGFzaGJvYXJkLmRyYXdlci5kZWZhdWx0XCJcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIFwiY29tcG9uZW50XCI6IFwiSW52b2ljZURldGFpbFZpZXdcIixcbiAgICAgICAgXCJ2aWV3cG9ydFwiOiBcInN0cmlwZS5kYXNoYm9hcmQuaW52b2ljZS5kZXRhaWxcIlxuICAgICAgfVxuICAgIF1cbiAgfSxcbiAgXCJ2ZXJzaW9uXCI6IFwiMC4xLjBcIlxufTtcbiIsICIvLy8gPHJlZmVyZW5jZSB0eXBlcz1cInZpdGUvY2xpZW50XCIgLz5cblxuaW1wb3J0IHsgdXNlQ2FsbGJhY2ssIHVzZUVmZmVjdCwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCc7XG5pbXBvcnQgeyBCb3gsIEJ1dHRvbiwgQ29udGV4dFZpZXcsIFNlbGVjdCwgU3Bpbm5lciwgQmFubmVyIH0gZnJvbSAnQHN0cmlwZS91aS1leHRlbnNpb24tc2RrL3VpJztcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQ29udGV4dFZhbHVlIH0gZnJvbSAnQHN0cmlwZS91aS1leHRlbnNpb24tc2RrL2NvbnRleHQnO1xuXG5jb25zdCBCQVNFX1VSTCA9IGltcG9ydC5tZXRhLmVudi5WSVRFX0JBQ0tFTkRfVVJMID8/ICdodHRwOi8vbG9jYWxob3N0OjMwMDEnO1xuXG50eXBlIFRydXN0TW9kZSA9ICdkcmFmdCcgfCAnc2VtaScgfCAnZnVsbCc7XG5cbmNvbnN0IG1vZGVzOiBBcnJheTx7IHZhbHVlOiBUcnVzdE1vZGU7IGxhYmVsOiBzdHJpbmc7IGRlc2NyaXB0aW9uOiBzdHJpbmcgfT4gPSBbXG4gIHsgdmFsdWU6ICdkcmFmdCcsIGxhYmVsOiAnRHJhZnQnLCBkZXNjcmlwdGlvbjogJ1lvdSBhcHByb3ZlIGV2ZXJ5IGVtYWlsIGJlZm9yZSBpdCBpcyBzZW50LicgfSxcbiAgeyB2YWx1ZTogJ3NlbWknLCBsYWJlbDogJ1NlbWktQXV0bycsIGRlc2NyaXB0aW9uOiAnU3RhZ2UgMSByZW1pbmRlcnMgc2VuZCBhdXRvbWF0aWNhbGx5OyBsYXRlciBzdGFnZXMgbmVlZCBhcHByb3ZhbC4nIH0sXG4gIHsgdmFsdWU6ICdmdWxsJywgbGFiZWw6ICdGdWxsIEF1dG8nLCBkZXNjcmlwdGlvbjogJ0Z1bGx5IGhhbmRzLW9mZiBmb2xsb3ctdXBzIGFjcm9zcyBldmVyeSBlc2NhbGF0aW9uIHN0YWdlLicgfSxcbl07XG5cbmludGVyZmFjZSBTZXR0aW5nc1Jlc3BvbnNlIHsgdHJ1c3RfbW9kZTogVHJ1c3RNb2RlIH1cbmludGVyZmFjZSBDb25uZWN0aW9uUmVzcG9uc2UgeyBjb25uZWN0ZWQ6IGJvb2xlYW47IGFjY291bnRfbmFtZT86IHN0cmluZyB9XG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIFNldHRpbmdzVmlldyhwcm9wcz86IHsgb2F1dGhDb250ZXh0PzogRXh0ZW5zaW9uQ29udGV4dFZhbHVlWydvYXV0aENvbnRleHQnXSB9KSB7XG4gIGNvbnN0IG9hdXRoQ29udGV4dCA9IHByb3BzPy5vYXV0aENvbnRleHQ7XG4gIGNvbnN0IFt0cnVzdE1vZGUsIHNldFRydXN0TW9kZV0gPSB1c2VTdGF0ZTxUcnVzdE1vZGUgfCBudWxsPihudWxsKTtcbiAgY29uc3QgW2Nvbm5lY3Rpb24sIHNldENvbm5lY3Rpb25dID0gdXNlU3RhdGU8Q29ubmVjdGlvblJlc3BvbnNlIHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IFtsb2FkaW5nLCBzZXRMb2FkaW5nXSA9IHVzZVN0YXRlKHRydWUpO1xuICBjb25zdCBbc2F2aW5nLCBzZXRTYXZpbmddID0gdXNlU3RhdGUoZmFsc2UpO1xuICBjb25zdCBbZXJyb3IsIHNldEVycm9yXSA9IHVzZVN0YXRlPHN0cmluZyB8IG51bGw+KG51bGwpO1xuXG4gIGNvbnN0IGxvYWQgPSB1c2VDYWxsYmFjayhhc3luYyAoKSA9PiB7XG4gICAgc2V0TG9hZGluZyh0cnVlKTtcbiAgICBzZXRFcnJvcihudWxsKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgW3NldHRpbmdzUmVzLCBjb25uUmVzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgZmV0Y2goYCR7QkFTRV9VUkx9L3NldHRpbmdzYCksXG4gICAgICAgIGZldGNoKGAke0JBU0VfVVJMfS9zdHJpcGUvY29ubmVjdGlvbmApLFxuICAgICAgXSk7XG4gICAgICBpZiAoIXNldHRpbmdzUmVzLm9rIHx8ICFjb25uUmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ1VuYWJsZSB0byBsb2FkIENvcGlsb3Qgc2V0dGluZ3MuJyk7XG4gICAgICBzZXRUcnVzdE1vZGUoKChhd2FpdCBzZXR0aW5nc1Jlcy5qc29uKCkpIGFzIFNldHRpbmdzUmVzcG9uc2UpLnRydXN0X21vZGUpO1xuICAgICAgc2V0Q29ubmVjdGlvbigoYXdhaXQgY29ublJlcy5qc29uKCkpIGFzIENvbm5lY3Rpb25SZXNwb25zZSk7XG4gICAgfSBjYXRjaCAoY2F1c2UpIHtcbiAgICAgIHNldEVycm9yKGNhdXNlIGluc3RhbmNlb2YgRXJyb3IgPyBjYXVzZS5tZXNzYWdlIDogJ1VuYWJsZSB0byBsb2FkIHNldHRpbmdzLicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBzZXRMb2FkaW5nKGZhbHNlKTtcbiAgICB9XG4gIH0sIFtdKTtcblxuICB1c2VFZmZlY3QoKCkgPT4geyB2b2lkIGxvYWQoKTsgfSwgW2xvYWRdKTtcblxuICBjb25zdCBzYXZlID0gYXN5bmMgKHZhbHVlOiBUcnVzdE1vZGUpID0+IHtcbiAgICBjb25zdCBwcmV2aW91cyA9IHRydXN0TW9kZTtcbiAgICBzZXRUcnVzdE1vZGUodmFsdWUpO1xuICAgIHNldFNhdmluZyh0cnVlKTtcbiAgICBzZXRFcnJvcihudWxsKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtCQVNFX1VSTH0vc2V0dGluZ3NgLCB7XG4gICAgICAgIG1ldGhvZDogJ1BVVCcsXG4gICAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHRydXN0X21vZGU6IHZhbHVlIH0pLFxuICAgICAgfSk7XG4gICAgICBpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0NvdWxkIG5vdCBzYXZlIFRydXN0IE1vZGUuJyk7XG4gICAgICBzZXRUcnVzdE1vZGUoKChhd2FpdCByZXNwb25zZS5qc29uKCkpIGFzIFNldHRpbmdzUmVzcG9uc2UpLnRydXN0X21vZGUgPz8gdmFsdWUpO1xuICAgIH0gY2F0Y2ggKGNhdXNlKSB7XG4gICAgICBzZXRUcnVzdE1vZGUocHJldmlvdXMpO1xuICAgICAgc2V0RXJyb3IoY2F1c2UgaW5zdGFuY2VvZiBFcnJvciA/IGNhdXNlLm1lc3NhZ2UgOiAnQ291bGQgbm90IHNhdmUgVHJ1c3QgTW9kZS4nKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgc2V0U2F2aW5nKGZhbHNlKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgYWNjb3VudE5hbWUgPSBjb25uZWN0aW9uPy5hY2NvdW50X25hbWU7XG5cbiAgcmV0dXJuIChcbiAgICA8Q29udGV4dFZpZXcgdGl0bGU9XCJDb2xsZWN0aW9ucyBDb3BpbG90XCI+XG4gICAgICA8Qm94IGNzcz17eyBzdGFjazogJ3knLCBnYXA6ICdtZWRpdW0nIH19PlxuICAgICAgICB7LyogQ29ubmVjdGlvbiBzdGF0dXMgKi99XG4gICAgICAgIDxCb3ggY3NzPXt7IHN0YWNrOiAneScsIGdhcDogJ3hzbWFsbCcgfX0+XG4gICAgICAgICAgPEJveCBjc3M9e3sgZm9udDogJ3N1YmhlYWRpbmcnLCBmb250V2VpZ2h0OiAnc2VtaWJvbGQnIH19PlN0cmlwZSBjb25uZWN0aW9uPC9Cb3g+XG4gICAgICAgICAge2xvYWRpbmcgPyAoXG4gICAgICAgICAgICA8U3Bpbm5lciAvPlxuICAgICAgICAgICkgOiBjb25uZWN0aW9uPy5jb25uZWN0ZWQgfHwgb2F1dGhDb250ZXh0ID8gKFxuICAgICAgICAgICAgPEJveCBjc3M9e3sgY29sb3I6ICdwcmltYXJ5JyB9fT5Db25uZWN0ZWQgYXMge2FjY291bnROYW1lIHx8ICd5b3VyIFN0cmlwZSBhY2NvdW50J308L0JveD5cbiAgICAgICAgICApIDogKFxuICAgICAgICAgICAgPEJveCBjc3M9e3sgY29sb3I6ICdzZWNvbmRhcnknIH19Pk5vdCBjb25uZWN0ZWQgXHUyMDE0IGNvbm5lY3QgeW91ciBTdHJpcGUgYWNjb3VudDwvQm94PlxuICAgICAgICAgICl9XG4gICAgICAgIDwvQm94PlxuXG4gICAgICAgIHsvKiBUcnVzdCBNb2RlIHNlbGVjdG9yICovfVxuICAgICAgICA8Qm94IGNzcz17eyBzdGFjazogJ3knLCBnYXA6ICd4c21hbGwnIH19PlxuICAgICAgICAgIDxCb3ggY3NzPXt7IGZvbnQ6ICdzdWJoZWFkaW5nJywgZm9udFdlaWdodDogJ3NlbWlib2xkJyB9fT5UcnVzdCBNb2RlPC9Cb3g+XG4gICAgICAgICAgPEJveCBjc3M9e3sgY29sb3I6ICdzZWNvbmRhcnknIH19PlxuICAgICAgICAgICAgQ29udHJvbCBob3cgYXV0b25vbW91cyBDb3BpbG90IGlzIHdoZW4gaGFuZGxpbmcgb3ZlcmR1ZSBpbnZvaWNlcy5cbiAgICAgICAgICA8L0JveD5cbiAgICAgICAgICB7bG9hZGluZyA/IChcbiAgICAgICAgICAgIDxTcGlubmVyIC8+XG4gICAgICAgICAgKSA6IChcbiAgICAgICAgICAgIDxTZWxlY3RcbiAgICAgICAgICAgICAgdmFsdWU9e3RydXN0TW9kZSA/PyB1bmRlZmluZWR9XG4gICAgICAgICAgICAgIGRpc2FibGVkPXtzYXZpbmd9XG4gICAgICAgICAgICAgIG9uQ2hhbmdlPXsoZXZlbnQpID0+IHtcbiAgICAgICAgICAgICAgICB2b2lkIHNhdmUoZXZlbnQudGFyZ2V0LnZhbHVlIGFzIFRydXN0TW9kZSk7XG4gICAgICAgICAgICAgIH19XG4gICAgICAgICAgICA+XG4gICAgICAgICAgICAgIHttb2Rlcy5tYXAoKHsgdmFsdWUsIGxhYmVsIH0pID0+IChcbiAgICAgICAgICAgICAgICA8b3B0aW9uIGtleT17dmFsdWV9IHZhbHVlPXt2YWx1ZX0+XG4gICAgICAgICAgICAgICAgICB7bGFiZWx9XG4gICAgICAgICAgICAgICAgPC9vcHRpb24+XG4gICAgICAgICAgICAgICkpfVxuICAgICAgICAgICAgPC9TZWxlY3Q+XG4gICAgICAgICAgKX1cbiAgICAgICAgICB7dHJ1c3RNb2RlICYmIChcbiAgICAgICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiAnc2Vjb25kYXJ5JywgZm9udDogJ2NhcHRpb24nIH19PlxuICAgICAgICAgICAgICB7bW9kZXMuZmluZCgobW9kZSkgPT4gbW9kZS52YWx1ZSA9PT0gdHJ1c3RNb2RlKT8uZGVzY3JpcHRpb259XG4gICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICApfVxuICAgICAgICA8L0JveD5cblxuICAgICAgICB7LyogRXJyb3IgYmFubmVyICovfVxuICAgICAgICB7ZXJyb3IgJiYgKFxuICAgICAgICAgIDxCYW5uZXJcbiAgICAgICAgICAgIHR5cGU9XCJjcml0aWNhbFwiXG4gICAgICAgICAgICB0aXRsZT1cIlNvbWV0aGluZyB3ZW50IHdyb25nXCJcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uPXtlcnJvcn1cbiAgICAgICAgICAgIGFjdGlvbnM9ezxCdXR0b24gb25QcmVzcz17KCkgPT4geyB2b2lkIGxvYWQoKTsgfX0+UmV0cnk8L0J1dHRvbj59XG4gICAgICAgICAgLz5cbiAgICAgICAgKX1cbiAgICAgIDwvQm94PlxuICAgIDwvQ29udGV4dFZpZXc+XG4gICk7XG59XG4iLCAiLy8vIDxyZWZlcmVuY2UgdHlwZXM9XCJ2aXRlL2NsaWVudFwiIC8+XG5cbmltcG9ydCB7IHVzZUNhbGxiYWNrLCB1c2VFZmZlY3QsIHVzZVN0YXRlIH0gZnJvbSAncmVhY3QnO1xuaW1wb3J0IHsgQmFubmVyLCBCb3gsIEJ1dHRvbiwgQ29udGV4dFZpZXcsIFNlbGVjdCwgU3Bpbm5lciB9IGZyb20gJ0BzdHJpcGUvdWktZXh0ZW5zaW9uLXNkay91aSc7XG5cbmNvbnN0IEJBU0VfVVJMID0gaW1wb3J0Lm1ldGEuZW52LlZJVEVfQkFDS0VORF9VUkwgPz8gJ2h0dHA6Ly9sb2NhbGhvc3Q6MzAwMSc7XG5cbnR5cGUgVHJ1c3RNb2RlID0gJ2RyYWZ0JyB8ICdzZW1pJyB8ICdmdWxsJztcbnR5cGUgVHJ1c3RNb2RlVmFsdWUgPSBUcnVzdE1vZGUgfCAnZ2xvYmFsJztcblxudHlwZSBJbnZvaWNlRGV0YWlscyA9IHtcbiAgaWQ6IHN0cmluZztcbiAgYW1vdW50PzogbnVtYmVyO1xuICBhbW91bnRfZHVlPzogbnVtYmVyO1xuICBhbW91bnREdWU/OiBudW1iZXI7XG4gIGN1cnJlbmN5Pzogc3RyaW5nO1xuICBkdWVfZGF0ZT86IHN0cmluZyB8IG51bWJlciB8IG51bGw7XG4gIGR1ZURhdGU/OiBzdHJpbmcgfCBudW1iZXIgfCBudWxsO1xuICBjdXN0b21lcl9uYW1lPzogc3RyaW5nO1xuICBjdXN0b21lck5hbWU/OiBzdHJpbmc7XG4gIGRheXNfb3ZlcmR1ZT86IG51bWJlcjtcbiAgZGF5c092ZXJkdWU/OiBudW1iZXI7XG4gIGVzY2FsYXRpb25fc3RhZ2U/OiBudW1iZXIgfCBzdHJpbmc7XG4gIGVzY2FsYXRpb25TdGFnZT86IG51bWJlciB8IHN0cmluZztcbiAgc2VxdWVuY2U/OiB7XG4gICAgZW1haWxzX3NlbnQ/OiBudW1iZXI7XG4gICAgZW1haWxzU2VudD86IG51bWJlcjtcbiAgICBsYXN0X3NlbmRfZGF0ZT86IHN0cmluZyB8IG51bGw7XG4gICAgbGFzdFNlbmREYXRlPzogc3RyaW5nIHwgbnVsbDtcbiAgICBuZXh0X3NjaGVkdWxlZD86IHN0cmluZyB8IG51bGw7XG4gICAgbmV4dFNjaGVkdWxlZD86IHN0cmluZyB8IG51bGw7XG4gICAgYWN0aXZlPzogYm9vbGVhbjtcbiAgICBwYXVzZWQ/OiBib29sZWFuO1xuICB9O1xuICBzZXF1ZW5jZV9zdGF0dXM/OiB7XG4gICAgZW1haWxzX3NlbnQ/OiBudW1iZXI7XG4gICAgbGFzdF9zZW5kX2RhdGU/OiBzdHJpbmcgfCBudWxsO1xuICAgIG5leHRfc2NoZWR1bGVkPzogc3RyaW5nIHwgbnVsbDtcbiAgICBhY3RpdmU/OiBib29sZWFuO1xuICAgIHBhdXNlZD86IGJvb2xlYW47XG4gIH07XG4gIGVtYWlsc19zZW50PzogbnVtYmVyO1xuICBlbWFpbHNTZW50PzogbnVtYmVyO1xuICBsYXN0X3NlbmRfZGF0ZT86IHN0cmluZyB8IG51bGw7XG4gIGxhc3RTZW5kRGF0ZT86IHN0cmluZyB8IG51bGw7XG4gIG5leHRfc2NoZWR1bGVkPzogc3RyaW5nIHwgbnVsbDtcbiAgbmV4dFNjaGVkdWxlZD86IHN0cmluZyB8IG51bGw7XG4gIHNlcXVlbmNlX2FjdGl2ZT86IGJvb2xlYW47XG4gIHNlcXVlbmNlQWN0aXZlPzogYm9vbGVhbjtcbiAgc2VxdWVuY2VfcGF1c2VkPzogYm9vbGVhbjtcbiAgc2VxdWVuY2VQYXVzZWQ/OiBib29sZWFuO1xufTtcblxuaW50ZXJmYWNlIFRydXN0TW9kZVJlc3BvbnNlIHsgdHJ1c3RNb2RlPzogVHJ1c3RNb2RlIHwgbnVsbDsgdHJ1c3RfbW9kZT86IFRydXN0TW9kZSB8IG51bGwgfVxuXG5jb25zdCB0cnVzdE1vZGVPcHRpb25zOiBBcnJheTx7IHZhbHVlOiBUcnVzdE1vZGVWYWx1ZTsgbGFiZWw6IHN0cmluZyB9PiA9IFtcbiAgeyB2YWx1ZTogJ2dsb2JhbCcsIGxhYmVsOiAnVXNlIGdsb2JhbCBkZWZhdWx0JyB9LFxuICB7IHZhbHVlOiAnZHJhZnQnLCBsYWJlbDogJ0RyYWZ0JyB9LFxuICB7IHZhbHVlOiAnc2VtaScsIGxhYmVsOiAnU2VtaS1BdXRvJyB9LFxuICB7IHZhbHVlOiAnZnVsbCcsIGxhYmVsOiAnRnVsbCBBdXRvJyB9LFxuXTtcblxuZnVuY3Rpb24gZm9ybWF0RGF0ZSh2YWx1ZT86IHN0cmluZyB8IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gJycpIHJldHVybiAnTm90IHNjaGVkdWxlZCc7XG4gIGNvbnN0IGRhdGUgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInID8gbmV3IERhdGUodmFsdWUgKiAxMDAwKSA6IG5ldyBEYXRlKHZhbHVlKTtcbiAgcmV0dXJuIE51bWJlci5pc05hTihkYXRlLmdldFRpbWUoKSkgPyBTdHJpbmcodmFsdWUpIDogZGF0ZS50b0xvY2FsZURhdGVTdHJpbmcoKTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0QW1vdW50KGludm9pY2U6IEludm9pY2VEZXRhaWxzKTogc3RyaW5nIHtcbiAgY29uc3QgYW1vdW50ID0gaW52b2ljZS5hbW91bnRfZHVlID8/IGludm9pY2UuYW1vdW50O1xuICBpZiAoYW1vdW50ID09PSB1bmRlZmluZWQgfHwgYW1vdW50ID09PSBudWxsKSByZXR1cm4gJ0Ftb3VudCB1bmF2YWlsYWJsZSc7XG4gIHJldHVybiBuZXcgSW50bC5OdW1iZXJGb3JtYXQodW5kZWZpbmVkLCB7XG4gICAgc3R5bGU6ICdjdXJyZW5jeScsIGN1cnJlbmN5OiAoaW52b2ljZS5jdXJyZW5jeSA/PyAndXNkJykudG9VcHBlckNhc2UoKSxcbiAgfSkuZm9ybWF0KGFtb3VudCAvIDEwMCk7XG59XG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIEludm9pY2VEZXRhaWxWaWV3KHByb3BzPzogeyBpbnZvaWNlSWQ/OiBzdHJpbmcgfSkge1xuICBjb25zdCBpbnZvaWNlSWQgPSBwcm9wcz8uaW52b2ljZUlkO1xuICBjb25zdCBbaW52b2ljZSwgc2V0SW52b2ljZV0gPSB1c2VTdGF0ZTxJbnZvaWNlRGV0YWlscyB8IG51bGw+KG51bGwpO1xuICBjb25zdCBbdHJ1c3RNb2RlLCBzZXRUcnVzdE1vZGVdID0gdXNlU3RhdGU8VHJ1c3RNb2RlVmFsdWU+KCdnbG9iYWwnKTtcbiAgY29uc3QgW2xvYWRpbmcsIHNldExvYWRpbmddID0gdXNlU3RhdGUoQm9vbGVhbihpbnZvaWNlSWQpKTtcbiAgY29uc3QgW3NhdmluZywgc2V0U2F2aW5nXSA9IHVzZVN0YXRlKGZhbHNlKTtcbiAgY29uc3QgW2Vycm9yLCBzZXRFcnJvcl0gPSB1c2VTdGF0ZTxzdHJpbmcgfCBudWxsPihudWxsKTtcblxuICBjb25zdCBsb2FkID0gdXNlQ2FsbGJhY2soYXN5bmMgKCkgPT4ge1xuICAgIGlmICghaW52b2ljZUlkKSByZXR1cm47XG4gICAgc2V0TG9hZGluZyh0cnVlKTtcbiAgICBzZXRFcnJvcihudWxsKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgW2ludm9pY2VSZXNwb25zZSwgbW9kZVJlc3BvbnNlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgZmV0Y2goYCR7QkFTRV9VUkx9L2ludm9pY2VzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGludm9pY2VJZCl9YCksXG4gICAgICAgIGZldGNoKGAke0JBU0VfVVJMfS9pbnZvaWNlcy8ke2VuY29kZVVSSUNvbXBvbmVudChpbnZvaWNlSWQpfS90cnVzdC1tb2RlYCksXG4gICAgICBdKTtcbiAgICAgIGlmICghaW52b2ljZVJlc3BvbnNlLm9rIHx8ICFtb2RlUmVzcG9uc2Uub2spIHRocm93IG5ldyBFcnJvcignVW5hYmxlIHRvIGxvYWQgaW52b2ljZSBjb2xsZWN0aW9uIHN0YXR1cy4nKTtcbiAgICAgIGNvbnN0IGludm9pY2VQYXlsb2FkID0gKGF3YWl0IGludm9pY2VSZXNwb25zZS5qc29uKCkpIGFzIEludm9pY2VEZXRhaWxzIHwgeyBpbnZvaWNlPzogSW52b2ljZURldGFpbHMgfTtcbiAgICAgIGNvbnN0IGRldGFpbHMgPSAnaW52b2ljZScgaW4gaW52b2ljZVBheWxvYWQgJiYgaW52b2ljZVBheWxvYWQuaW52b2ljZSA/IGludm9pY2VQYXlsb2FkLmludm9pY2UgOiBpbnZvaWNlUGF5bG9hZCBhcyBJbnZvaWNlRGV0YWlscztcbiAgICAgIGNvbnN0IG1vZGVQYXlsb2FkID0gKGF3YWl0IG1vZGVSZXNwb25zZS5qc29uKCkpIGFzIFRydXN0TW9kZVJlc3BvbnNlO1xuICAgICAgc2V0SW52b2ljZSh7IC4uLmRldGFpbHMsIGlkOiBkZXRhaWxzLmlkIHx8IGludm9pY2VJZCB9KTtcbiAgICAgIHNldFRydXN0TW9kZShtb2RlUGF5bG9hZC50cnVzdE1vZGUgPz8gbW9kZVBheWxvYWQudHJ1c3RfbW9kZSA/PyAnZ2xvYmFsJyk7XG4gICAgfSBjYXRjaCAoY2F1c2UpIHtcbiAgICAgIHNldEVycm9yKGNhdXNlIGluc3RhbmNlb2YgRXJyb3IgPyBjYXVzZS5tZXNzYWdlIDogJ1VuYWJsZSB0byBsb2FkIGludm9pY2UgY29sbGVjdGlvbiBzdGF0dXMuJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHNldExvYWRpbmcoZmFsc2UpO1xuICAgIH1cbiAgfSwgW2ludm9pY2VJZF0pO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7IHZvaWQgbG9hZCgpOyB9LCBbbG9hZF0pO1xuXG4gIGNvbnN0IHNhdmVUcnVzdE1vZGUgPSBhc3luYyAodmFsdWU6IFRydXN0TW9kZVZhbHVlKSA9PiB7XG4gICAgaWYgKCFpbnZvaWNlSWQpIHJldHVybjtcbiAgICBjb25zdCBwcmV2aW91cyA9IHRydXN0TW9kZTtcbiAgICBzZXRUcnVzdE1vZGUodmFsdWUpO1xuICAgIHNldFNhdmluZyh0cnVlKTtcbiAgICBzZXRFcnJvcihudWxsKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtCQVNFX1VSTH0vaW52b2ljZXMvJHtlbmNvZGVVUklDb21wb25lbnQoaW52b2ljZUlkKX0vdHJ1c3QtbW9kZWAsIHtcbiAgICAgICAgbWV0aG9kOiAnUFVUJyxcbiAgICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgdHJ1c3RfbW9kZTogdmFsdWUgPT09ICdnbG9iYWwnID8gbnVsbCA6IHZhbHVlIH0pLFxuICAgICAgfSk7XG4gICAgICBpZiAoIXJlc3BvbnNlLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0NvdWxkIG5vdCBzYXZlIHRoZSBpbnZvaWNlIFRydXN0IE1vZGUgb3ZlcnJpZGUuJyk7XG4gICAgICBjb25zdCByZXN1bHQgPSAoYXdhaXQgcmVzcG9uc2UuanNvbigpKSBhcyBUcnVzdE1vZGVSZXNwb25zZTtcbiAgICAgIHNldFRydXN0TW9kZShyZXN1bHQudHJ1c3RNb2RlID8/IHJlc3VsdC50cnVzdF9tb2RlID8/IHZhbHVlKTtcbiAgICB9IGNhdGNoIChjYXVzZSkge1xuICAgICAgc2V0VHJ1c3RNb2RlKHByZXZpb3VzKTtcbiAgICAgIHNldEVycm9yKGNhdXNlIGluc3RhbmNlb2YgRXJyb3IgPyBjYXVzZS5tZXNzYWdlIDogJ0NvdWxkIG5vdCBzYXZlIHRoZSBpbnZvaWNlIFRydXN0IE1vZGUgb3ZlcnJpZGUuJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHNldFNhdmluZyhmYWxzZSk7XG4gICAgfVxuICB9O1xuXG4gIGlmICghaW52b2ljZUlkKSB7XG4gICAgcmV0dXJuIDxDb250ZXh0VmlldyB0aXRsZT1cIkNvbGxlY3Rpb25zIENvcGlsb3RcIj48Qm94IGNzcz17eyBjb2xvcjogJ3NlY29uZGFyeScgfX0+U2VsZWN0IGFuIGludm9pY2UgdG8gdmlldyBpdHMgY29sbGVjdGlvbiBzdGF0dXMuPC9Cb3g+PC9Db250ZXh0Vmlldz47XG4gIH1cblxuICBjb25zdCBzZXF1ZW5jZSA9IGludm9pY2U/LnNlcXVlbmNlID8/IGludm9pY2U/LnNlcXVlbmNlX3N0YXR1cztcbiAgY29uc3QgZW1haWxzU2VudCA9IHNlcXVlbmNlPy5lbWFpbHNfc2VudCA/PyBzZXF1ZW5jZT8uZW1haWxzU2VudCA/PyBpbnZvaWNlPy5lbWFpbHNfc2VudCA/PyBpbnZvaWNlPy5lbWFpbHNTZW50ID8/IDA7XG4gIGNvbnN0IGxhc3RTZW5kRGF0ZSA9IHNlcXVlbmNlPy5sYXN0X3NlbmRfZGF0ZSA/PyBzZXF1ZW5jZT8ubGFzdFNlbmREYXRlID8/IGludm9pY2U/Lmxhc3Rfc2VuZF9kYXRlID8/IGludm9pY2U/Lmxhc3RTZW5kRGF0ZTtcbiAgY29uc3QgbmV4dFNjaGVkdWxlZCA9IHNlcXVlbmNlPy5uZXh0X3NjaGVkdWxlZCA/PyBzZXF1ZW5jZT8ubmV4dFNjaGVkdWxlZCA/PyBpbnZvaWNlPy5uZXh0X3NjaGVkdWxlZCA/PyBpbnZvaWNlPy5uZXh0U2NoZWR1bGVkO1xuICBjb25zdCBhY3RpdmUgPSBzZXF1ZW5jZT8uYWN0aXZlID8/IGludm9pY2U/LnNlcXVlbmNlX2FjdGl2ZSA/PyBpbnZvaWNlPy5zZXF1ZW5jZUFjdGl2ZTtcbiAgY29uc3QgcGF1c2VkID0gc2VxdWVuY2U/LnBhdXNlZCA/PyBpbnZvaWNlPy5zZXF1ZW5jZV9wYXVzZWQgPz8gaW52b2ljZT8uc2VxdWVuY2VQYXVzZWQ7XG4gIGNvbnN0IHN0YWdlID0gaW52b2ljZT8uZXNjYWxhdGlvbl9zdGFnZSA/PyBpbnZvaWNlPy5lc2NhbGF0aW9uU3RhZ2U7XG5cbiAgcmV0dXJuIDxDb250ZXh0VmlldyB0aXRsZT1cIkNvbGxlY3Rpb25zIENvcGlsb3RcIj48Qm94IGNzcz17eyBzdGFjazogJ3knLCBnYXA6ICdtZWRpdW0nIH19PlxuICAgIHtlcnJvciAmJiA8QmFubmVyIHR5cGU9XCJjcml0aWNhbFwiIHRpdGxlPVwiU29tZXRoaW5nIHdlbnQgd3JvbmdcIiBkZXNjcmlwdGlvbj17ZXJyb3J9IGFjdGlvbnM9ezxCdXR0b24gb25QcmVzcz17KCkgPT4geyB2b2lkIGxvYWQoKTsgfX0+UmV0cnk8L0J1dHRvbj59IC8+fVxuICAgIHtsb2FkaW5nID8gPFNwaW5uZXIgLz4gOiBpbnZvaWNlID8gPD5cbiAgICAgIDxCb3ggY3NzPXt7IHN0YWNrOiAneScsIGdhcDogJ3hzbWFsbCcgfX0+XG4gICAgICAgIDxCb3ggY3NzPXt7IGZvbnQ6ICdoZWFkaW5nJywgZm9udFdlaWdodDogJ3NlbWlib2xkJyB9fT57aW52b2ljZS5pZH08L0JveD5cbiAgICAgICAgPEJveCBjc3M9e3sgZm9udDogJ3N1YmhlYWRpbmcnLCBmb250V2VpZ2h0OiAnc2VtaWJvbGQnIH19Pntmb3JtYXRBbW91bnQoaW52b2ljZSl9PC9Cb3g+XG4gICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiAnc2Vjb25kYXJ5JyB9fT57aW52b2ljZS5jdXN0b21lcl9uYW1lID8/IGludm9pY2UuY3VzdG9tZXJOYW1lID8/ICdDdXN0b21lciB1bmF2YWlsYWJsZSd9PC9Cb3g+XG4gICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiAnc2Vjb25kYXJ5JyB9fT5EdWUge2Zvcm1hdERhdGUoaW52b2ljZS5kdWVfZGF0ZSA/PyBpbnZvaWNlLmR1ZURhdGUpfSBcdTAwQjcge2ludm9pY2UuZGF5c19vdmVyZHVlID8/IGludm9pY2UuZGF5c092ZXJkdWUgPz8gMH0gZGF5cyBvdmVyZHVlPC9Cb3g+XG4gICAgICA8L0JveD5cbiAgICAgIDxCb3ggY3NzPXt7IHN0YWNrOiAneScsIGdhcDogJ3hzbWFsbCcgfX0+XG4gICAgICAgIDxCb3ggY3NzPXt7IGZvbnQ6ICdzdWJoZWFkaW5nJywgZm9udFdlaWdodDogJ3NlbWlib2xkJyB9fT5Db2xsZWN0aW9uIHNlcXVlbmNlPC9Cb3g+XG4gICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiAnc2Vjb25kYXJ5JyB9fT5Fc2NhbGF0aW9uIHN0YWdlOiB7c3RhZ2UgPT09IHVuZGVmaW5lZCA/ICdOb3QgYXZhaWxhYmxlJyA6IGBTdGFnZSAke3N0YWdlfWB9PC9Cb3g+XG4gICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiBwYXVzZWQgPyAnc2Vjb25kYXJ5JyA6ICdwcmltYXJ5JyB9fT5TdGF0dXM6IHtwYXVzZWQgPyAnUGF1c2VkJyA6IGFjdGl2ZSA9PT0gZmFsc2UgPyAnSW5hY3RpdmUnIDogJ0FjdGl2ZSd9PC9Cb3g+XG4gICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiAnc2Vjb25kYXJ5JyB9fT5FbWFpbHMgc2VudDoge2VtYWlsc1NlbnR9PC9Cb3g+XG4gICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiAnc2Vjb25kYXJ5JyB9fT5MYXN0IHNlbmQ6IHtmb3JtYXREYXRlKGxhc3RTZW5kRGF0ZSl9PC9Cb3g+XG4gICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiAnc2Vjb25kYXJ5JyB9fT5OZXh0IHNjaGVkdWxlZDoge2Zvcm1hdERhdGUobmV4dFNjaGVkdWxlZCl9PC9Cb3g+XG4gICAgICA8L0JveD5cbiAgICAgIDxCb3ggY3NzPXt7IHN0YWNrOiAneScsIGdhcDogJ3hzbWFsbCcgfX0+XG4gICAgICAgIDxCb3ggY3NzPXt7IGZvbnQ6ICdzdWJoZWFkaW5nJywgZm9udFdlaWdodDogJ3NlbWlib2xkJyB9fT5UcnVzdCBNb2RlIG92ZXJyaWRlPC9Cb3g+XG4gICAgICAgIDxCb3ggY3NzPXt7IGNvbG9yOiAnc2Vjb25kYXJ5JyB9fT5DaG9vc2UgaG93IENvcGlsb3QgaGFuZGxlcyB0aGlzIGludm9pY2UsIG92ZXJyaWRpbmcgdGhlIGdsb2JhbCBkZWZhdWx0LjwvQm94PlxuICAgICAgICA8U2VsZWN0IHZhbHVlPXt0cnVzdE1vZGV9IGRpc2FibGVkPXtzYXZpbmd9IG9uQ2hhbmdlPXsoZXZlbnQpID0+IHsgdm9pZCBzYXZlVHJ1c3RNb2RlKGV2ZW50LnRhcmdldC52YWx1ZSBhcyBUcnVzdE1vZGVWYWx1ZSk7IH19PlxuICAgICAgICAgIHt0cnVzdE1vZGVPcHRpb25zLm1hcCgob3B0aW9uKSA9PiA8b3B0aW9uIGtleT17b3B0aW9uLnZhbHVlfSB2YWx1ZT17b3B0aW9uLnZhbHVlfT57b3B0aW9uLmxhYmVsfTwvb3B0aW9uPil9XG4gICAgICAgIDwvU2VsZWN0PlxuICAgICAgICB7c2F2aW5nICYmIDxTcGlubmVyIC8+fVxuICAgICAgPC9Cb3g+XG4gICAgPC8+IDogPEJveCBjc3M9e3sgY29sb3I6ICdzZWNvbmRhcnknIH19Pkludm9pY2UgZGV0YWlscyBhcmUgdW5hdmFpbGFibGUuPC9Cb3g+fVxuICA8L0JveD48L0NvbnRleHRWaWV3Pjtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQTtBQUFBO0FBQ0EsYUFBTyxlQUFlLFNBQVMsY0FBYyxFQUFFLE9BQU8sS0FBSyxDQUFDO0FBQzVELGNBQVEsY0FBYztBQUN0QixjQUFRLGNBQWM7QUFBQTtBQUFBOzs7QUNIdEI7QUFBQTtBQUFBO0FBQ0EsYUFBTyxlQUFlLFNBQVMsY0FBYyxFQUFFLE9BQU8sS0FBSyxDQUFDO0FBQzVELGNBQVEsa0JBQWtCLFFBQVEsWUFBWSxRQUFRLGNBQWMsUUFBUSxZQUFZLFFBQVEsWUFBWSxRQUFRLE1BQU0sUUFBUSxZQUFZLFFBQVEsV0FBVyxRQUFRLFVBQVUsUUFBUSxTQUFTLFFBQVEscUJBQXFCLFFBQVEsVUFBVSxRQUFRLFlBQVksUUFBUSxhQUFhLFFBQVEsZUFBZSxRQUFRLFNBQVMsUUFBUSxRQUFRLFFBQVEsZUFBZSxRQUFRLG1CQUFtQixRQUFRLDRCQUE0QixRQUFRLGlCQUFpQixRQUFRLE9BQU8sUUFBUSxXQUFXLFFBQVEsWUFBWSxRQUFRLE9BQU8sUUFBUSxXQUFXLFFBQVEsT0FBTyxRQUFRLFlB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LG9CQUFXLFVBQVU7QUFBQSxvQkFBUSxVQUFVLENBQUMsVUFBVTtBQUFFLDJCQUFLLGNBQWMsTUFBTSxPQUFPLEtBQXVCO0FBQUEsb0JBQUc7QUFBQSxvQkFDMUgsMkJBQWlCLElBQUksQ0FBQyxXQUFXLDZDQUFDO0FBQUEsc0JBQTBCLE9BQU8sT0FBTztBQUFBLHNCQUFRLGlCQUFPO0FBQUEsdUJBQTNDLE9BQU8sS0FBMEMsQ0FBUztBQUFBLG1CQUMzRztBQUFBLGtCQUNDLFVBQVUsNkNBQUMsc0JBQVE7QUFBQTtBQUFBLGVBQ3RCO0FBQUE7QUFBQSxXQUNGLElBQU0sNkNBQUM7QUFBQSxZQUFJLEtBQUssRUFBRSxPQUFPLFlBQVk7QUFBQSxZQUFHO0FBQUEsV0FBZ0M7QUFBQTtBQUFBLE9BQzFFO0FBQUEsS0FBTTtBQUFBLEVBQ1I7OztBRm5LQSwrQkFBYztBQVdQLE1BQU0sYUFBYTtBQUcxQixNQUFPLG1CQUFRO0FBQUEsSUFDYixXQUFXO0FBQUEsSUFDWCxRQUFRO0FBQUEsSUFDUixNQUFNO0FBQUEsSUFDTixRQUFRO0FBQUEsSUFDUixlQUFlO0FBQUEsTUFDYjtBQUFBLFFBQ0UsY0FBYztBQUFBLFFBQ2QsV0FBVztBQUFBLE1BQ2I7QUFBQSxNQUNBO0FBQUEsUUFDRSxjQUFjO0FBQUEsUUFDZCxXQUFXO0FBQUEsTUFDYjtBQUFBLElBQ0Y7QUFBQSxJQUNBLGdCQUFnQjtBQUFBLE1BQ2QsU0FBUztBQUFBLFFBQ1A7QUFBQSxVQUNFLGFBQWE7QUFBQSxVQUNiLFlBQVk7QUFBQSxRQUNkO0FBQUEsUUFDQTtBQUFBLFVBQ0UsYUFBYTtBQUFBLFVBQ2IsWUFBWTtBQUFBLFFBQ2Q7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLElBQ0EsV0FBVztBQUFBLEVBQ2I7IiwKICAibmFtZXMiOiBbImltcG9ydF9yZWFjdCIsICJpbXBvcnRfdWkiLCAiaW1wb3J0X2pzeF9ydW50aW1lIiwgImltcG9ydF9tZXRhIiwgIkJBU0VfVVJMIl0KfQo=
