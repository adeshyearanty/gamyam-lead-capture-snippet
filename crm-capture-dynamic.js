/**
 * Gamyam.ai CRM Lead Capture Snippet
 * Version 2.0 - API Compliant
 */

(function () {
  "use strict";

  // Shared secret used to derive the AES-GCM key.
  // IMPORTANT: keep this in sync with whatever you use on the UI to encrypt.
  const ENCRYPTION_PASSPHRASE = "capture-widget-encryption-key-2026";

  // --- Encryption helpers (decrypt only, UI does encrypt) ---
  function base64Decode(str) {
    const binary = atob(str);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
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
      ["encrypt", "decrypt"]
    );
  }

  async function decryptConfig(encryptedBase64, passphrase) {
    if (!encryptedBase64 || !passphrase || !window.crypto?.subtle) {
      throw new Error("Decryption not available");
    }

    const combined = base64Decode(encryptedBase64);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const key = await getEncryptionKey(passphrase);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    const json = decoder.decode(plaintext);
    return JSON.parse(json);
  }

  // Configuration defaults
  const defaults = {
    siteId: "",
    apiToken: "09FwQAlQL37yaYMYBifrw9m8TkIWoK3228uELTc3",
    // Base URL and endpoint for public lead creation
    baseUrl: "https://dev-api.salesastra.ai/leads/v1",
    endpointPath: "/leads/public",
    // If endpoint is null, it'll be derived from baseUrl + endpointPath
    endpoint: null,
    tenantId: "",
    // Default field mappings to your DTO (aligned with LeadDocument)
    fieldMappings: {
      leadOwner: ["leadOwner", "owner"],
      fullName: ["fullName", "name", "full_name"],
      salutation: ["salutation", "title"],
      email: ["email", "email_address"],
      website: ["website", "url", "site"],
      contactCountryCode: ["contactCountryCode", "countryCode", "phoneCode"],
      contactNumber: ["contactNumber", "phone", "telephone", "mobile"],
      contactExtension: ["contactExtension", "extension"],
      alternateCountryCode: ["alternateCountryCode", "altCountryCode"],
      alternateNumber: ["alternateNumber", "altPhone"],
      alternateExtension: ["alternateExtension", "altExtension"],
      companyName: ["companyName", "company", "org"],
      designation: ["designation", "jobTitle", "position"],
      companySize: ["companySize", "employees"],
      industryType: ["industryType", "industry"],
      status: ["status", "leadStatus"],
      preferredChannel: ["preferredChannel", "contactMethod"],
      description: ["description", "message", "comments", "notes"],
      linkedinUrl: ["linkedinUrl", "linkedin"],
      twitterUrl: ["twitterUrl", "twitter"],
      annualRevenue: ["annualRevenue", "revenue"],
      // Additional fields from CreateLeadDto / LeadDocument
      createdDate: ["createdDate", "created_at", "createdOn"],
      createdBy: ["createdBy", "created_by"],
      lastActivityDate: ["lastActivityDate", "last_activity_date"],
      organizationId: ["organizationId", "orgId", "organization_id"],
    },
    // Default values for required fields
    defaultValues: {
      status: "New",
      // source is always forced to "Website" in prepareLeadData
      createdDate: () => new Date().toISOString(),
    },
    buttonClass: "crm-capture-btn",
    debug: false,
  };

  // Main class
  class CRMLeadCapture {
    constructor(options) {
      this.config = { ...defaults, ...options };

      // Derive endpoint from baseUrl + endpointPath if not explicitly provided
      if (!this.config.endpoint && this.config.baseUrl && this.config.endpointPath) {
        const trimmedBase = this.config.baseUrl.replace(/\/+$/, "");
        this.config.endpoint = `${trimmedBase}${this.config.endpointPath}`;
      }

      this.initialize();
    }

    initialize() {
      if (this.config.reactForms) {
        this.setupReactListener();
      } else {
        this.bindEvents();
      }
      this.log("Initialized for React/Next.js");
    }

    setupReactListener() {
      // Listen for clicks anywhere in document
      document.addEventListener("click", (e) => {
        const btn = e.target.closest(".crm-capture-btn");
        if (btn) {
          e.preventDefault();
          const form = btn.closest("form");
          if (form) this.handleReactForm(form);
        }
      });

      // Alternative mutation observer for dynamic forms
      if (typeof MutationObserver !== "undefined") {
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1) {
                // Element node
                const forms = node.querySelectorAll
                  ? node.querySelectorAll("form")
                  : [];
                forms.forEach((form) => {
                  if (form.querySelector(".crm-capture-btn")) {
                    form.addEventListener("submit", (e) => {
                      e.preventDefault();
                      this.handleReactForm(form);
                    });
                  }
                });
              }
            });
          });
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
        });
      }
    }

    handleReactForm(form) {
      // Special handling for React forms
      const formData = new FormData(form);
      const data = {};

      formData.forEach((value, key) => {
        data[key] = value;
      });

      const leadData = this.prepareLeadData(data);
      if (this.validateLeadData(leadData)) {
        this.submitLead(leadData).then(() => {
          // Trigger React's state update if needed
          if (form._reactRootContainer) {
            const event = new Event("crmLeadSuccess");
            form.dispatchEvent(event);
          }
        });
      }
    }

    bindEvents() {
      // Handle form submissions
      document.addEventListener("submit", (e) => {
        const form = e.target;
        if (
          form.classList.contains(this.config.formClass) ||
          form.querySelector(".crm-capture-btn")
        ) {
          e.preventDefault();
          this.handleFormSubmit(form);
        }
      });

      // Handle button clicks
      document.addEventListener("click", (e) => {
        if (e.target.classList.contains(this.config.buttonClass)) {
          const form = this.findParentForm(e.target);
          if (form) {
            e.preventDefault();
            this.handleFormSubmit(form);
          }
        }
      });
    }

    findParentForm(element) {
      while (element && element.nodeName !== "FORM") {
        element = element.parentElement;
      }
      return element;
    }

    handleFormSubmit(form) {
      const formData = this.extractFormData(form);
      const leadData = this.prepareLeadData(formData);

      if (this.validateLeadData(leadData)) {
        this.submitLead(leadData);
      } else {
        this.log("Validation failed", "error");
      }
    }

    extractFormData(form) {
      const formData = {};
      const elements = form.elements;

      // Check for data-crm-field attributes first
      for (let element of elements) {
        if (element.hasAttribute("data-crm-field")) {
          const fieldName = element.getAttribute("data-crm-field");
          formData[fieldName] = this.sanitizeInput(element.value);
        }
      }

      // Fall back to default field mappings
      for (const [field, mapping] of Object.entries(
        this.config.fieldMappings
      )) {
        if (!formData[field]) {
          if (typeof mapping === "object" && mapping.combine) {
            const parts = mapping.combine.map((fieldName) => {
              const el = form.querySelector(
                `[name="${fieldName}"], #${fieldName}`
              );
              return el?.value?.trim() || "";
            });
            formData[field] = parts
              .filter(Boolean)
              .join(mapping.separator || " ");
          } else {
            const selectors = Array.isArray(mapping) ? mapping : [mapping];
            for (const selector of selectors) {
              const element = form.querySelector(
                `[name="${selector}"], #${selector}`
              );
              if (element && element.value) {
                formData[field] = this.sanitizeInput(element.value);
                break;
              }
            }
          }
        }
      }

      return formData;
    }

    sanitizeInput(value) {
      if (!value) return value;
      // Basic HTML stripping
      return value
        .toString()
        .replace(/<script.*?>.*?<\/script>/gi, "")
        .replace(/<\/?[^>]+(>|$)/g, "");
    }

    prepareLeadData(formData) {
      const leadData = {
        ...formData,
      };

      // Apply default values
      for (const [field, defaultValue] of Object.entries(
        this.config.defaultValues
      )) {
        if (!leadData[field]) {
          leadData[field] =
            typeof defaultValue === "function" ? defaultValue() : defaultValue;
        }
      }

      // Always set status, source and createdBy regardless of field mapping
      leadData.status = "New";
      leadData.source = "Website";
      leadData.createdBy = "snippet";

      // Default leadOwner
      if (!leadData.leadOwner) {
        leadData.leadOwner = "adeshyearanty";
      }

      // Format phone numbers if we have components
      if (!leadData.contactNumber && formData.phone) {
        leadData.contactNumber = this.extractPhoneNumber(formData.phone);
        leadData.contactCountryCode =
          this.extractCountryCode(formData.phone) || "+91";
      }

      return leadData;
    }

    extractPhoneNumber(phone) {
      // Extract just the digits
      const digits = phone.replace(/\D/g, "");
      // Return last 10 digits
      return digits.slice(-10);
    }

    extractCountryCode(phone) {
      // Match country code like +91 at start of string
      const match = phone.match(/^(\+\d{1,3})/);
      return match ? match[1] : null;
    }

    validateLeadData(leadData) {
      // Required fields validation
      if (!leadData.email) {
        this.log("Email is required", "error");
        return false;
      }

      if (!leadData.fullName) {
        this.log("Full name is required", "error");
        return false;
      }

      // Email format validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(leadData.email)) {
        this.log("Invalid email format", "error");
        return false;
      }

      // Phone number validation if provided
      if (leadData.contactNumber && !/^\d{10}$/.test(leadData.contactNumber)) {
        this.log("Contact number must be exactly 10 digits", "error");
        return false;
      }

      return true;
    }

    submitLead(leadData) {
      this.log("Submitting lead: ", leadData);

      const { site_id, api_token, ...payload } = leadData;

      const headers = {
        "Content-Type": "application/json",
        "x-api-key":
          this.config.apiToken || "09FwQAlQL37yaYMYBifrw9m8TkIWoK3228uELTc3",
      };

      // x-tenant-id is required for the public lead creation API
      if (this.config.tenantId) {
        headers["x-tenant-id"] = this.config.tenantId;
      }

      fetch(this.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
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
          this.log("Lead submitted successfully:", data);
          this.dispatchEvent("crmLeadSuccess", data);
          if (this.config.onSuccess) this.config.onSuccess(data);
        })
        .catch((error) => {
          this.log("Error submitting lead:", error, "error");
          this.dispatchEvent("crmLeadError", error);
          if (this.config.onError) this.config.onError(error);
        });
    }

    dispatchEvent(eventName, detail) {
      const event = new CustomEvent(eventName, { detail });
      document.dispatchEvent(event);
    }

    log(message, data, level = "log") {
      if (this.config.debug || level === "error") {
        console[level](`[Gamyam CRM] ${message}`, data || "");
      }
    }
  }

  // Expose to global scope
  window.CRMLeadCapture = CRMLeadCapture;

  // Auto-initialize if options are provided in data attributes or encrypted config
  document.addEventListener("DOMContentLoaded", () => {
    (async () => {
      // Prefer the current script tag; fall back to matching by src
      const scriptEl =
        document.currentScript ||
        document.querySelector('script[src*="crm-capture-dynamic.js"]');
      if (!scriptEl) return;

      // Base options from data-* attributes
      const baseOptions = {
        // Allow passing either a full endpoint or base URL + endpoint path
        endpoint: scriptEl.getAttribute("data-crm-endpoint") || null,
        baseUrl:
          scriptEl.getAttribute("data-crm-base-url") || defaults.baseUrl,
        endpointPath:
          scriptEl.getAttribute("data-crm-endpoint-path") ||
          defaults.endpointPath,
        apiToken:
          scriptEl.getAttribute("data-crm-api-token") || defaults.apiToken,
        tenantId: scriptEl.getAttribute("data-crm-tenant-id") || "",
        debug: scriptEl.hasAttribute("data-crm-debug"),
        buttonClass:
          scriptEl.getAttribute("data-crm-button-class") ||
          defaults.buttonClass,
        formClass:
          scriptEl.getAttribute("data-crm-form-class") || "crm-capture-form", // fallback
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
        } catch (e) {
          console.error("[Gamyam CRM] Invalid JSON in data-crm-field-mappings");
        }
      }

      let finalOptions = { ...baseOptions };

      // If an encrypted config is present (UniBox-style), decrypt and merge
      try {
        const globalCfg =
          window.UniBoxEmbedConfig || window.CRMLeadCaptureConfig || null;
        const encryptedConfig = globalCfg?.encryptedConfig;

        if (encryptedConfig) {
          const decrypted = await decryptConfig(
            encryptedConfig,
            ENCRYPTION_PASSPHRASE
          );
          // Decrypted values override baseOptions, but data-* can still act as fallback
          finalOptions = { ...baseOptions, ...decrypted };
        } else if (globalCfg && typeof globalCfg === "object") {
          // Allow passing plain config via global as well
          const { encryptedConfig: _ignored, ...plain } = globalCfg;
          finalOptions = { ...baseOptions, ...plain };
        }
      } catch (e) {
        console.error("[Gamyam CRM] Failed to decrypt config", e);
      }

      new CRMLeadCapture(finalOptions);
    })();
  });
})();

if (typeof window !== "undefined") {
  window.CRMLeadCapture = CRMLeadCapture;
}

// ✅ Add export for test
if (typeof module !== "undefined") {
  module.exports = CRMLeadCapture;
}
