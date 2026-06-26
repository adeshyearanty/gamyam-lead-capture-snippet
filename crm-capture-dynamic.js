/**
 * Gamyam.ai CRM Lead Capture Snippet
 * Config global: window.GamyamLeadCaptureConfig (AES-GCM + CAPTURE_ENCRYPTION_KEY).
 * Do not use UniBoxEmbedConfig / UniBoxSettings — those belong to chatbot-widget.js.
 */
(function () {
  "use strict";

  const DEFAULT_ENCRYPTION_PASSPHRASE = "capture-widget-encryption-key-2026";

  function normalizeBase64(str) {
    if (typeof str !== "string") return "";
    const trimmed = str.trim().replace(/\s+/g, "");
    const b64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
    const padding = b64.length % 4;
    if (!padding) return b64;
    return b64 + "=".repeat(4 - padding);
  }

  function base64Decode(str) {
    const binary = atob(normalizeBase64(str));
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function tryParseJson(value) {
    if (typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch (_e) {
      return null;
    }
  }

  function resolveEncryptedPayload(rawValue) {
    if (!rawValue) return null;

    if (typeof rawValue === "object") {
      const iv = rawValue.iv || rawValue.nonce || rawValue.initializationVector;
      const ciphertext =
        rawValue.ciphertext ||
        rawValue.data ||
        rawValue.encryptedData ||
        rawValue.payload;
      if (iv && ciphertext) {
        return { ivBytes: base64Decode(iv), cipherBytes: base64Decode(ciphertext) };
      }
      return null;
    }

    if (typeof rawValue !== "string") return null;

    const parsed = tryParseJson(rawValue);
    if (parsed && typeof parsed === "object") {
      return resolveEncryptedPayload(parsed);
    }

    const combined = base64Decode(rawValue);
    if (combined.length <= 12) {
      throw new Error("Encrypted payload too short");
    }
    return { ivBytes: combined.slice(0, 12), cipherBytes: combined.slice(12) };
  }

  async function getEncryptionKey(passphrase) {
    const encoder = new TextEncoder();
    const passphraseBytes = encoder.encode(passphrase);
    const hash = await crypto.subtle.digest("SHA-256", passphraseBytes);
    return crypto.subtle.importKey(
      "raw",
      hash,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async function decryptConfig(encryptedBase64, passphrase) {
    if (!encryptedBase64 || !passphrase || !window.crypto?.subtle || !window.atob) {
      throw new Error("Decryption not available");
    }
    const payload = resolveEncryptedPayload(encryptedBase64);
    if (!payload) {
      throw new Error("Unsupported encrypted config format");
    }

    const key = await getEncryptionKey(passphrase);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: payload.ivBytes },
      key,
      payload.cipherBytes,
    );

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(plaintext));
  }

  const defaults = {
    baseUrl: "",
    endpointPath: "/leads",
    endpoint: null,
    tenantId: "",
    apiToken: "",
    blockNativeSubmit: false,
    fieldMappings: {
      fullName: ["fullName", "name", "full_name"],
      email: ["email", "email_address"],
      companyName: ["companyName", "company", "org"],
    },
    defaultValues: {
      status: "New",
      createdDate: () => new Date().toISOString(),
    },
    formClass: "crm-capture-form",
    buttonClass: "crm-capture-btn",
    debug: false,
    reactForm: false,
    defaultStatus: "New",
    defaultSource: "Website",
    defaultCreatedBy: "snippet",
  };

  class CRMLeadCapture {
    constructor(options) {
      this.config = { ...defaults, ...options };

      if (!this.config.endpoint && this.config.baseUrl && this.config.endpointPath) {
        const trimmedBase = this.config.baseUrl.replace(/\/+$/, "");
        this.config.endpoint = `${trimmedBase}${this.config.endpointPath}`;
      }

      this.initialize();
    }

    initialize() {
      if (this.config.status === "inactive") {
        this.log("Integration is inactive; skipping bind.", null, "warn");
        return;
      }

      if (this.config.reactForm || this.config.reactForms) {
        this.setupReactListener();
      } else {
        this.bindEvents();
      }
      this.log("Initialized", { endpoint: this.config.endpoint });
    }

    setupReactListener() {
      if (typeof MutationObserver === "undefined") return;

      const attachForm = (form) => {
        if (!form || form.__gamyamCaptureBound) return;
        const hasButton =
          form.querySelector(`.${this.config.buttonClass}`) ||
          form.classList.contains(this.config.formClass);
        if (!hasButton) return;

        form.__gamyamCaptureBound = true;
        form.addEventListener("submit", (e) => {
          if (this.config.blockNativeSubmit) e.preventDefault();
          this.handleReactForm(form);
        });
      };

      document.querySelectorAll("form").forEach(attachForm);

      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.nodeName === "FORM") attachForm(node);
            node.querySelectorAll?.("form").forEach(attachForm);
          });
        });
      });

      observer.observe(document.body, { childList: true, subtree: true });
    }

    handleReactForm(form) {
      // Must use extractFormData so data-crm-field-mappings are applied
      // (e.g. fullName <- input name="name"), not raw FormData keys.
      const leadData = this.prepareLeadData(this.extractFormData(form));
      if (this.validateLeadData(leadData)) {
        this.submitLead(leadData).then(() => {
          const event = new Event("crmLeadSuccess");
          form.dispatchEvent(event);
        });
      }
    }

    bindEvents() {
      document.addEventListener("submit", (e) => {
        const form = e.target;
        if (
          form?.classList?.contains(this.config.formClass) ||
          form?.querySelector?.(`.${this.config.buttonClass}`)
        ) {
          if (this.config.blockNativeSubmit) e.preventDefault();
          this.handleFormSubmit(form);
        }
      });
    }

    handleFormSubmit(form) {
      const formData = this.extractFormData(form);
      const leadData = this.prepareLeadData(formData);
      if (this.validateLeadData(leadData)) {
        this.submitLead(leadData);
      } else {
        this.log("Validation failed", null, "error");
      }
    }

    extractFormData(form) {
      const formData = {};
      const elements = form.elements;
      console.log("Field mappings:", this.config.fieldMappings);

      for (let element of elements) {
        if (element.hasAttribute("data-crm-field")) {
          const fieldName = element.getAttribute("data-crm-field");
          formData[fieldName] = this.sanitizeInput(element.value);
        }
      }

      for (const [field, mapping] of Object.entries(this.config.fieldMappings)) {
        if (formData[field]) continue;

        if (typeof mapping === "object" && mapping.combine) {
          const parts = mapping.combine.map((fieldName) => {
            const el = form.querySelector(`[name="${fieldName}"], #${fieldName}`);
            return el?.value?.trim() || "";
          });
          formData[field] = parts.filter(Boolean).join(mapping.separator || " ");
          continue;
        }

        const selectors = Array.isArray(mapping) ? mapping : [mapping];
        const fd = new FormData(form);

        for (const selector of selectors) {
          const rawValue = fd.get(selector);
          console.log(selector, element, element?.value, new FormData(form).get(selector));
        
          if (rawValue != null && String(rawValue).trim() !== "") {
            formData[field] = this.sanitizeInput(String(rawValue));
            break;
          }
        }
      }
      console.log("Extracted formData:", formData);

      return formData;
    }

    sanitizeInput(value) {
      if (!value) return value;
      return value
        .toString()
        .replace(/<script.*?<\/script>/gi, "")
        .replace(/<\/?[^>]+(>|$)/g, "");
    }

    prepareLeadData(formData) {
      const leadData = { ...formData };

      for (const [field, defaultValue] of Object.entries(this.config.defaultValues)) {
        if (field === "status" || field === "source" || field === "createdBy") continue;
        if (!leadData[field]) {
          leadData[field] =
            typeof defaultValue === "function" ? defaultValue() : defaultValue;
        }
      }

      leadData.status = this.config.defaultStatus || leadData.status || "New";
      leadData.source = this.config.defaultSource || leadData.source || "Website";
      leadData.createdBy =
        this.config.defaultCreatedBy || leadData.createdBy || "snippet";

      if (!leadData.leadOwner) leadData.leadOwner = "system";

      return leadData;
    }

    validateLeadData(leadData) {
      if (!leadData.email) {
        this.log("Email is required", null, "error");
        return false;
      }
      if (!leadData.fullName) {
        this.log("Full name is required", null, "error");
        return false;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(leadData.email)) {
        this.log("Invalid email format", null, "error");
        return false;
      }

      return true;
    }

    submitLead(leadData) {
      this.log("Submitting lead", leadData);

      const headers = {
        "Content-Type": "application/json",
      };

      if (this.config.apiToken) {
        headers["x-api-key"] = this.config.apiToken;
      }
      if (this.config.tenantId) {
        headers["x-tenant-id"] = this.config.tenantId;
      }

      return fetch(this.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(leadData),
      })
        .then((response) => {
          if (!response.ok) {
            return response.json().then((err) => {
              throw new Error(err.message || "Failed to submit lead");
            });
          }
          return response.json();
        })
        .then((data) => {
          this.log("Lead submitted successfully", data);
          this.dispatchEvent("crmLeadSuccess", data);
          if (typeof this.config.onSuccess === "function") this.config.onSuccess(data);
        })
        .catch((error) => {
          this.log("Error submitting lead", error, "error");
          this.dispatchEvent("crmLeadError", error);
          if (typeof this.config.onError === "function") this.config.onError(error);
        });
    }

    dispatchEvent(eventName, detail) {
      document.dispatchEvent(new CustomEvent(eventName, { detail }));
    }

    log(message, data, level = "log") {
      if (this.config.debug || level === "error" || level === "warn") {
        console[level](`[Gamyam CRM] ${message}`, data ?? "");
      }
    }
  }

  window.CRMLeadCapture = CRMLeadCapture;

  function normalizeDecryptedConfig(decrypted) {
    if (!decrypted || typeof decrypted !== "object") return {};
    return {
      ...decrypted,
      debug: decrypted.debugDefault ?? decrypted.debug ?? false,
      reactForm: decrypted.reactForm ?? decrypted.reactForms ?? false,
      defaultStatus: decrypted.defaultStatus,
      defaultSource: decrypted.defaultSource,
      defaultCreatedBy: decrypted.defaultCreatedBy,
    };
  }

  async function bootstrap() {
    const scriptEl =
      document.currentScript ||
      document.querySelector('script[src*="crm-capture-dynamic.js"], script[src*="capture-widget.js"]');
    if (!scriptEl) return;

    const baseOptions = {
      endpoint: scriptEl.getAttribute("data-crm-endpoint") || null,
      baseUrl: scriptEl.getAttribute("data-crm-base-url") || defaults.baseUrl,
      endpointPath:
        scriptEl.getAttribute("data-crm-endpoint-path") || defaults.endpointPath,
      apiToken: scriptEl.getAttribute("data-crm-api-token") || defaults.apiToken,
      tenantId: scriptEl.getAttribute("data-crm-tenant-id") || "",
      debug: scriptEl.hasAttribute("data-crm-debug"),
      buttonClass:
        scriptEl.getAttribute("data-crm-button-class") || defaults.buttonClass,
      formClass: scriptEl.getAttribute("data-crm-form-class") || defaults.formClass,
      onSuccess:
        typeof window.crmCaptureConfig?.onSuccess === "function"
          ? window.crmCaptureConfig.onSuccess
          : null,
      onError:
        typeof window.crmCaptureConfig?.onError === "function"
          ? window.crmCaptureConfig.onError
          : null,
    };

    const rawMappings = scriptEl.getAttribute("data-crm-field-mappings");
    if (rawMappings) {
      try {
        baseOptions.fieldMappings = JSON.parse(rawMappings);
      } catch (_e) {
        console.error("[Gamyam CRM] Invalid JSON in data-crm-field-mappings");
      }
    }

    let finalOptions = { ...baseOptions };

    try {
      // Prefer lead-capture globals. UniBoxEmbedConfig is legacy-only for old embeds
      // (safe when chatbot widget is not on the same page).
      const globalCfg =
        window.GamyamLeadCaptureConfig ||
        window.CRMLeadCaptureConfig ||
        (window.UniBoxEmbedConfig?.encryptedConfig
          ? window.UniBoxEmbedConfig
          : null);
      const encryptedConfig = globalCfg?.encryptedConfig;
      const plainGlobal =
        globalCfg && typeof globalCfg === "object"
          ? (() => {
              const { encryptedConfig: _ignored, ...plain } = globalCfg;
              return plain;
            })()
          : {};

      if (encryptedConfig) {
        const passphrase =
          globalCfg?.encryptionKeyVersion ||
          window.CaptureEncryptionKey ||
          DEFAULT_ENCRYPTION_PASSPHRASE;

        try {
          const decrypted = normalizeDecryptedConfig(
            await decryptConfig(encryptedConfig, passphrase),
          );
          finalOptions = {
            ...baseOptions,
            ...plainGlobal,
            ...decrypted,
            fieldMappings: {
              ...(decrypted.fieldMappings || {}),
              ...(baseOptions.fieldMappings || {}),
            },
          };
        } catch (decryptErr) {
          const parsed =
            typeof encryptedConfig === "string"
              ? tryParseJson(encryptedConfig)
              : null;
          if (parsed && typeof parsed === "object") {
            finalOptions = {
              ...baseOptions,
              ...plainGlobal,
              ...normalizeDecryptedConfig(parsed),
            };
          } else {
            finalOptions = { ...baseOptions, ...plainGlobal };
            const reason =
              decryptErr instanceof Error ? decryptErr.message : String(decryptErr);
            console.error(
              `[Gamyam CRM] Failed to decrypt config (${reason}). Check CAPTURE_ENCRYPTION_KEY matches encryptionKeyVersion.`,
            );
            return;
          }
        }
      } else if (globalCfg && typeof globalCfg === "object") {
        finalOptions = { ...baseOptions, ...plainGlobal };
      }
    } catch (e) {
      console.error("[Gamyam CRM] Failed to load config", e);
      return;
    }

    if (!finalOptions.endpoint && !finalOptions.baseUrl) {
      console.error("[Gamyam CRM] Missing baseUrl/endpoint in config.");
      return;
    }

    new CRMLeadCapture(finalOptions);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bootstrap().catch((err) => console.error("[Gamyam CRM] Bootstrap failed", err));
    });
  } else {
    bootstrap().catch((err) => console.error("[Gamyam CRM] Bootstrap failed", err));
  }
})();
