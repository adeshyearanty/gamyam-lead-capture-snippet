/**
 * Universal Lead Capture Script - v3
 *
 * Captures data from forms with a 'data-capture-lead' attribute.
 * Uses default values for 'leadOwner' and 'source' only if not provided in the form.
 *
 * @version 3.0.0
 */
(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const scriptTag = document.currentScript;
    if (!scriptTag) {
      console.error("Lead Capture: Cannot find the script tag. Please add the 'defer' attribute.");
      return;
    }
    
    const apiEndpoint = scriptTag.dataset.endpoint;
    const apiKey = scriptTag.dataset.apiKey;

    if (!apiEndpoint || !apiKey) {
      console.error('Lead Capture: "data-endpoint" or "data-api-key" is missing on the script tag.');
      return;
    }

    /**
     * Sends the collected lead data to the configured CRM endpoint.
     * @param {object} data - The lead data collected from the form.
     */
    const sendDataToCRM = async (data) => {
      // Define the default values
      const defaults = {
        leadOwner: "adeshyearanty",
        source: "Website form",
        status: "New",
      };

      // Create the payload by merging the form data over the defaults.
      // If 'data' has a 'source' or 'leadOwner' property, it will overwrite the default.
      const payload = { ...defaults, ...data };

      try {
        const response = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify(payload),
          keepalive: true,
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => response.text());
          console.error('Lead Capture: API Error:', response.status, errorBody);
        } else {
          console.log('Lead Capture: Lead successfully sent to CRM.');
        }
      } catch (error) {
        console.error('Lead Capture: Failed to send lead data.', error);
      }
    };

    /**
     * Listens for form submissions and processes those marked for capture.
     */
    document.addEventListener('submit', (event) => {
      if (!event.target.hasAttribute('data-capture-lead')) {
        return;
      }

      const form = event.target;
      const leadData = {};
      const formData = new FormData(form);

      for (const element of form.elements) {
        const crmField = element.dataset.crmField;
        const name = element.getAttribute('name');

        if (crmField && name) {
          const value = formData.get(name);
          if (value !== null && value !== '') {
            leadData[crmField] = value;
          }
        }
      }
      
      if (Object.keys(leadData).length > 0) {
        console.log('Lead Capture: Capturing data...', leadData);
        sendDataToCRM(leadData);
      }
    });

    console.log('Lead Capture: Script initialized.');
  });
})();
