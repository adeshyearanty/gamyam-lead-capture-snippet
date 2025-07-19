/**
 * Universal Lead Capture Snippet - v4.1 (Standalone)
 *
 * A powerful, framework-agnostic script for capturing lead data.
 * - Intelligently maps fields using a comprehensive mapping object.
 * - Provides detailed console logging for API success and error responses.
 * - Configured entirely through data attributes on the script tag.
 *
 * @version 4.1.0
 */
(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const scriptTag = document.currentScript;
    if (!scriptTag) {
      console.error("[Lead Capture] Cannot find the script tag. Please ensure the 'defer' attribute is used.");
      return;
    }

    // --- CONFIGURATION (from script tag data attributes) ---
    const config = {
      apiEndpoint: scriptTag.dataset.endpoint,
      apiKey: scriptTag.dataset.apiKey,
      debug: scriptTag.hasAttribute('data-debug'),
    };
    
    // --- COMPREHENSIVE FIELD MAPPINGS ---
    const fieldMappings = {
      leadOwner: ["leadOwner", "owner"],
      fullName: ["fullName", "name", "full_name"],
      salutation: ["salutation", "title"],
      email: ["email", "email_address"],
      website: ["website", "url", "site"],
      contactCountryCode: ["contactCountryCode", "countryCode", "phoneCode"],
      contactNumber: ["contactNumber", "phone", "mobile", "telephone"],
      contactExtension: ["contactExtension", "ext", "phoneExt"],
      alternateCountryCode: ["alternateCountryCode", "altCountryCode"],
      alternateNumber: ["alternateNumber", "altPhone", "altMobile"],
      alternateExtension: ["alternateExtension", "altExt"],
      companyName: ["companyName", "company", "organization"],
      designation: ["designation", "jobTitle", "title", "position"],
      companySize: ["companySize", "employees", "size"],
      industryType: ["industryType", "industry"],
      status: ["status", "leadStatus"],
      source: ["source", "leadSource", "origin"],
      score: ["score", "leadScore"],
      scoreTrend: ["scoreTrend", "trend"],
      preferredChannel: ["preferredChannel", "contactMethod"],
      lastActivityDate: ["lastActivityDate", "lastContacted"],
      description: ["description", "notes", "message", "comments"],
      linkedinUrl: ["linkedinUrl", "linkedin"],
      twitterUrl: ["twitterUrl", "twitter", "xProfile"],
      annualRevenue: ["annualRevenue", "revenue"],
      nextStage: ["nextStage", "pipelineStage"]
    };

    if (!config.apiEndpoint || !config.apiKey) {
      console.error('[Lead Capture] "data-endpoint" or "data-api-key" attribute is missing on the script tag.');
      return;
    }

    const log = (message, data = '', level = 'log') => {
      if (config.debug || level === 'error') {
        const style = level === 'error' ? 'color: red; font-weight: bold;' : 'color: blue; font-weight: bold;';
        console[level](`%c[Lead Capture] ${message}`, style, data);
      }
    };
    
    const sendDataToCRM = async (data) => {
      const defaults = {
        leadOwner: "adeshyearanty",
        source: "Website",
        status: "New",
        createdDate: new Date().toISOString(),
      };
      const payload = { ...defaults, ...data };
      log('Submitting payload:', payload);

      try {
        const response = await fetch(config.apiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey },
          body: JSON.stringify(payload),
          keepalive: true,
        });
        const responseBody = await response.json().catch(() => ({ message: "Could not parse API response." }));

        if (!response.ok) {
          console.group(`[Lead Capture] API Error: ${response.status} (${responseBody.error || 'Bad Request'})`);
          log('Submission failed. See validation errors below.', '', 'error');
          if (Array.isArray(responseBody.message)) {
            responseBody.message.forEach(msg => console.error('->', msg));
          } else {
            console.error('->', responseBody.message);
          }
          console.groupEnd();
        } else {
          console.groupCollapsed(`[Lead Capture] Success: ${responseBody.message || 'Lead created!'}`);
          log('API returned data:', responseBody.data);
          console.groupEnd();
        }
      } catch (error) {
        log('A critical network or script error occurred.', error, 'error');
      }
    };

    document.addEventListener('submit', (event) => {
      if (!event.target.hasAttribute('data-capture-lead')) return;
      
      const form = event.target;
      const leadData = {};
      
      // 1. Prioritize explicit `data-crm-field` attributes
      for (const element of form.elements) {
        if (element.dataset.crmField) {
           const value = element.value.trim();
           if (value) leadData[element.dataset.crmField] = value;
        }
      }

      // 2. Fallback to searching by name/id using `fieldMappings`
      for (const [crmField, possibleNames] of Object.entries(fieldMappings)) {
        if (!leadData.hasOwnProperty(crmField)) {
          for (const name of possibleNames) {
            const element = form.querySelector(`[name="${name}"], #${name}`);
            if (element && element.value) {
              const value = element.value.trim();
              if (value) {
                 leadData[crmField] = value;
                 break; // Found it, move to the next crmField
              }
            }
          }
        }
      }

      if (Object.keys(leadData).length > 0) {
        log('Captured form data:', leadData);
        sendDataToCRM(leadData);
      } else {
        log('No mappable data found in the form.', '', 'error');
      }
    });
    log('Script initialized.');
  });
})();
