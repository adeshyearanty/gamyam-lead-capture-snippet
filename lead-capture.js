/**
 * Universal Lead Capture Script
 *
 * This script listens for form submissions, collects data from fields
 * marked with a 'data-crm-field' attribute, and sends it to a
 * specified API endpoint.
 *
 * @version 1.0.0
 * @author Your Name
 */
(() => {
  // Wait for the DOM to be fully loaded before running the script
  document.addEventListener('DOMContentLoaded', () => {
    const scriptTag = document.currentScript;
    if (!scriptTag) {
      console.error("Lead Capture: Cannot find the script tag. The 'defer' attribute might be needed.");
      return;
    }

    const apiEndpoint = scriptTag.dataset.endpoint;
    if (!apiEndpoint) {
      console.error('Lead Capture: The "data-endpoint" attribute is missing on the script tag.');
      return;
    }

    /**
     * Sends the collected lead data to the configured CRM endpoint.
     * @param {object} data - The lead data to send.
     */
    const sendDataToCRM = async (data) => {
      try {
        const response = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
          // keepalive ensures the request is sent even if the page unloads
          keepalive: true,
        });

        if (!response.ok) {
          console.error('Lead Capture: API Error:', response.status, await response.text());
        } else {
          console.log('Lead Capture: Lead successfully sent to CRM.');
        }
      } catch (error) {
        console.error('Lead Capture: Failed to send lead data.', error);
      }
    };

    /**
     * Listens for form submissions globally using event delegation.
     */
    document.addEventListener('submit', (event) => {
      const form = event.target;
      const leadData = {};
      let hasCrmFields = false;

      // Use FormData to correctly handle all input types, including files and selects
      const formData = new FormData(form);
      
      // Map form elements based on the 'data-crm-field' attribute
      for (const element of form.elements) {
        const crmField = element.dataset.crmField;
        const name = element.getAttribute('name');

        if (crmField && name) {
          hasCrmFields = true;
          // FormData.getAll() correctly handles multiple values for the same name (e.g., checkboxes)
          const values = formData.getAll(name);
          
          if (values.length > 1) {
            leadData[crmField] = values;
          } else if (values.length === 1) {
            leadData[crmField] = values[0];
          }
        }
      }

      // Only send data if there were mapped fields and data was collected
      if (hasCrmFields && Object.keys(leadData).length > 0) {
        console.log('Lead Capture: Capturing data...', leadData);
        sendDataToCRM(leadData);
      }
      // We do NOT call event.preventDefault(), allowing the form to submit normally.
    });

    console.log('Lead Capture: Script initialized and listening for form submissions.');
  });
})();
