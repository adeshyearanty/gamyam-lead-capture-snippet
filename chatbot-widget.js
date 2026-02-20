(function () {
  // --- 1. CONFIGURATION ---
  // Support both new encrypted method (window.UniBoxEmbedConfig) and legacy method (window.UniBoxSettings)

  let userConfig = null;

  // Check for new encrypted embed config
  if (window.UniBoxEmbedConfig) {
    try {
      const embedConfig = window.UniBoxEmbedConfig;
      const encryptedConfig = embedConfig.encryptedConfig;

      if (!encryptedConfig) {
        console.error("UniBox: Missing encryptedConfig in embed config.");
        return;
      }

      // Decrypt config using the same fixed key used for encryption
      function decryptConfig(encryptedData, key) {
        try {
          // Decode from base64
          const decoded = atob(encryptedData);
          // XOR decrypt
          let decrypted = "";
          for (let i = 0; i < decoded.length; i++) {
            const keyChar = key[i % key.length];
            decrypted += String.fromCharCode(
              decoded.charCodeAt(i) ^ keyChar.charCodeAt(0),
            );
          }
          // Decode from base64 to UTF-8 string
          const jsonString = decodeURIComponent(escape(atob(decrypted)));
          return JSON.parse(jsonString);
        } catch (e) {
          console.error("UniBox: Failed to decrypt config", e);
          return null;
        }
      }

      // Use the same encryption key (must match the one used in script generator)
      const encryptionKey = "unibox-widget-encryption-key-2024";
      const decryptedConfig = decryptConfig(encryptedConfig, encryptionKey);

      if (decryptedConfig) {
        userConfig = decryptedConfig;
      } else {
        console.error("UniBox: Failed to decrypt config.");
        return;
      }
    } catch (e) {
      console.error("UniBox: Error processing embed config", e);
      return;
    }
  }
  // Fall back to legacy method
  else if (window.UniBoxSettings) {
    userConfig = window.UniBoxSettings;
  } else {
    console.error(
      "UniBox: Settings missing. Please configure window.UniBoxEmbedConfig or window.UniBoxSettings.",
    );
    return;
  }

  const requiredFields = ["tenantId", "widgetToken", "chatbotId"];
  const missingFields = requiredFields.filter((field) => !userConfig[field]);

  if (missingFields.length > 0) {
    console.error(
      `UniBox: Missing required fields: ${missingFields.join(", ")}`,
    );
    return;
  }

  // Get base URL - support both apiBaseUrl and baseUrl
  const baseUrl =
    userConfig.apiBaseUrl ||
    userConfig.baseUrl ||
    "https://dev-api.salesastra.ai/pulse/v1/chat";

  // Storage Keys (using tenantId from userConfig)
  const SESSION_KEY_FORM = `unibox_form_submitted_${userConfig.tenantId}`;
  const STORAGE_KEY_OPEN = `unibox_open_${userConfig.tenantId}`;
  const STORAGE_KEY_USER = `unibox_guest_${userConfig.tenantId}`;

  // API URLs - will be set after we get the full config
  let API_BASE = baseUrl;
  let API_S3_URL = "";
  let UTILITY_API_BASE = "";
  let UTILITY_S3_URL = "";
  let SOCKET_CONFIG = { namespaceUrl: "", path: "" };
  let WS_URL = ""; // WebSocket URL for new WebSocket service
  let wsToken = null; // JWT token for WebSocket authentication

  // Utility service URL for media (separate from logo S3)
  // Construct utility base URL from API_BASE host -> /utilities/v1/s3
  // This matches the backend S3 client (`S3_CLIENT_URL`)
  function getUtilityBaseUrl() {
    try {
      const urlObj = new URL(API_BASE);
      // Always point to the shared utilities service (independent of /pulse path)
      return `${urlObj.protocol}//${urlObj.host}/utilities/v1/s3`;
    } catch (e) {
      // Fallback if URL parsing fails (dev default)
      return "https://dev-api.salesastra.ai/utilities/v1/s3";
    }
  }

  // Get WebSocket URL from config or construct from API base
  function getWebSocketUrl() {
    try {
      // Check if websocketUrl is provided in fetched config (passed from embed script)
      if (fetchedConfig && fetchedConfig.websocketUrl) {
        console.log(
          "UniBox: Using WebSocket URL from config:",
          fetchedConfig.websocketUrl,
        );
        return fetchedConfig.websocketUrl;
      }

      // Fallback: construct from API_BASE (not recommended, use config)
      console.warn(
        "UniBox: websocketUrl not found in config, constructing from API_BASE",
      );
      const urlObj = new URL(API_BASE);
      // Convert https:// to wss:// and http:// to ws://
      const wsProtocol = urlObj.protocol === "https:" ? "wss:" : "ws:";
      // WebSocket service endpoint
      const constructedUrl = `${wsProtocol}//${urlObj.host}/ws`;
      console.log("UniBox: Constructed WebSocket URL:", constructedUrl);
      return constructedUrl;
    } catch (e) {
      console.error("UniBox: Failed to construct WebSocket URL", e);
      return null;
    }
  }

  // Socket Config Helper
  function getSocketConfig(apiBase) {
    try {
      const urlObj = new URL(apiBase);
      const basePath = urlObj.pathname.replace(/\/chat\/?$/, "");
      return {
        namespaceUrl: `${urlObj.protocol}//${urlObj.host}${basePath}/events`,
        path: `${basePath}/socket.io/`,
      };
    } catch (e) {
      console.error("UniBox: Invalid API URL", e);
      return { namespaceUrl: "", path: "" };
    }
  }

  // Get Config API URL
  function getConfigApiUrl() {
    try {
      const urlObj = new URL(baseUrl);
      let configPath;

      // If pathname contains /pulse/v1/chat, replace it with /pulse/v1/public/chatbot/config
      if (urlObj.pathname.match(/\/pulse\/v1\/chat/)) {
        configPath = urlObj.pathname.replace(
          /\/pulse\/v1\/chat\/?$/,
          "/pulse/v1/public/chatbot/config",
        );
      } else {
        // Otherwise, construct the full path
        configPath = "/pulse/v1/public/chatbot/config";
      }

      const configUrl = `${urlObj.protocol}//${urlObj.host}${configPath}`;
      // Add chatbotId as query parameter
      const urlWithParams = new URL(configUrl);
      urlWithParams.searchParams.set("chatbotId", userConfig.chatbotId);
      return urlWithParams.toString();
    } catch (e) {
      // Fallback if URL parsing fails
      const fallbackUrl =
        baseUrl.replace(
          /\/pulse\/v1\/chat\/?$/,
          "/pulse/v1/public/chatbot/config",
        ) || "https://dev-api.salesastra.ai/pulse/v1/public/chatbot/config";
      return `${fallbackUrl}?chatbotId=${encodeURIComponent(
        userConfig.chatbotId,
      )}`;
    }
  }

  const defaults = {
    tenantId: "",
    apiKey: "",
    widgetToken: "",
    testMode: false,
    appearance: {
      gradientColor1: "#912FF5",
      gradientColor2: "#EF32D4",
      gradientColor3: "#7DBCFE",
      fontFamily: "Inter, sans-serif",
      iconStyle: "rounded",
      logoUrl: "",
      header: {
        title: "Support",
        welcomeMessage: "Hi there! How can we help?",
        offlineMessage: "We are currently offline.",
      },
      headerName: "Support",
      welcomeMessage: "Hi there! How can we help?",
      chatToggleIcon: {
        style: "rounded",
      },
    },
    behavior: {
      botDelayMs: 600,
      typingIndicator: true,
      autoOpen: false,
      autoOpenDelay: 2000,
      stickyPlacement: "bottom-right",
    },
    preChatForm: {
      enabled: false,
      fields: [],
    },
  };

  // Settings will be initialized after fetching config
  let settings = null;

  // --- 2. STATE ---
  let conversationId = null;
  let socket = null;
  let userId = localStorage.getItem(STORAGE_KEY_USER);
  let resolvedLogoUrl = "";
  let messages = new Map();
  let isAgentOnline = false;
  let staticWelcomeShown = false;
  let realWelcomeMessageId = null; // Track the real welcome message ID once it replaces static welcome
  let typingTimeout = null;
  let isTyping = false;
  let agentTyping = false;
  let agentTypingTimeout = null; // Timeout for hiding agent typing indicator
  let previewMedia = null; // { url, filename, type, mediaKey } - for viewing received media
  let previewFile = null; // @deprecated - Not used. Was for single file upload preview modal.
  let selectedFiles = []; // Array of { file, previewUrl, mediaType, fileName } - ACTIVE file upload flow (shows as chips)
  let fetchedConfig = null; // Store fetched config for WebSocket URL
  let wsConnectPromise = null; // Promise that resolves when WebSocket is connected
  let wsConnectResolve = null; // Resolver for the connection promise
  let pendingMessages = []; // Queue of messages to send when connection is ready
  let isConnecting = false; // Flag to prevent concurrent connection attempts

  // --- HELPER: Safe WebSocket Send ---
  /**
   * Safely send a message via WebSocket, only if connection is open
   * If not connected, queues the message for later
   * @param {Object} data - Data to send
   * @param {boolean} queue - If true, queue message if not connected (default: false)
   * @returns {boolean} - true if sent, false if queued or failed
   */
  function wsSend(data, queue = false) {
    if (!socket) {
      if (queue) {
        console.log("UniBox: WebSocket not initialized, queuing message");
        pendingMessages.push(data);
        return false;
      }
      console.warn("UniBox: Cannot send - WebSocket not initialized");
      return false;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      if (queue) {
        console.log("UniBox: WebSocket not open, queuing message");
        pendingMessages.push(data);
        return false;
      }
      console.warn(
        "UniBox: Cannot send - WebSocket not open, readyState:",
        socket.readyState,
      );
      return false;
    }
    try {
      socket.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("UniBox: Failed to send WebSocket message:", error);
      return false;
    }
  }

  /**
   * Wait for WebSocket to be connected
   * @param {number} timeout - Max time to wait in ms (default: 5000)
   * @returns {Promise<boolean>} - true if connected, false if timeout
   */
  async function waitForWsConnection(timeout = 5000) {
    // Already connected
    if (socket && socket.readyState === WebSocket.OPEN) {
      return true;
    }

    // Connection in progress, wait for it
    if (wsConnectPromise) {
      try {
        await Promise.race([
          wsConnectPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), timeout),
          ),
        ]);
        return socket && socket.readyState === WebSocket.OPEN;
      } catch (e) {
        return false;
      }
    }

    // No connection in progress
    return false;
  }

  /**
   * Flush pending messages after connection is established
   */
  function flushPendingMessages() {
    if (pendingMessages.length === 0) return;

    console.log("UniBox: Flushing", pendingMessages.length, "pending messages");
    const messages = [...pendingMessages];
    pendingMessages = [];

    messages.forEach((data) => {
      wsSend(data);
    });
  }

  /**
   * Subscribe to a conversation via WebSocket
   * Only subscribes if we have a valid conversationId and socket is open
   */
  // Track if we've subscribed to avoid duplicate subscriptions
  let subscribedConversationId = null;

  function subscribeToConversation(convId) {
    if (!convId || convId.startsWith("guest_") || convId.startsWith("user_")) {
      console.log("UniBox: Invalid conversationId for subscription:", convId);
      return false;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.log(
        "UniBox: Socket not open, cannot subscribe. State:",
        socket?.readyState,
      );
      return false;
    }

    // Avoid duplicate subscriptions
    if (subscribedConversationId === convId) {
      console.log("UniBox: Already subscribed to conversation:", convId);
      return true;
    }

    console.log("UniBox: Subscribing to conversation:", convId);
    socket.send(
      JSON.stringify({
        action: "subscribe",
        conversationId: convId,
      }),
    );
    subscribedConversationId = convId;
    return true;
  }

  // --- 3. HELPER: HEADERS ---
  function getHeaders() {
    if (!settings) {
      console.error("UniBox: Settings not initialized");
      return {
        "Content-Type": "application/json",
        "x-tenant-id": userConfig.tenantId,
        "x-api-key": userConfig.apiKey || userConfig.widgetToken, // General API key
        "x-chatbot-token": userConfig.widgetToken, // Widget-specific token
      };
    }
    return {
      "Content-Type": "application/json",
      "x-tenant-id": settings.tenantId,
      "x-api-key": settings.apiKey || settings.widgetToken, // General API key
      "x-chatbot-token": settings.widgetToken, // Widget-specific token
    };
  }

  // --- 4. HELPER: UI LOADING STATE ---
  function setLoading(isLoading) {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    if (isLoading) {
      body.innerHTML = `
        <div class="chat-widget-loader">
          <div class="chat-widget-loader-spinner"></div>
        </div>
      `;
    } else {
      const loader = body.querySelector(".chat-widget-loader");
      if (loader) loader.remove();
    }
  }

  // --- 5. DEPENDENCY LOADER ---
  function loadSocketScript(callback) {
    if (window.io) {
      callback();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://cdn.socket.io/4.7.4/socket.io.min.js";
    script.onload = callback;
    document.head.appendChild(script);
  }

  // --- 6. FETCH CONFIG FROM API ---
  /**
   * Fetch widget configuration from the API
   * @returns {Promise<Object>} - The fetched configuration
   */
  async function fetchWidgetConfig() {
    const configApiUrl = getConfigApiUrl();
    const origin = window.location.origin;
    const referer = window.location.href;

    try {
      const response = await fetch(configApiUrl, {
        method: "GET",
        headers: {
          "x-api-key": userConfig.apiKey || userConfig.widgetToken, // General API key, fallback to widgetToken
          "x-chatbot-token": userConfig.widgetToken, // Widget-specific token
          "x-tenant-id": userConfig.tenantId,
          origin: origin,
          referer: referer,
        },
      });

      if (!response.ok) {
        let errorBody = null;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = { message: await response.text() };
        }
        const msg = errorBody?.message || "";
        const statusCode = response.status;

        if (statusCode === 403 && msg.includes("domain is not authorized")) {
          console.warn("UniBox: This domain is not authorized to load the chatbot widget.");
          return null;
        }
        if (statusCode === 404) {
          if (msg.includes("Chatbot is not active") || msg.includes("Chatbot not found")) {
            console.warn("UniBox:", msg);
            return null;
          }
        }

        throw new Error(
          `Failed to fetch config: ${statusCode} - ${msg}`,
        );
      }

      const apiConfig = await response.json();

      // Transform API response to match widget structure
      const transformedConfig = {
        tenantId: userConfig.tenantId,
        widgetToken: userConfig.widgetToken,
        apiKey: userConfig.apiKey || userConfig.widgetToken, // Use apiKey if provided, otherwise fallback to widgetToken
        testMode: userConfig.testMode || false,
        // Preserve websocketUrl from userConfig (passed from embed script)
        websocketUrl: userConfig.websocketUrl,
        appearance: apiConfig.widgetAppearance || defaults.appearance,
        behavior: {
          ...defaults.behavior,
          ...(apiConfig.widgetBehavior || {}),
          // Preserve autoOpen and autoOpenDelay from defaults if not in API response
          autoOpen:
            apiConfig.widgetBehavior?.autoOpen ?? defaults.behavior.autoOpen,
          autoOpenDelay:
            apiConfig.widgetBehavior?.autoOpenDelay ??
            defaults.behavior.autoOpenDelay,
        },
        preChatForm: apiConfig.preChatForm || defaults.preChatForm,
        // Store additional config that might be useful
        botFlow: apiConfig.botFlow,
        defaultLanguage: apiConfig.defaultLanguage,
        timezone: apiConfig.timezone,
      };

      return transformedConfig;
    } catch (error) {
      console.error("UniBox: Failed to fetch widget configuration:", error);
      // Fallback to defaults with user-provided minimal config
      return deepMerge(defaults, {
        tenantId: userConfig.tenantId,
        widgetToken: userConfig.widgetToken,
        apiKey: userConfig.apiKey || userConfig.widgetToken, // Use apiKey if provided, otherwise fallback to widgetToken
        chatbotId: userConfig.chatbotId,
        testMode: userConfig.testMode || false,
        // Preserve websocketUrl from userConfig (passed from embed script)
        websocketUrl: userConfig.websocketUrl,
      });
    }
  }

  // --- 7. INITIALIZATION ---
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  async function init() {
    try {
      // Fetch configuration from API
      fetchedConfig = await fetchWidgetConfig();

      if (fetchedConfig === null) {
        return;
      }

      // Merge fetched config with defaults
      settings = deepMerge(defaults, fetchedConfig);

      // Now initialize API URLs and socket config with the baseUrl
      API_BASE = baseUrl;
      API_S3_URL = API_BASE.replace(/\/chat\/?$/, "/s3/generate-access-url");

      // Use utilityApiBaseUrl from config if provided, otherwise construct it
      // utilityApiBaseUrl should be like: https://dev-api.salesastra.ai/utilities/v1/s3
      if (fetchedConfig && fetchedConfig.utilityApiBaseUrl) {
        UTILITY_API_BASE = fetchedConfig.utilityApiBaseUrl;
        console.log(
          "UniBox: Using utility API URL from config:",
          UTILITY_API_BASE,
        );
      } else if (userConfig.utilityApiBaseUrl) {
        UTILITY_API_BASE = userConfig.utilityApiBaseUrl;
        console.log(
          "UniBox: Using utility API URL from userConfig:",
          UTILITY_API_BASE,
        );
      } else {
        // Fallback: construct from API_BASE
        UTILITY_API_BASE = getUtilityBaseUrl();
      }
      UTILITY_S3_URL = `${UTILITY_API_BASE}/generate-access-url`;

      SOCKET_CONFIG = getSocketConfig(API_BASE);
      WS_URL = getWebSocketUrl();

      loadGoogleFont(settings.appearance.fontFamily);

      if (settings.appearance.logoUrl) {
        try {
          resolvedLogoUrl = await fetchLogoUrl(settings.appearance.logoUrl);
        } catch (err) {
          console.warn("UniBox: Failed to load logo", err);
        }
      }

      renderWidget();

      if (settings.testMode) {
        console.warn("UniBox: Running in TEST MODE.");
      }

      loadSocketScript(() => {
        if (userId) {
          const hasSubmittedForm =
            sessionStorage.getItem(SESSION_KEY_FORM) === "true";
          if (!settings.preChatForm.enabled || hasSubmittedForm) {
            restoreExistingConversation();
          }
        }
      });
    } catch (error) {
      console.error("UniBox: Initialization failed:", error);
    }
  }

  // --- 8. S3 LOGIC ---

  /**
   * Fetch signed URL for logo/images (uses pulse service endpoint)
   * @param {string} fileName - The S3 key or file name
   * @returns {Promise<string>} - The presigned URL
   */
  async function fetchLogoUrl(fileName) {
    if (fileName.startsWith("http")) return fileName;
    try {
      const res = await fetch(API_S3_URL, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ fileName: fileName }),
      });
      if (!res.ok) throw new Error("S3 Sign failed");
      const data = await res.text();
      try {
        return JSON.parse(data).url || JSON.parse(data).signedUrl || data;
      } catch (e) {
        return data;
      }
    } catch (error) {
      return "";
    }
  }

  /**
   * Fetch signed URL for media files (uses utility service endpoint)
   * @param {string} key - The S3 key
   * @returns {Promise<string | null>} - The presigned URL or null if error
   */
  async function fetchMediaUrl(key) {
    if (!key) return null;

    // If a full URL is passed, return it as-is
    if (key.startsWith("http://") || key.startsWith("https://")) {
      return key;
    }

    try {
      const res = await fetch(UTILITY_S3_URL, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ key: key }),
      });

      if (!res.ok) {
        throw new Error("Failed to get media URL");
      }

      const data = await res.text();

      // Response is plain text (the presigned URL)
      const url = typeof data === "string" ? data : String(data);

      // Validate that the response is a valid URL
      if (!url.startsWith("http")) {
        throw new Error("Invalid URL format returned from server");
      }

      return url;
    } catch (error) {
      console.error("UniBox: Error getting media access URL:", error);
      return null;
    }
  }

  // Legacy function for backward compatibility
  async function fetchSignedUrl(fileName) {
    return fetchLogoUrl(fileName);
  }

  // --- 9. API & SOCKET LOGIC ---

  async function restoreExistingConversation() {
    if (conversationId || !userId) return;
    setLoading(true);
    try {
      const restoreRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
        method: "GET",
        headers: getHeaders(),
      });

      if (restoreRes.ok) {
        const data = await restoreRes.json();
        if (data.conversation) {
          conversationId = data.conversation.id;
          setLoading(false);

          if (data.messages && Array.isArray(data.messages)) {
            if (staticWelcomeShown) {
              const staticWelcome = Array.from(messages.values()).find(
                (msg) => msg.id && msg.id.startsWith("static_welcome_"),
              );
              if (staticWelcome && staticWelcome.element) {
                staticWelcome.element.remove();
                messages.delete(staticWelcome.id);
              }
              staticWelcomeShown = false;
            }

            data.messages.forEach((msg) => {
              // Normalize text - convert empty string to null
              const textValue = msg.text || msg.text_body;
              const normalizedTextValue =
                textValue && textValue.trim() ? textValue.trim() : null;

              const canonicalTimestamp =
                // Prefer canonical millisecond timestamp if present
                (typeof msg.timestamp === "number" && msg.timestamp) ||
                // Then prefer ISO timestamp string if available
                (msg.timestamp_iso
                  ? msg.timestamp_iso
                  : // Fallback: derive from legacy seconds-based field
                    typeof msg.timestamp_meta === "number"
                    ? msg.timestamp_meta * 1000
                    : undefined);

              appendMessageToUI(
                normalizedTextValue,
                msg.sender || (msg.direction === "inbound" ? "user" : "agent"),
                msg.id || msg.messageId,
                canonicalTimestamp,
                msg.status,
                msg.readAt,
                msg.readByUs,
                msg.readByUsAt,
                msg.type,
                msg.media_storage_url,
              );
            });
            setTimeout(() => {
              sortMessagesByTimestamp();
              markVisibleMessagesAsRead();
            }, 500);
          }
          // Connect to WebSocket AND subscribe to conversation for real-time updates
          connectSocket().then(() => {
            // Subscribe after connection is established
            subscribeToConversation(conversationId);
          });
        } else {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    } catch (e) {
      setLoading(false);
    }
  }

  async function initializeConversation(showLoading = false) {
    if (conversationId) return;

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.name = storedName;
      if (storedEmail) userDetails.email = storedEmail;
    }

    if (showLoading) {
      setLoading(true);
    }

    try {
      if (!settings.testMode) {
        try {
          const restoreRes = await fetch(
            `${API_BASE}/thread/${userId}?limit=50`,
            {
              method: "GET",
              headers: getHeaders(),
            },
          );
          if (restoreRes.ok) {
            const data = await restoreRes.json();
            if (data.conversation) {
              conversationId = data.conversation.id;
              if (showLoading) {
                setLoading(false);
              }

              // Remove static welcome message before loading real messages
              if (staticWelcomeShown) {
                const staticWelcome = Array.from(messages.values()).find(
                  (msg) => msg.id && msg.id.startsWith("static_welcome_"),
                );
                if (staticWelcome && staticWelcome.element) {
                  staticWelcome.element.remove();
                  messages.delete(staticWelcome.id);
                }
                staticWelcomeShown = false;
              }

              if (data.messages && Array.isArray(data.messages)) {
                data.messages.forEach((msg) => {
                  // Normalize text - convert empty string to null
                  const textValue = msg.text || msg.text_body;
                  const normalizedTextValue =
                    textValue && textValue.trim() ? textValue.trim() : null;

                  const canonicalTimestamp =
                    (typeof msg.timestamp === "number" && msg.timestamp) ||
                    (msg.timestamp_iso
                      ? msg.timestamp_iso
                      : typeof msg.timestamp_meta === "number"
                        ? msg.timestamp_meta * 1000
                        : undefined);

                  appendMessageToUI(
                    normalizedTextValue,
                    msg.sender ||
                      (msg.direction === "inbound" ? "user" : "agent"),
                    msg.id || msg.messageId,
                    canonicalTimestamp,
                    msg.status,
                    msg.readAt,
                    msg.readByUs,
                    msg.readByUsAt,
                    msg.type,
                    msg.media_storage_url,
                  );
                });
                markVisibleMessagesAsRead();
              }
              // Connect to WebSocket AND subscribe for real-time updates
              connectSocket().then(() => {
                subscribeToConversation(conversationId);
              });
              return;
            }
          }
        } catch (e) {}
      }

      const res = await fetch(`${API_BASE}/conversation`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          userId: userId,
          userName: userDetails.name || "Guest User",
          userEmail: userDetails.email || "",
          testMode: settings.testMode,
        }),
      });

      if (!res.ok) throw new Error("Failed to start conversation");
      const data = await res.json();
      conversationId = data.conversationId;
      console.log("UniBox: Conversation created:", conversationId);

      // Connect to WebSocket and subscribe
      await connectSocket();
      subscribeToConversation(conversationId);

      // Don't fetch thread here - it will be fetched by fetchAndRenderThreadAfterSend
      if (showLoading) {
        setLoading(false);
      }
    } catch (error) {
      console.error("UniBox: Init Error", error);
      if (showLoading) {
        setLoading(false);
      }
    }
  }

  /**
   * Get JWT token for WebSocket authentication
   */
  async function getWebSocketToken() {
    try {
      const res = await fetch(`${API_BASE}/websocket/token`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          userId: userId,
          conversationId: conversationId,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to get WebSocket token");
      }

      const data = await res.json();
      return data.token;
    } catch (error) {
      console.error("UniBox: Failed to get WebSocket token", error);
      return null;
    }
  }

  /**
   * Connect to WebSocket service (replaces Socket.IO)
   * @returns {Promise<boolean>} - Resolves to true when connected, false on failure
   */
  async function connectSocket() {
    // Already connected
    if (socket && socket.readyState === WebSocket.OPEN) {
      console.log("UniBox: WebSocket already connected");
      return true;
    }

    // Connection already in progress - wait for it
    if (isConnecting && wsConnectPromise) {
      console.log("UniBox: Connection already in progress, waiting...");
      return wsConnectPromise;
    }

    // Socket is connecting - wait for it
    if (
      socket &&
      socket.readyState === WebSocket.CONNECTING &&
      wsConnectPromise
    ) {
      console.log("UniBox: WebSocket is still connecting, waiting...");
      return wsConnectPromise;
    }

    // Clean up any stale socket
    if (
      socket &&
      (socket.readyState === WebSocket.CLOSING ||
        socket.readyState === WebSocket.CLOSED)
    ) {
      socket = null;
    }

    if (!conversationId || !WS_URL) {
      console.log("UniBox: Missing conversationId or WS_URL for WebSocket");
      return false;
    }

    // Set connecting flag BEFORE async operations
    isConnecting = true;

    // Get JWT token for WebSocket authentication
    if (!wsToken) {
      wsToken = await getWebSocketToken();
      if (!wsToken) {
        console.error("UniBox: Cannot connect to WebSocket without token");
        isConnecting = false;
        return false;
      }
    }

    // Create connection promise that will be resolved in onopen/onerror
    wsConnectPromise = new Promise((resolve) => {
      wsConnectResolve = resolve;
    });

    try {
      // Connect to WebSocket with JWT token
      const wsUrl = `${WS_URL}?token=${wsToken}`;
      console.log(
        "UniBox: Creating new WebSocket connection to:",
        wsUrl.split("?")[0],
      );

      // Create the WebSocket
      const ws = new WebSocket(wsUrl);
      socket = ws;

      ws.onopen = () => {
        console.log(
          "UniBox: WebSocket onopen fired, readyState:",
          ws.readyState,
        );

        // Reset connecting flag
        isConnecting = false;

        // Verify connection is actually open
        if (ws.readyState !== WebSocket.OPEN) {
          console.error(
            "UniBox: onopen fired but readyState is not OPEN:",
            ws.readyState,
          );
          if (wsConnectResolve) {
            wsConnectResolve(false);
            wsConnectResolve = null;
          }
          return;
        }

        console.log("UniBox: WebSocket successfully connected");

        // Resolve the connection promise IMMEDIATELY
        if (wsConnectResolve) {
          wsConnectResolve(true);
          wsConnectResolve = null;
        }

        // Subscribe to conversation if we have a valid conversationId
        if (!subscribeToConversation(conversationId)) {
          console.log(
            "UniBox: Will subscribe later when conversation is created",
          );
        }

        // Flush any pending messages
        flushPendingMessages();

        // Fetch message history after connection (delayed to avoid blocking)
        setTimeout(() => {
          if (userId && conversationId) {
            fetch(`${API_BASE}/thread/${userId}?limit=50`, {
              method: "GET",
              headers: getHeaders(),
            })
              .then((res) => (res.ok ? res.json() : null))
              .then((threadData) => {
                if (
                  threadData &&
                  threadData.messages &&
                  Array.isArray(threadData.messages)
                ) {
                  threadData.messages.forEach((msg) => {
                    // Normalize text - convert empty string to null
                    const textValue = msg.text || msg.text_body;
                    const normalizedTextValue =
                      textValue && textValue.trim() ? textValue.trim() : null;

                    const canonicalTimestamp =
                      (typeof msg.timestamp === "number" && msg.timestamp) ||
                      (msg.timestamp_iso
                        ? msg.timestamp_iso
                        : typeof msg.timestamp_meta === "number"
                          ? msg.timestamp_meta * 1000
                          : undefined);

                    appendMessageToUI(
                      normalizedTextValue,
                      msg.sender ||
                        (msg.direction === "inbound" ? "user" : "agent"),
                      msg.id || msg.messageId,
                      canonicalTimestamp,
                      msg.status,
                      msg.readAt,
                      msg.readByUs,
                      msg.readByUsAt,
                      msg.type,
                      msg.media_storage_url,
                    );
                  });
                  sortMessagesByTimestamp();
                  setTimeout(() => {
                    markVisibleMessagesAsRead();
                  }, 500);
                }
              })
              .catch((e) =>
                console.error(
                  "UniBox: Failed to fetch thread after socket connect",
                  e,
                ),
              );
          }
        }, 500);
      };

      // Handle incoming WebSocket messages
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleWebSocketMessage(message);
        } catch (error) {
          console.error("UniBox: Failed to parse WebSocket message", error);
        }
      };

      ws.onerror = (error) => {
        console.error("UniBox: WebSocket error", error);
        isConnecting = false;
        // Resolve connection promise as failed
        if (wsConnectResolve) {
          wsConnectResolve(false);
          wsConnectResolve = null;
        }
      };

      ws.onclose = () => {
        console.log("UniBox: WebSocket disconnected");
        isConnecting = false;

        // Resolve connection promise as failed if still pending
        if (wsConnectResolve) {
          wsConnectResolve(false);
          wsConnectResolve = null;
        }

        // Only clean up if this is still the active socket
        if (socket === ws) {
          socket = null;
          wsToken = null;
          wsConnectPromise = null;
          subscribedConversationId = null; // Reset subscription state on disconnect

          // Attempt to reconnect after 3 seconds
          setTimeout(() => {
            if (conversationId) {
              connectSocket().then(() => {
                // Re-subscribe after reconnecting
                subscribeToConversation(conversationId);
              });
            }
          }, 3000);
        }
      };

      // Return the connection promise so callers can await it
      return wsConnectPromise;
    } catch (error) {
      console.error("UniBox: Failed to connect WebSocket", error);
      isConnecting = false;
      socket = null;
      wsToken = null;
      if (wsConnectResolve) {
        wsConnectResolve(false);
        wsConnectResolve = null;
      }
      return false;
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  function handleWebSocketMessage(message) {
    const { type, data } = message;

    // Debug logging for all incoming messages
    console.log("UniBox: WebSocket message received:", {
      type,
      hasData: !!data,
    });

    switch (type) {
      case "MESSAGE_CREATED":
      case "message":
        console.log("UniBox: Processing MESSAGE_CREATED:", data || message);
        handleIncomingMessage(data || message);
        break;

      case "TYPING":
        handleTypingIndicator(data || message);
        break;

      case "READ":
        // User does NOT receive read receipts from agent
        // This is intentionally ignored per design
        break;

      case "MEDIA_UPLOAD_RESPONSE":
        // Handled by requestPresignedUrl via addEventListener
        // No action needed here, just prevent logging unknown type
        break;

      case "subscribed":
        console.log("UniBox: Subscribed to conversation", data || message);
        break;

      case "error":
        console.error("UniBox: WebSocket error:", data || message);
        break;

      default:
        // Handle legacy format or unknown types
        if (message.messageId || message.text || message.sender) {
          handleIncomingMessage(message);
        } else {
          console.log("UniBox: Unknown WebSocket message type:", type, message);
        }
    }
  }

  /**
   * Handle incoming message from WebSocket
   */
  function handleIncomingMessage(message) {
    const isUserMessage = message.sender === "user";

    const existingMessage =
      messages.get(message.messageId) ||
      Array.from(messages.values()).find(
        (msg) =>
          msg.messageId === message.messageId || msg.id === message.messageId,
      );

    if (existingMessage && existingMessage.element) {
      existingMessage.status = message.status || existingMessage.status;
      existingMessage.readAt = message.readAt || existingMessage.readAt;
      existingMessage.readByUs =
        message.readByUs !== undefined
          ? message.readByUs
          : existingMessage.readByUs;
      existingMessage.readByUsAt =
        message.readByUsAt || existingMessage.readByUsAt;
      return;
    }

    if (isUserMessage) {
      const optimisticMessage = Array.from(messages.values()).find((msg) => {
        if (!msg.element || msg.sender !== "user") return false;
        // RELAXED TIMING: Allow up to 30 seconds diff to account for network/server delay
        return (
          msg.text === message.text &&
          Math.abs(new Date(msg.timestamp) - new Date(message.timestamp)) <
            30000
        );
      });

      if (optimisticMessage && optimisticMessage.element) {
        const oldId = optimisticMessage.id || optimisticMessage.messageId;
        optimisticMessage.id = message.messageId;
        optimisticMessage.messageId = message.messageId;
        optimisticMessage.status = message.status || optimisticMessage.status;
        optimisticMessage.readAt = message.readAt || optimisticMessage.readAt;
        optimisticMessage.readByUs =
          message.readByUs !== undefined
            ? message.readByUs
            : optimisticMessage.readByUs;
        optimisticMessage.readByUsAt =
          message.readByUsAt || optimisticMessage.readByUsAt;
        optimisticMessage.element.setAttribute(
          "data-message-id",
          message.messageId,
        );
        if (oldId && oldId !== message.messageId) {
          messages.delete(oldId);
        }
        messages.set(message.messageId, optimisticMessage);
        return;
      }
    }

    // Normalize text - convert empty string to null
    const textValue = message.text;
    const normalizedTextValue =
      textValue && textValue.trim() ? textValue.trim() : null;

    // Debug logging for media messages
    const isMedia =
      message.type &&
      ["image", "video", "audio", "document", "file"].includes(message.type);
    if (isMedia || message.media_storage_url) {
      console.log("UniBox: Received media message:", {
        messageId: message.messageId,
        type: message.type,
        media_storage_url: message.media_storage_url,
        text: normalizedTextValue,
        sender: message.sender,
      });
    }

    appendMessageToUI(
      normalizedTextValue,
      message.sender,
      message.messageId,
      message.timestamp,
      message.status,
      message.readAt,
      message.readByUs,
      message.readByUsAt,
      message.type,
      message.media_storage_url,
    );

    sortMessagesByTimestamp();

    if (!isUserMessage) {
      // AI/agent replied - hide typing indicator
      if (agentTypingTimeout) {
        clearTimeout(agentTypingTimeout);
        agentTypingTimeout = null;
      }
      agentTyping = false;
      showTypingIndicator(false);
      markVisibleMessagesAsRead();
    }
  }

  /**
   * Whether AI replies are enabled for this chat (bot flow or explicit aiEnabled).
   */
  function isAiEnabled() {
    return !!(
      settings &&
      (settings.botFlow || settings.behavior?.aiEnabled === true)
    );
  }

  /**
   * Handle typing indicator from agent or AI
   * User sees typing from AGENT; when AI is enabled, also from AI.
   */
  function handleTypingIndicator(data) {
    // Validate conversation matches
    if (!data || data.conversationId !== conversationId) {
      return;
    }

    // Typing from agent: isAgent flag or principalId starts with 'agent'
    const isFromAgent =
      data.isAgent === true ||
      (data.from && String(data.from).toLowerCase().startsWith("agent"));

    // Typing from AI when AI is enabled
    const isFromAi =
      data.isAi === true ||
      (data.from && String(data.from).toLowerCase() === "ai");

    const showTyping =
      isFromAgent || (isAiEnabled() && isFromAi);

    if (!showTyping) {
      return;
    }

    // Clear existing timeout
    if (agentTypingTimeout) {
      clearTimeout(agentTypingTimeout);
    }

    // Agent is typing - show indicator
    agentTyping = true;
    showTypingIndicator(true);

    // Auto-hide after 4 seconds (1s buffer over agent's 3s send interval)
    agentTypingTimeout = setTimeout(() => {
      agentTyping = false;
      showTypingIndicator(false);
      agentTypingTimeout = null;
    }, 4000);
  }

  // --- MEDIA UPLOAD FUNCTIONS ---
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result);
      reader.onerror = (error) => reject(error);
    });
  }

  function getMediaTypeFromFile(file) {
    const type = file.type.toLowerCase();
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    if (
      type.includes("pdf") ||
      type.includes("document") ||
      type.includes("word") ||
      type.includes("excel") ||
      type.includes("sheet")
    )
      return "document";
    return "file";
  }

  /**
   * @deprecated - Use presigned URL approach via WebSocket instead.
   * Upload a base64-encoded media file to S3 and get the S3 key.
   * This endpoint does NOT send the message - it only uploads to S3.
   */
  async function uploadMediaToS3(file) {
    try {
      const mediaBase64 = await fileToBase64(file);
      const mediaType = getMediaTypeFromFile(file);

      const response = await fetch(`${API_BASE}/media/upload`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          media_base64: mediaBase64,
          media_type: mediaType,
          conversationId: conversationId || undefined,
          userId: userId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error?.message || `HTTP error! status: ${response.status}`,
        );
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error("UniBox: Media upload error", error);
      throw error;
    }
  }

  /**
   * Validate file size (10MB limit for live chat)
   */
  function validateFileSize(file) {
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
      throw new Error(
        `File too large (${fileSizeMB}MB). Maximum size is 10MB.`,
      );
    }
    return true;
  }

  /**
   * @deprecated - Not used. The widget uses the file chips flow instead.
   * Show file preview before sending (legacy - kept for reference)
   */
  // function showFilePreview(file) {
  //   const mediaType = getMediaTypeFromFile(file);
  //   const previewUrl = URL.createObjectURL(file);
  //   previewFile = { file, previewUrl, mediaType, fileName: file.name || `file.${mediaType}` };
  //   renderPreviewModal();
  // }

  /**
   * Generate presigned URL for S3 upload using utility service
   * Same approach as agent side - uses /s3/generate-presigned-url endpoint
   */
  async function generatePresignedUploadUrl(s3Key) {
    try {
      // Use utility API base URL + /generate-presigned-url
      const endpoint = `${UTILITY_API_BASE}/generate-presigned-url`;
      console.log("UniBox: Requesting presigned URL from:", endpoint);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          key: s3Key,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to get presigned URL: ${response.status}`);
      }

      // Response can be plain text URL or JSON object
      const contentType = response.headers.get("content-type") || "";
      let presignedUrl;

      if (contentType.includes("application/json")) {
        const data = await response.json();
        // Response should have { url: presignedUrl } or { uploadUrl: presignedUrl }
        presignedUrl = data.url || data.uploadUrl || data;
      } else {
        // Plain text response - URL directly
        presignedUrl = await response.text();
      }

      // Handle case where presignedUrl is still an object
      if (typeof presignedUrl === "object" && presignedUrl !== null) {
        presignedUrl = presignedUrl.url || presignedUrl.uploadUrl;
      }

      // Trim whitespace from text response
      if (typeof presignedUrl === "string") {
        presignedUrl = presignedUrl.trim();
      }

      if (!presignedUrl || typeof presignedUrl !== "string") {
        throw new Error("No presigned URL in response");
      }

      // Validate it's a URL
      if (!presignedUrl.startsWith("http")) {
        throw new Error("Invalid presigned URL format");
      }

      console.log("UniBox: Got presigned upload URL");
      return presignedUrl;
    } catch (error) {
      console.error("UniBox: Error generating presigned URL:", error);
      throw error;
    }
  }

  /**
   * @deprecated - Use generatePresignedUploadUrl instead
   * Request presigned S3 URL for media upload via WebSocket
   */
  async function requestPresignedUrl(file) {
    const mimeType = file.type;
    const fileSize = file.size;

    // Try WebSocket first
    if (socket && socket.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        const requestId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Set up one-time message handler
        const messageHandler = (event) => {
          try {
            const response = JSON.parse(event.data);
            if (
              response.type === "MEDIA_UPLOAD_RESPONSE" &&
              response.requestId === requestId
            ) {
              socket.removeEventListener("message", messageHandler);
              if (response.error) {
                reject(new Error(response.error));
              } else {
                resolve(response.data);
              }
            }
          } catch (e) {
            // Ignore parse errors for other messages
          }
        };

        socket.addEventListener("message", messageHandler);

        // Send request
        if (
          !wsSend({
            action: "mediaUploadRequest",
            requestId: requestId,
            conversationId: conversationId,
            mime: mimeType,
            size: fileSize,
          })
        ) {
          socket.removeEventListener("message", messageHandler);
          reject(new Error("WebSocket not connected"));
          return;
        }

        // Timeout after 10 seconds
        setTimeout(() => {
          socket.removeEventListener("message", messageHandler);
          reject(new Error("Presigned URL request timeout"));
        }, 10000);
      });
    }

    // WebSocket ONLY - no HTTP fallback for live chat
    throw new Error("WebSocket not connected - cannot request presigned URL");
  }

  /**
   * Upload file directly to S3 using presigned URL
   */
  async function uploadToS3(presignedUrl, file) {
    const response = await fetch(presignedUrl, {
      method: "PUT",
      body: file,
      headers: {
        "Content-Type": file.type,
      },
    });

    if (!response.ok) {
      throw new Error("Failed to upload file to S3");
    }

    return true;
  }

  /**
   * Generate a presigned access URL from an S3 key
   * Used for rendering media - frontend calls this to get fresh presigned URL
   * NOTE: This function is an alias for fetchMediaUrl for consistency
   * @param {string} s3Key - The S3 key (e.g., 'live-chat-media/tenant-123/file.jpg')
   * @returns {Promise<string>} - Presigned access URL
   */
  async function generateAccessUrl(s3Key) {
    // Use the existing fetchMediaUrl function which already handles this
    return fetchMediaUrl(s3Key);
  }

  /**
   * @deprecated - Not used. The widget uses sendSelectedFiles() instead.
   * This was designed for single-file preview modal flow which is not implemented.
   * The current working flow uses: addSelectedFile() → file chips → sendSelectedFiles()
   */
  async function confirmSendMedia(caption) {
    console.warn(
      "UniBox: confirmSendMedia is deprecated. Use sendSelectedFiles instead.",
    );
    if (!previewFile) return;

    const file = previewFile.file;
    const mediaType = previewFile.mediaType;
    const fileName = previewFile.fileName;

    // Validate file size
    try {
      validateFileSize(file);
    } catch (error) {
      console.error("UniBox: File validation error", error);
      alert(error.message || "File size exceeds limit");
      closePreviewModal();
      return;
    }

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    // If no conversation exists, create one first
    if (!conversationId) {
      await initializeConversation();
    }

    // Show uploading indicator
    const messageId = `msg_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    try {
      // Ensure WebSocket is connected before attempting upload
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.log("UniBox: Connecting WebSocket for media upload...");
        await connectSocket();
        await waitForWsConnection(5000); // Wait up to 5 seconds for connection
      }

      // Show uploading indicator
      appendMessageToUI(
        `Uploading ${fileName}...`,
        "user",
        messageId,
        new Date(),
        "sent",
        null,
        false,
        null,
        mediaType,
        null,
      );

      // Step 1: Request presigned URL (returns uploadUrl, fileUrl, and s3Key)
      console.log("UniBox: Requesting presigned URL for media upload...");
      const uploadData = await requestPresignedUrl(file);
      console.log(
        "UniBox: Received upload data:",
        uploadData ? "success" : "null",
      );

      const uploadUrl = uploadData?.uploadUrl;
      const s3Key = uploadData?.s3Key;

      if (!uploadUrl || !s3Key) {
        console.error(
          "UniBox: Missing uploadUrl or s3Key in response:",
          uploadData,
        );
        throw new Error("Failed to get upload URL from server");
      }

      // Step 2: Upload directly to S3
      console.log("UniBox: Uploading file to S3...");
      await uploadToS3(uploadUrl, file);
      console.log("UniBox: S3 upload complete");

      // Step 3: Send message with S3 KEY (not full URL) via WebSocket
      // Frontend will call generate-access-url to render the media
      // Send media message via WebSocket ONLY - no HTTP fallback
      const wsSent = wsSend({
        action: "sendMessage",
        conversationId: conversationId,
        payload: {
          text: caption || fileName,
          url: s3Key, // Send S3 key, not presigned URL
          type: mediaType,
        },
        userId: userId,
        userName: userDetails.userName,
        userEmail: userDetails.userEmail,
      });

      if (!wsSent) {
        // WebSocket not ready - message is queued and will be sent when connected
        console.log("UniBox: Media message queued for WebSocket delivery");
      } else {
        console.log("UniBox: Media message sent successfully via WebSocket");
      }

      // Close preview modal on success
      closePreviewModal();

      // Message will be received via WebSocket and added automatically
    } catch (error) {
      console.error("UniBox: Send Media Error", error);

      // Remove uploading indicator and show error
      const host = document.getElementById("unibox-root");
      if (host && host.shadowRoot) {
        const body = host.shadowRoot.getElementById("chatBody");
        if (body) {
          const uploadingMsg = body.querySelector(
            `[data-message-id="${messageId}"]`,
          );
          if (uploadingMsg) {
            uploadingMsg.remove();
            messages.delete(messageId);
          }
        }
      }

      closePreviewModal();
      alert(error.message || "Failed to upload media. Please try again.");
    }
  }

  /**
   * Add file to selected files and show as chip
   */
  function addSelectedFile(file) {
    try {
      const mediaType = getMediaTypeFromFile(file);
      let previewUrl = null;

      try {
        previewUrl = URL.createObjectURL(file);
      } catch (err) {
        console.warn("UniBox: Could not create preview URL for file", err);
      }

      selectedFiles.push({
        file: file,
        previewUrl: previewUrl,
        mediaType: mediaType,
        fileName: file.name || `file.${mediaType}`,
      });

      // Use setTimeout to avoid blocking the main thread
      setTimeout(() => {
        try {
          renderFileChips();
        } catch (err) {
          console.error("UniBox: Error rendering file chips", err);
        }
      }, 0);

      // Update send button state
      const host = document.getElementById("unibox-root");
      if (host && host.shadowRoot) {
        const sendBtn = host.shadowRoot.getElementById("sendBtn");
        if (sendBtn) {
          const msgInput = host.shadowRoot.getElementById("msgInput");
          const hasText = msgInput && msgInput.value.trim().length > 0;
          const hasFiles = selectedFiles.length > 0;
          sendBtn.disabled = !hasText && !hasFiles;
          sendBtn.style.opacity = hasText || hasFiles ? "1" : "0.5";
          sendBtn.style.cursor =
            hasText || hasFiles ? "pointer" : "not-allowed";
        }
      }
    } catch (err) {
      console.error("UniBox: Error adding selected file", err);
    }
  }

  /**
   * Remove file from selected files
   */
  function removeSelectedFile(index) {
    if (selectedFiles[index] && selectedFiles[index].previewUrl) {
      URL.revokeObjectURL(selectedFiles[index].previewUrl);
    }
    selectedFiles.splice(index, 1);
    renderFileChips();

    // Update send button state
    const host = document.getElementById("unibox-root");
    if (host && host.shadowRoot) {
      const sendBtn = host.shadowRoot.getElementById("sendBtn");
      if (sendBtn) {
        const msgInput = host.shadowRoot.getElementById("msgInput");
        const hasText = msgInput && msgInput.value.trim().length > 0;
        const hasFiles = selectedFiles.length > 0;
        sendBtn.disabled = !hasText && !hasFiles;
        sendBtn.style.opacity = hasText || hasFiles ? "1" : "0.5";
        sendBtn.style.cursor = hasText || hasFiles ? "pointer" : "not-allowed";
      }
    }
  }

  // Track pending render timeout to prevent multiple concurrent retries
  let renderChipsTimeout = null;
  let renderChipsRetryCount = 0;
  const MAX_RENDER_RETRIES = 10;

  /**
   * Render file chips above input field (like MessageInput.tsx)
   */
  function renderFileChips() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;

    const footerSection = host.shadowRoot.getElementById("chatFooterSection");
    const footer = host.shadowRoot.getElementById("chatFooter");
    if (!footerSection || !footer) {
      // Footer might not be ready yet, try again after a short delay (with limit)
      if (renderChipsRetryCount < MAX_RENDER_RETRIES) {
        renderChipsRetryCount++;
        // Clear any pending timeout first
        if (renderChipsTimeout) {
          clearTimeout(renderChipsTimeout);
        }
        renderChipsTimeout = setTimeout(renderFileChips, 100);
      } else {
        console.warn(
          "UniBox: Footer not found after max retries, skipping chip render",
        );
        renderChipsRetryCount = 0;
      }
      return;
    }

    // Reset retry count on success
    renderChipsRetryCount = 0;
    if (renderChipsTimeout) {
      clearTimeout(renderChipsTimeout);
      renderChipsTimeout = null;
    }

    // Ensure footer section is visible
    footerSection.classList.remove("hidden");

    // Remove existing chips container
    const existingChips = host.shadowRoot.getElementById("fileChipsContainer");
    if (existingChips) {
      existingChips.remove();
    }

    // If no files, don't render anything
    if (selectedFiles.length === 0) return;

    // Create chips container
    const chipsContainer = document.createElement("div");
    chipsContainer.id = "fileChipsContainer";
    chipsContainer.className = "file-chips-container";
    chipsContainer.style.display = "flex";
    chipsContainer.style.flexWrap = "wrap";
    chipsContainer.style.gap = "8px";
    chipsContainer.style.padding = "12px 16px";
    chipsContainer.style.borderBottom = "1px solid #e5e7eb";
    chipsContainer.style.backgroundColor = "#ffffff";
    chipsContainer.style.width = "100%";
    chipsContainer.style.boxSizing = "border-box";

    selectedFiles.forEach((fileData, index) => {
      const chip = document.createElement("div");
      chip.style.display = "flex";
      chip.style.alignItems = "center";
      chip.style.gap = "8px";
      chip.style.height = "36px";
      chip.style.padding = "0 12px";
      chip.style.borderRadius = "6px";
      chip.style.backgroundColor = "#ffffff";
      chip.style.border = "1px solid #EFEFEF";
      chip.style.fontSize = "14px";
      chip.style.fontFamily =
        settings.appearance.fontFamily || "DM Sans, sans-serif";
      chip.style.fontWeight = "400";
      chip.style.lineHeight = "20px";
      chip.style.color = "#18181E";

      // Determine icon based on file type (matching MessageInput.tsx)
      const lower = fileData.fileName.toLowerCase();
      const isPdf = lower.endsWith(".pdf");

      // Create icon element (using SVG like MessageInput.tsx uses Image component)
      const iconDiv = document.createElement("div");
      iconDiv.style.display = "flex";
      iconDiv.style.alignItems = "center";
      iconDiv.style.justifyContent = "center";
      iconDiv.style.width = "20px";
      iconDiv.style.height = "20px";
      iconDiv.style.flexShrink = "0";

      // Use SVG icons (since we can't use Image component in vanilla JS)
      if (isPdf) {
        iconDiv.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>`;
        iconDiv.style.color =
          (settings.appearance.gradientColor1 ||
            settings.appearance.primaryColor ||
            "#912FF5");
      } else {
        iconDiv.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>`;
        iconDiv.style.color =
          (settings.appearance.gradientColor1 ||
            settings.appearance.primaryColor ||
            "#912FF5");
      }

      // File name
      const nameSpan = document.createElement("span");
      nameSpan.style.overflow = "hidden";
      nameSpan.style.textOverflow = "ellipsis";
      nameSpan.style.whiteSpace = "nowrap";
      nameSpan.style.maxWidth = "180px";
      nameSpan.textContent = fileData.fileName;

      // Remove button (matching MessageInput.tsx style)
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.style.display = "flex";
      removeBtn.style.alignItems = "center";
      removeBtn.style.justifyContent = "center";
      removeBtn.style.padding = "4px";
      removeBtn.style.backgroundColor = "transparent";
      removeBtn.style.border = "none";
      removeBtn.style.cursor = "pointer";
      removeBtn.style.borderRadius = "4px";
      removeBtn.style.flexShrink = "0";
      removeBtn.style.transition = "background-color 0.2s";
      removeBtn.onmouseenter = () => {
        removeBtn.style.backgroundColor = "#f3f4f6";
      };
      removeBtn.onmouseleave = () => {
        removeBtn.style.backgroundColor = "transparent";
      };
      removeBtn.onclick = () => removeSelectedFile(index);
      removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>`;
      removeBtn.style.color = "#6b7280";

      chip.appendChild(iconDiv);
      chip.appendChild(nameSpan);
      chip.appendChild(removeBtn);
      chipsContainer.appendChild(chip);
    });

    // Insert chips container ABOVE the footer (before footer element)
    // This places it between chat body and footer
    footer.parentElement.insertBefore(chipsContainer, footer);

    // Ensure chips are visible
    chipsContainer.style.display = "flex";
    chipsContainer.style.visibility = "visible";
    chipsContainer.style.opacity = "1";
  }

  /**
   * Send all selected files with caption
   * FAST PATH: Generate S3 key -> Show UI -> Send WebSocket -> Upload in background
   */
  async function sendSelectedFiles(caption) {
    if (selectedFiles.length === 0) return;

    // Get user details
    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    // If no conversation exists, create one first
    if (!conversationId) {
      await initializeConversation();
    }

    // Ensure WebSocket is connected
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      await connectSocket();
      await waitForWsConnection(5000);
    }

    // Send each file - copy the array but DON'T revoke URLs yet (need them for optimistic UI)
    const filesToSend = [...selectedFiles];

    // Clear selected files array but don't revoke URLs yet
    selectedFiles = [];
    renderFileChips();

    // Get tenantId from config
    const tenantId = fetchedConfig?.tenantId || "unknown";

    for (const fileData of filesToSend) {
      const file = fileData.file;
      const mediaType = fileData.mediaType;
      const fileName = fileData.fileName;
      const localPreviewUrl = fileData.previewUrl; // Keep for optimistic UI - will be revoked after upload

      // Validate file size
      try {
        validateFileSize(file);
      } catch (error) {
        console.error("UniBox: File validation error", error);
        alert(error.message || "File size exceeds limit");
        continue;
      }

      // FAST PATH: Same as agent side
      // Generate S3 key -> Show chip UI -> Send WebSocket -> Upload in background
      console.log("📤 Widget media upload - FAST PATH...");

      // Step 1: Generate random S3 key locally (instant)
      const fileExt = fileName.split(".").pop() || "bin";
      const randomId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const s3Key = `live-chat-media/${tenantId}/${conversationId}/${randomId}.${fileExt}`;
      const messageId = `msg_media_${randomId}`;
      console.log("1️⃣ Generated S3 key:", s3Key);

      // Step 2: Show chip UI immediately (no loading state - same as agent side)
      // Use s3Key as mediaStorageUrl so it shows as a chip, not inline image
      appendMessageToUI(
        caption || "", // Caption only, NOT filename
        "user",
        messageId,
        new Date(),
        "delivered", // Show as sent immediately (no loading state)
        null, // readAt
        false, // readByUs
        null, // readByUsAt
        mediaType,
        s3Key, // Use S3 key so it shows as a chip
      );
      console.log("2️⃣ Chip UI shown");

      // Step 3: Send message via WebSocket with S3 KEY (instant)
      const wsSent = wsSend({
        action: "sendMessage",
        conversationId: conversationId,
        payload: {
          text: caption || "", // Caption only, NOT filename
          url: s3Key, // S3 key
          type: mediaType,
        },
        userId: userId,
        userName: userDetails.userName,
        userEmail: userDetails.userEmail,
      });

      if (wsSent) {
        console.log("3️⃣ Message sent via WebSocket with S3 key:", s3Key);
      } else {
        console.log("3️⃣ Message queued for WebSocket delivery");
      }

      // Cleanup local preview URL immediately (not needed for chip display)
      if (localPreviewUrl && localPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(localPreviewUrl);
      }

      // Step 4 & 5: Get presigned URL via utility service and upload in background
      (async () => {
        try {
          console.log("4️⃣ Requesting presigned URL via utility service...");
          const presignedUrl = await generatePresignedUploadUrl(s3Key);
          console.log("✅ Got presigned URL");

          console.log("5️⃣ Uploading to S3...");
          await uploadToS3(presignedUrl, file);
          console.log("✅ File uploaded to S3");

          // Upload complete - message already shown with 'sent' status
          console.log("✅ Media upload complete for:", s3Key);
        } catch (uploadError) {
          console.error("❌ Background upload failed:", uploadError);
          // Update message status to failed
          const existingMsg = messages.get(messageId);
          if (existingMsg) {
            existingMsg.status = "failed";
            // Update UI to show failed status
            const host = document.getElementById("unibox-root");
            if (host && host.shadowRoot) {
              const msgEl = host.shadowRoot.querySelector(
                `[data-message-id="${messageId}"]`,
              );
              if (msgEl) {
                const chip = msgEl.querySelector(".chat-widget-media-chip");
                if (chip) {
                  chip.style.borderColor = "#ef4444";
                  chip.style.backgroundColor = "#fef2f2";
                }
              }
            }
          }
        }
      })();
    }
  }

  /**
   * Add file to selected files (shows as chip above input)
   */
  async function sendMediaMessage(file) {
    // Validate file size first
    try {
      validateFileSize(file);
    } catch (error) {
      console.error("UniBox: File validation error", error);
      alert(error.message || "File size exceeds limit");
      return;
    }

    // Add to selected files (will show as chip)
    addSelectedFile(file);
  }

  /**
   * Send text message via WebSocket
   * Falls back to HTTP API if WebSocket is not available
   */
  async function sendMessageToApi(text) {
    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    try {
      // If no conversation exists, create one first (silently, no loading state)
      if (!conversationId) {
        await initializeConversation();
      }

      // Connect socket if needed and wait for connection
      if (conversationId) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          console.log(
            "UniBox: Waiting for WebSocket connection before sending...",
          );
          const connectResult = await connectSocket();

          // If connectSocket returned a promise or false, wait for connection
          if (connectResult !== true) {
            const connected = await waitForWsConnection(5000);
            if (!connected) {
              console.log(
                "UniBox: WebSocket connection not ready, will use HTTP fallback",
              );
            } else {
              console.log("UniBox: WebSocket now connected");
            }
          }
        }
      }

      // Send via WebSocket ONLY - no HTTP fallback for live chat
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Optimistically add message to UI immediately
      appendMessageToUI(
        text,
        "user",
        messageId,
        new Date(),
        "sending",
        null,
        false,
        null,
        "text",
        null,
      );

      sortMessagesByTimestamp();

      const wsSent = wsSend({
        action: "sendMessage",
        conversationId: conversationId,
        payload: {
          text: text,
        },
        userId: userId,
        userName: userDetails.userName,
        userEmail: userDetails.userEmail,
      });

      if (wsSent) {
        console.log("UniBox: Message sent via WebSocket");
        // When AI is enabled, show typing until AI reply arrives (or server TYPING is received)
        if (isAiEnabled()) {
          if (agentTypingTimeout) {
            clearTimeout(agentTypingTimeout);
            agentTypingTimeout = null;
          }
          agentTyping = true;
          showTypingIndicator(true);
          // Safety: hide after 15s if no reply (e.g. AI disabled on server)
          agentTypingTimeout = setTimeout(() => {
            agentTyping = false;
            showTypingIndicator(false);
            agentTypingTimeout = null;
          }, 15000);
        }
      } else {
        // WebSocket not ready - message is queued and will be sent when connected
        console.log("UniBox: Message queued for WebSocket delivery");
      }

      return { success: true, messageId };
    } catch (error) {
      console.error("UniBox: Send Error", error);
      const host = document.getElementById("unibox-root");
      if (host && host.shadowRoot) {
        const body = host.shadowRoot.getElementById("chatBody");
        if (body) {
          const errDiv = document.createElement("div");
          errDiv.style.textAlign = "center";
          errDiv.style.fontSize = "12px";
          errDiv.style.color = "red";
          errDiv.innerText = "Failed to deliver message";
          body.appendChild(errDiv);
        }
      }
      throw error;
    }
  }

  /**
   * @deprecated - Messages now arrive via WebSocket, not HTTP polling.
   * This function is kept for potential fallback use but is not called.
   *
   * Fetch and render the latest conversation thread after a user message is sent.
   * Clears and re-renders all messages from the server response to ensure correct order
   * and eliminate any glitches from optimistic updates.
   */
  async function fetchAndRenderThreadAfterSend() {
    if (!userId) return;

    try {
      // Wait a bit for backend to process the message and generate bot response
      await new Promise((resolve) => setTimeout(resolve, 800));

      const threadRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
        method: "GET",
        headers: getHeaders(),
      });

      if (!threadRes.ok) {
        return;
      }

      const threadData = await threadRes.json();
      if (threadData.messages && Array.isArray(threadData.messages)) {
        // Clear all messages to avoid any glitches or ordering issues
        const host = document.getElementById("unibox-root");
        if (host && host.shadowRoot) {
          const body = host.shadowRoot.getElementById("chatBody");
          if (body) {
            // Remove all message elements (but preserve typing indicator)
            const allMessages = body.querySelectorAll(".chat-widget-message");
            allMessages.forEach((msg) => msg.remove());

            // Clear the messages map
            messages.clear();
            staticWelcomeShown = false;

            // Make sure typing indicator is still in the body
            const typingIndicator = body.querySelector("#typingIndicator");
            if (!typingIndicator) {
              const newTypingIndicator = document.createElement("div");
              newTypingIndicator.className =
                "chat-widget-typing-indicator hidden";
              newTypingIndicator.id = "typingIndicator";
              newTypingIndicator.innerHTML = `
              <div class="chat-widget-typing-dot"></div>
              <div class="chat-widget-typing-dot"></div>
              <div class="chat-widget-typing-dot"></div>
            `;
              body.appendChild(newTypingIndicator);
            }
          }
        }

        // Now render all messages from thread in correct order
        threadData.messages.forEach((msg) => {
          // Normalize text - convert empty string to null
          const textValue = msg.text || msg.text_body;
          const normalizedTextValue =
            textValue && textValue.trim() ? textValue.trim() : null;

          const canonicalTimestamp =
            (typeof msg.timestamp === "number" && msg.timestamp) ||
            (msg.timestamp_iso
              ? msg.timestamp_iso
              : typeof msg.timestamp_meta === "number"
                ? msg.timestamp_meta * 1000
                : undefined);

          appendMessageToUI(
            normalizedTextValue,
            msg.sender || (msg.direction === "inbound" ? "user" : "agent"),
            msg.id || msg.messageId,
            canonicalTimestamp,
            msg.status,
            msg.readAt,
            msg.readByUs,
            msg.readByUsAt,
            msg.type,
            msg.media_storage_url,
          );
        });

        // Messages from API should already be in correct order, but sort to be safe
        sortMessagesByTimestamp();
        markVisibleMessagesAsRead();
      }
    } catch (e) {
      console.error("UniBox: Failed to fetch thread after message", e);
    }
  }

  /**
   * Show media preview in popup modal
   */
  async function showMediaPreview(mediaKey, mediaType, caption) {
    // Check if this is a local blob URL (for optimistic display)
    const isBlobUrl = mediaKey && mediaKey.startsWith("blob:");

    previewMedia = {
      mediaKey: mediaKey,
      mediaType: mediaType,
      caption: caption,
      url: isBlobUrl ? mediaKey : null, // Use blob URL directly if available
      filename: isBlobUrl ? "Preview" : mediaKey.split("/").pop() || "file",
      isLoading: !isBlobUrl, // Don't show loading for blob URLs
    };

    renderPreviewModal();

    // Skip fetch for blob URLs
    if (isBlobUrl) {
      return;
    }

    // Fetch media URL for S3 keys
    try {
      const url = await fetchMediaUrl(mediaKey);
      if (url) {
        previewMedia.url = url;
        previewMedia.isLoading = false;
        renderPreviewModal();
      } else {
        throw new Error("Failed to load media");
      }
    } catch (error) {
      console.error("UniBox: Error loading media preview", error);
      previewMedia.isLoading = false;
      previewMedia.error = true;
      renderPreviewModal();
    }
  }

  /**
   * Render preview modal for file upload or media viewing
   */
  function renderPreviewModal() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;

    let modal = host.shadowRoot.getElementById("chatWidgetPreviewModal");

    // Remove existing modal
    if (modal) {
      modal.remove();
    }

    // Don't render if no preview (only for viewing received media)
    if (!previewMedia) return;

    // Create modal
    modal = document.createElement("div");
    modal.id = "chatWidgetPreviewModal";
    modal.className = "chat-widget-preview-modal";
    modal.style.position = "fixed";
    modal.style.top = "0";
    modal.style.left = "0";
    modal.style.right = "0";
    modal.style.bottom = "0";
    modal.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
    modal.style.display = "flex";
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.zIndex = "2147483648";
    modal.onclick = (e) => {
      if (e.target === modal) {
        closePreviewModal();
      }
    };

    const modalContent = document.createElement("div");
    modalContent.className = "chat-widget-preview-content";
    modalContent.style.backgroundColor = "#ffffff";
    modalContent.style.borderRadius = "12px";
    modalContent.style.padding = "20px";
    modalContent.style.maxWidth = "90vw";
    modalContent.style.maxHeight = "90vh";
    modalContent.style.overflow = "auto";
    modalContent.style.position = "relative";
    modalContent.style.boxShadow = "0 8px 30px rgba(0, 0, 0, 0.3)";
    modalContent.onclick = (e) => e.stopPropagation();

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.innerHTML = "&times;";
    closeBtn.style.position = "absolute";
    closeBtn.style.top = "10px";
    closeBtn.style.right = "10px";
    closeBtn.style.width = "32px";
    closeBtn.style.height = "32px";
    closeBtn.style.border = "none";
    closeBtn.style.backgroundColor = "transparent";
    closeBtn.style.fontSize = "24px";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.color = "#6b7280";
    closeBtn.style.borderRadius = "50%";
    closeBtn.style.display = "flex";
    closeBtn.style.alignItems = "center";
    closeBtn.style.justifyContent = "center";
    closeBtn.onmouseenter = () => {
      closeBtn.style.backgroundColor = "#f3f4f6";
    };
    closeBtn.onmouseleave = () => {
      closeBtn.style.backgroundColor = "transparent";
    };
    closeBtn.onclick = closePreviewModal;

    if (previewMedia) {
      const previewContainer = document.createElement("div");
      previewContainer.style.display = "flex";
      previewContainer.style.flexDirection = "column";
      previewContainer.style.gap = "16px";
      previewContainer.style.alignItems = "center";

      if (previewMedia.isLoading) {
        const loadingDiv = document.createElement("div");
        loadingDiv.style.padding = "40px";
        loadingDiv.style.textAlign = "center";
        loadingDiv.innerHTML = `
          <div style="width: 32px; height: 32px; border: 3px solid #e5e7eb; border-top-color: ${settings.appearance.gradientColor1 || settings.appearance.primaryColor || "#912FF5"}; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 12px;"></div>
          <div style="color: #6b7280; font-size: 14px;">Loading media...</div>
        `;
        previewContainer.appendChild(loadingDiv);
      } else if (previewMedia.error) {
        const errorDiv = document.createElement("div");
        errorDiv.style.padding = "40px";
        errorDiv.style.textAlign = "center";
        errorDiv.style.color = "#ef4444";
        errorDiv.innerHTML = `
          <div style="font-size: 14px;">Failed to load media</div>
        `;
        previewContainer.appendChild(errorDiv);
      } else if (previewMedia.url) {
        if (previewMedia.mediaType === "image") {
          const img = document.createElement("img");
          img.src = previewMedia.url;
          img.style.maxWidth = "100%";
          img.style.maxHeight = "70vh";
          img.style.borderRadius = "8px";
          img.style.objectFit = "contain";
          previewContainer.appendChild(img);
        } else if (previewMedia.mediaType === "video") {
          const video = document.createElement("video");
          video.src = previewMedia.url;
          video.controls = true;
          video.style.maxWidth = "100%";
          video.style.maxHeight = "70vh";
          video.style.borderRadius = "8px";
          previewContainer.appendChild(video);
        } else if (previewMedia.mediaType === "audio") {
          const audio = document.createElement("audio");
          audio.src = previewMedia.url;
          audio.controls = true;
          audio.style.width = "100%";
          previewContainer.appendChild(audio);
        } else {
          const fileLink = document.createElement("a");
          fileLink.href = previewMedia.url;
          fileLink.target = "_blank";
          fileLink.style.display = "inline-block";
          fileLink.style.padding = "12px 20px";
          fileLink.style.backgroundColor =
            settings.appearance.gradientColor1 ||
            settings.appearance.primaryColor ||
            "#912FF5";
          fileLink.style.color = "#ffffff";
          fileLink.style.borderRadius = "6px";
          fileLink.style.textDecoration = "none";
          fileLink.style.fontSize = "14px";
          fileLink.style.fontWeight = "500";
          fileLink.textContent = `Download ${previewMedia.filename}`;
          previewContainer.appendChild(fileLink);
        }

        if (previewMedia.caption) {
          const captionDiv = document.createElement("div");
          captionDiv.style.textAlign = "center";
          captionDiv.style.color = "#6b7280";
          captionDiv.style.fontSize = "14px";
          captionDiv.style.marginTop = "8px";
          captionDiv.textContent = previewMedia.caption;
          previewContainer.appendChild(captionDiv);
        }
      }

      modalContent.appendChild(previewContainer);
    }

    modalContent.appendChild(closeBtn);
    modal.appendChild(modalContent);
    host.shadowRoot.appendChild(modal);
  }

  /**
   * Close preview modal
   */
  function closePreviewModal() {
    previewMedia = null;

    const host = document.getElementById("unibox-root");
    if (host && host.shadowRoot) {
      const modal = host.shadowRoot.getElementById("chatWidgetPreviewModal");
      if (modal) {
        modal.remove();
      }
    }
  }

  function formatTimestamp(timestamp, showReadReceipt = false) {
    if (!timestamp) return "";
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);

    if (showReadReceipt) {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, "0");
      const ampm = hours >= 12 ? "PM" : "AM";
      hours = hours % 12;
      hours = hours ? hours : 12;
      const hoursStr = hours.toString().padStart(2, "0");
      return `${hoursStr}:${minutes} ${ampm}`;
    }

    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    hours = hours || 12;
    const hoursStr = hours.toString().padStart(2, "0");
    const day = date.getDate();
    const month = date.toLocaleString("default", { month: "short" });
    return `${day} ${month}, ${hoursStr}:${minutes} ${ampm}`;
  }

  function getReadReceiptIcon(status, readAt, readByUs, readByUsAt, sender) {
    // Logic disabled in original
    return "";
  }

  // Helper function to check if a message is a welcome message
  function isWelcomeMessage(text) {
    if (!text) return false;
    const welcomeText =
      settings.appearance.header?.welcomeMessage ||
      settings.appearance.welcomeMessage;
    if (!welcomeText) return false;
    return text.trim().toLowerCase() === welcomeText.trim().toLowerCase();
  }

  // --- UPDATED APPEND MESSAGE FUNCTION WITH FIX ---
  function appendMessageToUI(
    text,
    type,
    messageId,
    timestamp,
    status,
    readAt,
    readByUs,
    readByUsAt,
    messageType,
    mediaStorageUrl,
  ) {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    // Normalize text - handle null/undefined/empty string
    // Convert empty string to null for consistent handling
    const normalizedText = text && text.trim() ? text.trim() : null;

    // Handle welcome message replacement: if static welcome is shown and this is a real welcome message,
    // REPLACE the static welcome with the real one (which has a real server message ID)
    if (
      staticWelcomeShown &&
      type === "agent" &&
      normalizedText &&
      isWelcomeMessage(normalizedText) &&
      messageId &&
      !messageId.startsWith("static_welcome_") // Only replace if this is a REAL message ID
    ) {
      // Find and remove the static welcome message
      const staticWelcome = Array.from(messages.values()).find(
        (msg) => msg.id && msg.id.startsWith("static_welcome_"),
      );
      if (staticWelcome) {
        if (staticWelcome.element) {
          staticWelcome.element.remove();
        }
        messages.delete(staticWelcome.id);
        // Save the real welcome message ID for read receipts
        realWelcomeMessageId = messageId;
        console.log(
          "UniBox: Replaced static welcome with real welcome message ID:",
          messageId,
        );
      }
      staticWelcomeShown = false;
      // Continue to add the real welcome message below
    }

    const normalizedId = messageId || `msg_${Date.now()}`;
    const normalizedTimestamp = timestamp
      ? new Date(timestamp).getTime()
      : Date.now();

    // Debug: Log message being added
    console.log("UniBox: appendMessageToUI called:", {
      id: normalizedId,
      text: normalizedText?.substring(0, 30),
      sender: type,
      timestamp: normalizedTimestamp,
      timestampDate: new Date(normalizedTimestamp).toISOString(),
    });

    // --- FIX: Robust Deduplication Logic ---
    const existingInMap =
      messages.get(normalizedId) ||
      Array.from(messages.values()).find((m) => {
        // 1. Exact ID Match
        if (m.id === normalizedId || m.messageId === normalizedId) return true;

        // 2. Media Match
        if (mediaStorageUrl && m.mediaStorageUrl === mediaStorageUrl) {
          return (
            Math.abs(new Date(m.timestamp).getTime() - normalizedTimestamp) <
            10000
          );
        }

        // 3. Text + Timestamp Fuzzy Match (Fixes ghosting)
        // Check if text matches, sender matches, and time is within 30 seconds
        if (normalizedText && m.text === normalizedText && m.sender === type) {
          const timeDiff = Math.abs(
            new Date(m.timestamp).getTime() - normalizedTimestamp,
          );
          if (timeDiff < 30000) {
            // If we found a match by text, update the ID map so future lookups find it by ID
            if (messageId && m.id !== messageId) {
              // Update internal tracking object to use the real Server ID
              const oldId = m.id;

              // Update map
              messages.delete(oldId);
              m.id = messageId;
              m.messageId = messageId;
              m.status = status || m.status;
              m.timestamp = timestamp || m.timestamp; // Update timestamp to server's timestamp
              messages.set(messageId, m);

              // Update DOM attributes for proper sorting
              if (m.element) {
                m.element.setAttribute("data-message-id", messageId);
                // CRITICAL: Update data-timestamp to server's timestamp for correct sorting
                m.element.setAttribute(
                  "data-timestamp",
                  normalizedTimestamp.toString(),
                );
              }
            }
            return true;
          }
        }
        return false;
      });

    if (existingInMap && existingInMap.element) {
      existingInMap.status = status || existingInMap.status;
      existingInMap.readAt = readAt || existingInMap.readAt;
      existingInMap.readByUs =
        readByUs !== undefined ? readByUs : existingInMap.readByUs;
      existingInMap.readByUsAt = readByUsAt || existingInMap.readByUsAt;

      // CRITICAL: Update timestamp if server provided one (for correct sorting)
      if (timestamp && existingInMap.element) {
        existingInMap.timestamp = timestamp;
        existingInMap.element.setAttribute(
          "data-timestamp",
          normalizedTimestamp.toString(),
        );
      }
      return;
    }

    const existingInDOM = Array.from(body.children).find((child) => {
      const childId = child.getAttribute("data-message-id");
      if (childId === normalizedId) return true;
      return false;
    });

    if (existingInDOM) {
      if (normalizedId && !messages.has(normalizedId)) {
        messages.set(normalizedId, {
          id: normalizedId,
          messageId: normalizedId,
          text: normalizedText,
          sender: type,
          timestamp: timestamp || new Date(),
          status: status || "sent",
          readAt,
          readByUs: readByUs || false,
          readByUsAt,
          type: messageType,
          mediaStorageUrl: mediaStorageUrl,
          element: existingInDOM,
        });
      }
      return;
    }

    // CREATE MESSAGE ELEMENTS WITH NEW CLASSES
    const msgDiv = document.createElement("div");
    msgDiv.className = `chat-widget-message ${
      type === "agent" ? "bot" : "user"
    }`;
    msgDiv.setAttribute("data-message-id", normalizedId);
    msgDiv.setAttribute("data-timestamp", normalizedTimestamp.toString());

    if (type === "agent") {
      const labelEl = document.createElement("div");
      labelEl.className = "chat-widget-message-label";
      labelEl.textContent = "Pulse AI";
      msgDiv.appendChild(labelEl);
    }

    const msgContent = document.createElement("div");
    msgContent.className = "chat-widget-message-content";

    // Handle media messages - show as chips/buttons instead of loading directly
    // Check if this is a media message (has type and media_storage_url)
    const isMediaMessage =
      messageType &&
      ["image", "video", "audio", "document", "file"].includes(messageType);
    const hasMedia =
      isMediaMessage && mediaStorageUrl && mediaStorageUrl.trim() !== "";

    // Ensure media messages are always rendered, even with empty/null text
    if (hasMedia) {
      // Show media as a clickable chip/button instead of loading directly
      const getMediaIcon = (type) => {
        if (type === "image") {
          return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>`;
        } else if (type === "video") {
          return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="23 7 16 12 23 17 23 7"></polygon>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
          </svg>`;
        } else if (type === "audio") {
          return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          </svg>`;
        } else {
          return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
          </svg>`;
        }
      };

      const getMediaLabel = (type, textValue, mediaKey) => {
        // Use text if available and not an upload message
        if (
          textValue &&
          textValue !== "Uploading..." &&
          !textValue.includes("Uploading")
        ) {
          return textValue;
        }
        // Don't show filename for blob URLs or s3 keys
        if (
          mediaKey &&
          (mediaKey.startsWith("blob:") ||
            mediaKey.startsWith("live-chat-media/"))
        ) {
          const labels = {
            image: "Image",
            video: "Video",
            audio: "Audio",
            document: "Document",
            file: "File",
          };
          return labels[type] || "Media";
        }
        // Extract filename from media key if available
        const fileName = mediaKey ? mediaKey.split("/").pop() : null;
        const labels = {
          image: "Image",
          video: "Video",
          audio: "Audio",
          document: "Document",
          file: "File",
        };
        return fileName || labels[type] || "Media";
      };

      // Always show media as a clickable chip (same as agent side)
      const mediaChip = document.createElement("button");
      mediaChip.className = "chat-widget-media-chip";
      mediaChip.type = "button";
      mediaChip.style.display = "flex";
      mediaChip.style.alignItems = "center";
      mediaChip.style.gap = "8px";
      mediaChip.style.padding = "10px 12px";
      mediaChip.style.backgroundColor =
        type === "agent" ? "#F5F5F5" : "#E8DFF8";
      mediaChip.style.border = "1px solid #e5e7eb";
      mediaChip.style.borderRadius = "8px";
      mediaChip.style.cursor = "pointer";
      mediaChip.style.transition = "all 0.2s";
      mediaChip.style.width = "100%";
      mediaChip.style.textAlign = "left";
      mediaChip.style.color = "#18181e";
      mediaChip.style.fontSize = "14px";
      mediaChip.style.fontFamily = settings.appearance.fontFamily;
      mediaChip.style.minHeight = "40px"; // Ensure minimum height for visibility
      mediaChip.onmouseenter = () => {
        mediaChip.style.backgroundColor =
          type === "agent" ? "#e9ecef" : "#ddd4f0";
        mediaChip.style.transform = "translateY(-1px)";
      };
      mediaChip.onmouseleave = () => {
        mediaChip.style.backgroundColor =
          type === "agent" ? "#F5F5F5" : "#E8DFF8";
        mediaChip.style.transform = "translateY(0)";
      };
      mediaChip.onclick = () => {
        showMediaPreview(mediaStorageUrl, messageType, normalizedText);
      };

      const iconDiv = document.createElement("div");
      iconDiv.style.display = "flex";
      iconDiv.style.alignItems = "center";
      iconDiv.style.justifyContent = "center";
      iconDiv.style.color =
          (settings.appearance.gradientColor1 ||
            settings.appearance.primaryColor ||
            "#912FF5");
      iconDiv.style.flexShrink = "0";
      iconDiv.innerHTML = getMediaIcon(messageType);

      const labelDiv = document.createElement("div");
      labelDiv.style.flex = "1";
      labelDiv.style.minWidth = "0";
      labelDiv.style.wordBreak = "break-word";
      labelDiv.textContent = getMediaLabel(
        messageType,
        normalizedText,
        mediaStorageUrl,
      );

      mediaChip.appendChild(iconDiv);
      mediaChip.appendChild(labelDiv);
      msgContent.appendChild(mediaChip);

      // Add text caption if available and not the file name
      if (
        normalizedText &&
        normalizedText !== "Uploading..." &&
        !normalizedText.includes("Uploading") &&
        messageType !== "document" &&
        messageType !== "file"
      ) {
        const captionDiv = document.createElement("div");
        captionDiv.className = "chat-widget-media-caption";
        captionDiv.textContent = normalizedText;
        captionDiv.style.marginTop = "8px";
        captionDiv.style.fontSize = "14px";
        captionDiv.style.lineHeight = "1.5";
        captionDiv.style.color = "#18181e";
        msgContent.appendChild(captionDiv);
      }

      // Store message data with media info
      if (normalizedId) {
        const messageData = {
          id: normalizedId,
          messageId: normalizedId,
          text: normalizedText,
          sender: type,
          timestamp: timestamp || new Date(),
          status: status || "sent",
          readAt,
          readByUs: readByUs || false,
          readByUsAt,
          type: messageType,
          mediaStorageUrl: mediaStorageUrl,
          element: msgDiv,
        };
        messages.set(normalizedId, messageData);
      }

      msgDiv.appendChild(msgContent);

      // Insert message BEFORE typing indicator (so indicator stays at the end)
      const typingIndicator = body.querySelector("#typingIndicator");
      if (typingIndicator) {
        body.insertBefore(msgDiv, typingIndicator);
      } else {
        body.appendChild(msgDiv);
      }

      requestAnimationFrame(() => {
        body.scrollTop = body.scrollHeight;
      });
      return; // Don't continue with text message logic
    }

    // Handle text messages (non-media)
    if (!hasMedia) {
      // Only set text content if we have text (don't set empty string for null)
      if (normalizedText) {
        msgContent.textContent = normalizedText;
      } else {
        // Empty message with no media - don't render the message at all
        return; // Don't append empty messages
      }
    }

    // Only append if we have content (text or media)
    if (!hasMedia && !normalizedText) {
      return; // Safety check - don't render empty messages
    }

    msgDiv.appendChild(msgContent);

    const msgMeta = document.createElement("div");
    msgMeta.className = "chat-widget-message-meta";

    // Only append meta if there is something inside, otherwise we get empty margin space
    if (msgMeta.hasChildNodes()) {
      msgDiv.appendChild(msgMeta);
    }

    // Store message data (for text messages only - media messages are stored above)
    if (!hasMedia && normalizedId) {
      const messageData = {
        id: normalizedId,
        messageId: normalizedId,
        text: normalizedText,
        sender: type,
        timestamp: timestamp || new Date(),
        status: status || "sent",
        readAt,
        readByUs: readByUs || false,
        readByUsAt,
        type: messageType,
        mediaStorageUrl: mediaStorageUrl,
        element: msgDiv,
      };
      messages.set(normalizedId, messageData);
      if (messageId && normalizedId !== messageId) {
        messages.set(messageId, messageData);
      }
    }

    // Insert message BEFORE typing indicator (so indicator stays at the end)
    const typingIndicator = body.querySelector("#typingIndicator");
    if (typingIndicator) {
      body.insertBefore(msgDiv, typingIndicator);
    } else {
      body.appendChild(msgDiv);
    }

    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  function sortMessagesByTimestamp() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    const messageElements = Array.from(body.children).filter((child) => {
      return child.hasAttribute("data-timestamp");
    });

    // Debug: Log timestamps before sorting
    if (messageElements.length > 0) {
      console.log(
        "UniBox: Sorting messages by timestamp:",
        messageElements.map((el) => ({
          id: el.getAttribute("data-message-id"),
          timestamp: el.getAttribute("data-timestamp"),
          text: el
            .querySelector(".chat-widget-message-content")
            ?.textContent?.substring(0, 30),
        })),
      );
    }

    messageElements.sort((a, b) => {
      const timestampA = parseInt(a.getAttribute("data-timestamp") || "0");
      const timestampB = parseInt(b.getAttribute("data-timestamp") || "0");
      return timestampA - timestampB;
    });

    // Get typing indicator to keep it at the end
    const typingIndicator = body.querySelector("#typingIndicator");

    // Re-append messages in sorted order BEFORE typing indicator
    messageElements.forEach((element) => {
      if (typingIndicator) {
        body.insertBefore(element, typingIndicator);
      } else {
        body.appendChild(element);
      }
    });

    // Ensure typing indicator is always last
    if (typingIndicator) {
      body.appendChild(typingIndicator);
    }

    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  function updateReadReceipt(receipt) {
    return;
  }

  /**
   * Mark messages as read - User MUST send read receipts to agent
   * User does NOT receive read receipts from agent
   * ALL status updates go via WebSocket only - no HTTP API calls
   */
  function markMessagesAsRead(messageIds) {
    if (!conversationId || !userId || settings.testMode) return;
    if (!messageIds || messageIds.length === 0) return;

    // Filter out client-side generated IDs (not real server message IDs)
    // Real message IDs are UUIDs, not prefixed strings
    const validMessageIds = messageIds.filter((id) => {
      if (!id || typeof id !== "string") return false;
      // Exclude client-side generated IDs
      if (id.startsWith("static_welcome_")) return false;
      if (id.startsWith("guest_")) return false;
      if (id.startsWith("user_")) return false;
      if (id.startsWith("temp_")) return false;
      if (id.startsWith("optimistic_")) return false;
      return true;
    });

    if (validMessageIds.length === 0) {
      console.log("UniBox: No valid message IDs to mark as read");
      return;
    }

    // Send read receipt via WebSocket ONLY
    const sent = wsSend({
      action: "read",
      conversationId: conversationId,
      messageIds: validMessageIds,
    });

    if (sent) {
      console.log(
        "UniBox: Read receipt sent via WebSocket for",
        validMessageIds.length,
        "messages",
      );
    } else {
      console.log("UniBox: Read receipt queued (WebSocket not ready)");
    }
  }

  function markVisibleMessagesAsRead() {
    if (!conversationId || !userId || settings.testMode) return;
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    const unreadAgentMessages = Array.from(messages.values())
      .filter((msg) => {
        return msg.sender === "agent" && (msg.status !== "read" || !msg.readAt);
      })
      .map((msg) => msg.id || msg.messageId)
      .filter((id) => {
        // Filter out null/undefined IDs and client-side static welcome message IDs
        if (!id) return false;
        if (typeof id === "string" && id.startsWith("static_welcome_"))
          return false;
        return true;
      });

    if (unreadAgentMessages.length > 0) {
      markMessagesAsRead(unreadAgentMessages);
    }
  }

  function updateOnlineStatus(isOnline, isAgent) {
    if (isAgent) {
      isAgentOnline = isOnline;
      updateOnlineStatusIndicator();
    }
  }

  function updateOnlineStatusIndicator() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const statusIndicator = host.shadowRoot.getElementById(
      "onlineStatusIndicator",
    );
    if (statusIndicator) {
      statusIndicator.textContent = isAgentOnline ? "● Online" : "○ Offline";
      statusIndicator.className = `chat-widget-online-status ${
        isAgentOnline ? "online" : "offline"
      }`;
    }
  }

  function showTypingIndicator(show) {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const typingIndicator = host.shadowRoot.getElementById("typingIndicator");
    if (typingIndicator) {
      if (show) {
        typingIndicator.classList.remove("hidden");
        const body = host.shadowRoot.getElementById("chatBody");
        if (body) {
          requestAnimationFrame(() => {
            body.scrollTop = body.scrollHeight;
          });
        }
      } else {
        typingIndicator.classList.add("hidden");
      }
    }
  }

  /**
   * Emit typing status to agent via WebSocket
   * User MUST send typing indicators to agent
   */
  function emitTypingStatus(typing) {
    if (!conversationId || !userId) return;

    wsSend({
      action: "typing",
      conversationId: conversationId,
      isTyping: typing,
    });
  }

  // --- 10. UI RENDERING ---
  function renderWidget() {
    const host = document.createElement("div");
    host.id = "unibox-root";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    // Styles variables: 3-colour gradient (backward compat: fallback to primaryColor if set)
    const fallback = settings.appearance.primaryColor;
    const c1 =
      settings.appearance.gradientColor1 || fallback || "#912FF5";
    const c2 =
      settings.appearance.gradientColor2 || fallback || "#EF32D4";
    const c3 =
      settings.appearance.gradientColor3 || fallback || "#7DBCFE";
    const gradientCss = `linear-gradient(272.16deg, ${c1} 0.45%, ${c2} 45.12%, ${c3} 99.8%)`;
    const accentColor = c1;
    const launcherBg = "#FFFFFF";

    const placement = settings.behavior.stickyPlacement || "bottom-right";
    const isTop = placement.includes("top");
    const isRight = placement.includes("right");
    const launcherSize = 48;
    const gap = 16;
    const horizontalLauncherCss = isRight ? "right: 32px;" : "left: 32px;";
    const horizontalWindowCss = isRight
      ? `right: ${32 + launcherSize + gap}px;`
      : `left: ${32 + launcherSize + gap}px;`;
    const verticalCss = isTop ? "top: 32px;" : "bottom: 32px;";

    const getRadius = (style) => {
      if (style === "rounded") return "10px";
      if (style === "square") return "0px";
      return "50%";
    };
    const launcherRadius = getRadius(settings.appearance.chatToggleIcon.style);
    const headerLogoRadius =
      settings.appearance.iconStyle === "round" ? "50%" : "8px";

    const styleTag = document.createElement("style");

    // Updated CSS to match the provided JSX UI exactly
    styleTag.textContent = `
        :host {
          font-family: ${settings.appearance.fontFamily} !important;
        }
        
        /* Note: Container set to fixed to ensure it floats above page content as a widget */
        .chat-widget-container {
          position: fixed; z-index: 2147483647; 
          top: auto; bottom: auto; left: auto; right: auto;
          width: 0; height: 0;
          font-family: ${settings.appearance.fontFamily};
          display: block;
        }

        .chat-widget-container *,
        .chat-widget-header,
        .chat-widget-header *,
        .chat-widget-body,
        .chat-widget-body *,
        .chat-widget-footer,
        .chat-widget-footer *,
        .chat-widget-input,
        .chat-widget-form-input,
        .chat-widget-form-btn {
          font-family: ${settings.appearance.fontFamily} !important;
          box-sizing: border-box;
        }

        .chat-widget-launcher {
          position: fixed; ${verticalCss} ${horizontalLauncherCss}
          width: 48px;
          height: 48px;
          padding: 0;
          background: ${launcherBg};
          border-radius: ${launcherRadius};
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.15);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s;
          overflow: hidden;
          z-index: 2147483647;
        }
        .chat-widget-launcher svg,
        .chat-widget-launcher img {
          width: 100%;
          height: 100%;
          display: block;
          flex-shrink: 0;
        }
        .chat-widget-launcher img {
          object-fit: cover;
        }

        .chat-widget-launcher:hover {
          transform: scale(1.05);
        }

        .chat-widget-launcher.open {
          background: ${gradientCss} !important;
        }

        .chat-widget-window {
          position: fixed; ${verticalCss} ${horizontalWindowCss}
          width: 424px;
          height: 668px;
          max-width: calc(100vw - 40px);
          max-height: calc(100vh - 120px);
          background: #ffffff;
          border-radius: 10px;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          opacity: 0;
          pointer-events: none;
          transform: ${
            isTop ? "translateY(-20px)" : "translateY(20px)"
          } scale(0.95);
          transition: all 0.25s ease;
          border: 1px solid rgba(0, 0, 0, 0.05);
          z-index: 2147483647;
        }

        .chat-widget-window.open {
          opacity: 1;
          pointer-events: auto;
          transform: translateY(0) scale(1);
        }

        .chat-widget-header {
          background: ${gradientCss};
          padding: 8px;
          height: 72px;
          color: #fff;
          display: flex;
          // align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .chat-widget-header-logo {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          object-fit: cover;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .chat-widget-header-logo-icon {
          width: 32px;
          height: 32px;
        }

        .chat-widget-header-title {
          font-weight: 600;
          font-size: 14px;
          flex: 1;
        }

        .chat-widget-online-status {
          font-size: 12px;
          margin-left: 8px;
          display: flex;
          align-items: center;
          gap: 4px;
          font-weight: 400;
          height: 10px;
          line-height: 10px;
        }

        .chat-widget-online-status.online {
          color: rgba(255,255,255,0.9);
        }

        .chat-widget-online-status.offline {
          color: rgba(255,255,255,0.7);
        }

        .chat-widget-body {
          flex: 1;
          padding: 16px;
          border-radius: 10px;
          overflow-y: auto;
          background-color: #ffffff;
          position: relative;
          top: -24px;
          display: flex;
          flex-direction: column;
        }

        .chat-widget-loader {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100%;
        }

        .chat-widget-loader-spinner {
          border: 3px solid #f3f3f3;
          border-top: 3px solid ${accentColor};
          border-radius: 50%;
          width: 24px;
          height: 24px;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        .chat-widget-message {
          max-width: 80%;
          margin-bottom: 16px;
          display: flex;
          flex-direction: column;
          align-items: flex-start; /* let width shrink to content */
        }

        .chat-widget-message.bot {
          align-self: flex-start;
        }

        .chat-widget-message.user {
          align-self: flex-end;
          margin-left: auto; /* push user messages to the right */
        }

        .chat-widget-message-content {
          display: inline-block;
          padding: 6px 10px;
          max-width: 100%;
        }

        .chat-widget-message.bot .chat-widget-message-content {
          background: #F5F5F5;
          color: #18181e;
          font-size: 14px;
          line-height: 20px;
          font-weight: 400;
          border-radius: 10px;
          border-top-left-radius: 0;
        }

        .chat-widget-message.user .chat-widget-message-content {
          background: #ECE1FF;
          color: #18181E;
          font-size: 14px;
          line-height: 20px;
          font-weight: 400;
          border-radius: 10px;
          border-bottom-right-radius: 0;
        }

        .chat-widget-message-label {
          font-size: 12px;
          color: #9DA2AB;
          margin-bottom: 8px;
          font-weight: 400;
        }

        .chat-widget-message.bot .chat-widget-message-label {
          align-self: flex-start;
        }

        .chat-widget-message.user .chat-widget-message-label {
          display: none;
        }

        .chat-widget-message-meta {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-top: 8px;
          font-size: 12px;
          justify-content: flex-end;
        }

        .chat-widget-message.user .chat-widget-message-meta {
          justify-content: flex-end;
        }

        .chat-widget-message.bot .chat-widget-message-meta {
          justify-content: flex-start;
        }

        .chat-widget-message-time {
          color: #18181e;
          font-size: 12px;
          font-weight: 400;
          line-height: 16px;
        }

        .chat-widget-tooltip {
          position: absolute;
          height: 26px;
          opacity: 0;
          pointer-events: none;
          border-radius: 4px;
          padding: 5px 7px;
          background: #18181e;
          color: #ffffff;
          font-size: 12px;
          line-height: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          white-space: nowrap;
          box-shadow: 0px 2px 7px 0px #0000001f;
          transition: opacity 0.15s ease;
          z-index: 10;
        }

        .chat-widget-tooltip.visible {
          opacity: 1;
        }

        .chat-widget-tooltip-arrow {
          position: absolute;
          top: -10px;
          left: 50%;
          transform: translateX(-50%);
          width: 15px;
          height: 10px;
        }

        .chat-widget-tooltip-arrow::before {
          content: "";
          position: absolute;
          left: 0;
          top: 0;
          width: 0;
          height: 0;
          border-left: 7.5px solid transparent;
          border-right: 7.5px solid transparent;
          border-bottom: 10px solid #18181e;
        }

        .chat-widget-read-receipt {
          display: inline-flex;
          align-items: center;
          margin-right: 4px;
        }
        
        .chat-widget-read-receipt-icon {
          display: inline-block;
          vertical-align: middle;
          flex-shrink: 0;
        }

        .chat-widget-typing-indicator {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 14px 16px;
          background: #F5F5F5;
          border-radius: 12px;
          border-top-left-radius: 0;
          margin: 8px 0;
          max-width: 80px;
          align-self: flex-start;
        }

        .chat-widget-typing-indicator.hidden {
          display: none;
        }

        .chat-widget-typing-dot {
          width: 8px;
          height: 8px;
          background: #9ca3af;
          border-radius: 50%;
          animation: typing 1.4s infinite;
        }

        .chat-widget-typing-dot:nth-child(2) {
          animation-delay: 0.2s;
        }

        .chat-widget-typing-dot:nth-child(3) {
          animation-delay: 0.4s;
        }

        @keyframes typing {
          0%,
          60%,
          100% {
            transform: translateY(0);
            opacity: 0.7;
          }
          30% {
            transform: translateY(-10px);
            opacity: 1;
          }
        }

        .chat-widget-form-container {
          display: flex;
          flex-direction: column;
          gap: 15px;
          background: #ffffff;
          padding: 24px;
          border-radius: 8px;
        }

        .chat-widget-form-input {
          width: 100%;
          padding: 10px;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          font-size: 14px;
        }

        .chat-widget-form-input:focus {
          outline: none;
          border-color: ${accentColor};
        }

        .chat-widget-form-btn {
          width: 100%;
          padding: 12px;
          background: ${accentColor};
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }

        .chat-widget-disclaimer {
          font-size: 14px;
          line-height: 16px;
          font-weight: 400;
          color: #9ca3af;
          text-align: center;
          margin: 0;
          padding: 8px;
          flex-shrink: 0;
        }

        .chat-widget-disclaimer.hidden {
          display: none;
        }

        .chat-widget-footer-section {
          flex-shrink: 0;
          background: #ffffff;
          border-radius: 0 0 12px 12px;
          box-shadow: 0px -1px 14px 0px #00000014;
        }

        .chat-widget-footer-section.hidden {
          display: none;
        }

        .chat-widget-footer {
          padding: 4px 8px;
          background: #ffffff;
          flex-shrink: 0;
        }

        .chat-widget-footer-row {
          display: flex;
          align-items: center;
          background: #F5F5F5;
          border-radius: 4px;
          padding: 8px;
          gap: 8px;
        }

        #fileChipsContainer {
          display: flex !important;
          flex-wrap: wrap;
          gap: 8px;
          padding: 12px 16px;
          border-bottom: 1px solid #e5e7eb;
          background-color: #ffffff;
        }

        .chat-widget-input-wrapper {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .chat-widget-attach-btn {
          cursor: pointer;
          display: flex;
          border: none;
          padding: 4px;
          align-items: center;
          justify-content: center;
          background: transparent;
        }

        .chat-widget-input {
          flex: 1;
          border: none;
          background: transparent;
          outline: none;
          font-size: 14px;
          color: #1f2937;
        }

        .chat-widget-send-btn {
          cursor: pointer;
          display: flex;
          border: none;
          padding: 0;
          align-items: center;
          justify-content: center;
        }

        .chat-widget-message-content img {
          display: block;
          max-width: 100%;
          height: auto;
        }

        .chat-widget-message-content video {
          display: block;
          max-width: 100%;
          height: auto;
        }

        .chat-widget-message-content audio {
          width: 100%;
          margin-top: 4px;
        }

        .chat-widget-media-image-container {
          display: inline-block;
          max-width: 100%;
        }

        .chat-widget-media-image {
          transition: transform 0.2s, opacity 0.2s;
          opacity: 0;
        }

        .chat-widget-media-image:hover {
          transform: scale(1.02);
        }

        .chat-widget-media-video-container {
          display: inline-block;
          max-width: 100%;
        }

        .chat-widget-media-audio-container {
          width: 100%;
        }

        .chat-widget-media-file-container {
          width: 100%;
          cursor: pointer;
        }

        .chat-widget-media-file-container:hover {
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .chat-widget-media-caption {
          word-break: break-word;
          white-space: pre-wrap;
        }

        .chat-widget-media-loading {
          animation: fadeIn 0.2s ease-in;
        }

        .chat-widget-media-error {
          animation: fadeIn 0.2s ease-in;
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        .chat-widget-media-chip {
          transition: all 0.2s ease;
          min-height: 40px;
          display: flex !important;
          visibility: visible !important;
        }

        .chat-widget-media-chip:hover {
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }

        .chat-widget-message-content:empty {
          display: none;
        }
        
        /* Ensure media chips are always visible */
        .chat-widget-message-content .chat-widget-media-chip {
          display: flex !important;
          visibility: visible !important;
          opacity: 1 !important;
        }

        .chat-widget-preview-modal {
          animation: fadeIn 0.2s ease-in;
        }

        .chat-widget-preview-content {
          animation: slideUp 0.3s ease-out;
        }

        @keyframes slideUp {
          from {
            transform: translateY(20px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }

        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
    `;

    const chatIcon = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="32" height="32" rx="16" transform="matrix(-1 0 0 1 32 0)" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M16.0005 2.5625C23.4233 2.5625 29.4405 8.57979 29.4405 16.0025C29.4405 23.4252 23.4233 29.4425 16.0005 29.4425C8.57784 29.4425 2.56055 23.4252 2.56055 16.0025C2.56055 8.57979 8.57784 2.5625 16.0005 2.5625ZM16.0005 3.60977C9.15623 3.60977 3.60782 9.15819 3.60782 16.0025C3.60782 22.8468 9.15623 28.3952 16.0005 28.3952C22.8449 28.3952 28.3933 22.8468 28.3933 16.0025C28.3933 9.15819 22.8449 3.60977 16.0005 3.60977Z" fill="url(#paint0_linear_3454_252289)"/>
<path d="M24.6986 11.5066C24.5218 10.9089 24.2263 10.4429 23.8319 10.1327C23.4154 9.80523 22.9049 9.65744 22.3206 9.71547C21.7937 9.76761 21.2089 9.99373 20.5868 10.4152L20.5573 10.4363C20.5511 10.441 17.8236 12.7353 17.8236 12.7353L18.5602 13.5205C18.5602 13.5205 21.0756 11.3966 21.2081 11.2935C21.6673 10.9851 22.0769 10.8219 22.4265 10.7872C22.7205 10.7582 22.9702 10.8269 23.1664 10.9811C23.3845 11.1525 23.5548 11.4338 23.6664 11.8107C23.8519 12.4379 23.8695 13.2938 23.6793 14.3285L23.6772 14.3413C23.6745 14.3579 23.0611 18.2028 22.8752 18.9969C22.6901 19.7877 22.4053 20.3927 22.0206 20.7699C21.821 20.9654 21.5915 21.0993 21.3319 21.164C21.0581 21.2324 20.742 21.2278 20.383 21.1436C19.329 20.8963 17.9725 19.9953 16.3004 18.2859L16.2898 18.2753L15.8948 17.8965L15.1465 18.6702L15.5418 19.05C17.3621 20.909 18.8947 21.9023 20.1382 22.194C20.6666 22.318 21.1503 22.3197 21.5887 22.2103C22.0413 22.0971 22.4364 21.8691 22.7748 21.5374C23.3106 21.0123 23.6929 20.23 23.9245 19.2412C24.1077 18.4592 24.707 14.711 24.7377 14.5182C24.959 13.3127 24.9295 12.2869 24.6986 11.5067V11.5066Z" fill="url(#paint1_linear_3454_252289)"/>
<path d="M13.6479 18.4093L14.2517 17.8029L15.0115 17.0405L16.9154 15.1311L17.1276 15.343L17.5651 13.7132L15.9324 14.1499L16.1535 14.3706L13.4742 17.0585L12.8921 17.6429L12.1719 18.3656L12.0675 18.4706L12.0611 18.477C11.4621 19.0968 10.8194 19.6911 10.2697 19.8292C9.86458 19.931 9.45724 19.6888 9.08324 18.7817C9.00007 18.4673 8.4387 16.3472 8.27409 15.7593C8.10887 15.103 8.12019 14.6058 8.2629 14.2716C8.34286 14.0844 8.46798 13.9532 8.62607 13.8814C8.80594 13.7993 9.04313 13.7816 9.32265 13.8313C9.95673 13.9444 10.7398 14.3931 11.5464 15.2108L11.5569 15.2214L12.5811 16.2023L13.3918 15.4877L12.3043 14.4465C11.3339 13.4657 10.3449 12.9186 9.5083 12.7696C9.01557 12.682 8.56247 12.7289 8.17875 12.9037C7.7735 13.0884 7.46027 13.4065 7.27093 13.8504C7.03915 14.3931 7.00151 15.1242 7.22726 16.0206L7.23144 16.0353C7.41143 16.6754 8.04945 19.0883 8.05117 19.0953L8.0615 19.1341L8.07245 19.1605C8.71231 20.7359 9.5842 21.1126 10.5314 20.8745C11.3379 20.6716 12.1259 19.9595 12.838 19.223L12.9219 19.1385L13.6481 18.4097L13.6479 18.4093Z" fill="url(#paint2_linear_3454_252289)"/>
<path d="M13.6514 18.4178L14.2546 17.8121L15.0136 17.0504L16.9153 15.143L17.1273 15.3546L17.5643 13.7266L15.9334 14.1628L16.1543 14.3833L13.4779 17.0684L12.8965 17.6522L12.1771 18.3742L12.0728 18.4791L12.0664 18.4854C11.468 19.1046 10.8244 19.6918 10.2769 19.8362C10.156 19.8681 10.0035 19.8724 9.84375 19.7988C9.84375 19.7988 9.26947 20.7471 9.31839 20.774C9.66642 20.9653 10.1114 20.9876 10.5381 20.8802C11.3438 20.6775 12.1309 19.9661 12.8422 19.2305L12.926 19.1461L13.6514 18.418V18.4178Z" fill="url(#paint3_linear_3454_252289)"/>
<defs>
<linearGradient id="paint0_linear_3454_252289" x1="29.4407" y1="26.0825" x2="1.76989" y2="25.0397" gradientUnits="userSpaceOnUse">
<stop stop-color="#EF32D4"/>
<stop offset="0.449646" stop-color="#912FF5"/>
<stop offset="1" stop-color="#7DBCFE"/>
</linearGradient>
<linearGradient id="paint1_linear_3454_252289" x1="7.84806" y1="19.7277" x2="24.6921" y2="15.2184" gradientUnits="userSpaceOnUse">
<stop stop-color="#7DBCFE"/>
<stop offset="0.6" stop-color="#912FF5"/>
<stop offset="1" stop-color="#EF32D4"/>
</linearGradient>
<linearGradient id="paint2_linear_3454_252289" x1="7.58231" y1="17.3497" x2="27.1331" y2="12.1016" gradientUnits="userSpaceOnUse">
<stop stop-color="#7DBCFE"/>
<stop offset="0.34" stop-color="#912FF5"/>
<stop offset="1" stop-color="#EF32D4"/>
</linearGradient>
<linearGradient id="paint3_linear_3454_252289" x1="8.76488" y1="18.7173" x2="26.8533" y2="13.8621" gradientUnits="userSpaceOnUse">
<stop stop-color="#21C8FF" stop-opacity="0"/>
<stop offset="0.09" stop-color="#21C8FF" stop-opacity="0.71"/>
<stop offset="0.14" stop-color="#21C8FF"/>
</linearGradient>
</defs>
</svg>`;

    const closeIcon = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M24 8L8 24" stroke="white" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8L24 24" stroke="white" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

    const container = document.createElement("div");
    container.className = "chat-widget-container";

    const headerTitle =
      settings.appearance.header?.title || settings.appearance.headerName;
    const headerLogoImg = resolvedLogoUrl
      ? `<img src="${resolvedLogoUrl}" class="chat-widget-header-logo" alt="Logo" />`
      : `<div class="chat-widget-header-logo" style="display:flex;align-items:center;justify-content:center;color:#7c3aed"><svg class="chat-widget-header-logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/><path d="M18 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg></div>`;

    const launcherContent = resolvedLogoUrl
      ? `<img src="${resolvedLogoUrl}" alt="Chat" />`
      : chatIcon;

    container.innerHTML = `
      <div class="chat-widget-launcher" id="launcherBtn">${launcherContent}</div>
      <div class="chat-widget-window" id="chatWindow">
        <div class="chat-widget-header">
           ${headerLogoImg}
           <div style="flex: 1; padding-top: 6px;">
             <div class="chat-widget-header-title">${headerTitle}</div>
             <!-- <div id="onlineStatusIndicator" class="chat-widget-online-status offline">○ Offline</div> -->
           </div>
           <!-- <div id="closeBtn" style="cursor:pointer; font-size:24px; opacity:0.8; line-height: 1;">&times;</div> -->
        </div>
        <div class="chat-widget-body" id="chatBody">
          <!-- Messages will be inserted here -->
          <!-- Typing indicator is appended at the end dynamically -->
        </div>
        <p class="chat-widget-disclaimer hidden" id="chatDisclaimer">*AI-generated content may be inaccurate.</p>
        <div class="chat-widget-footer-section hidden" id="chatFooterSection">
           <div class="chat-widget-footer" id="chatFooter">
             <div class="chat-widget-footer-row">
             <div class="chat-widget-input-wrapper">
               <input type="file" id="fileInput" style="display: none;" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx" multiple />
               <button class="chat-widget-attach-btn" id="attachBtn" title="Attach file">
                 <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="0.75" stroke-linecap="round" stroke-linejoin="round">
                   <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                 </svg>
               </button>
               <input type="text" class="chat-widget-input" id="msgInput" placeholder="Type your message here.." />
             </div>
             <button class="chat-widget-send-btn" id="sendBtn">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M13.5822 12H6.45106C6.45106 11.7556 6.39979 11.5112 6.29815 11.2819L4.16007 6.50225C3.47646 4.97361 5.11173 3.44319 6.61926 4.19951L19.0151 10.4154C20.3283 11.0731 20.3283 12.927 19.0151 13.5847L6.62016 19.8006C5.11173 20.5569 3.47646 19.0256 4.16007 17.4978L6.29635 12.7181C6.39732 12.4919 6.4494 12.2473 6.44926 12" stroke="#18181E" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
             </button>
             </div>
           </div>
        </div>
      </div>
    `;

    shadow.appendChild(styleTag);
    shadow.appendChild(container);

    // --- 11. VIEW LOGIC ---
    const isFormEnabled = settings.preChatForm.enabled;
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    let currentView = isFormEnabled && !hasSubmittedForm ? "form" : "chat";

    const renderView = () => {
      const body = shadow.getElementById("chatBody");
      const disclaimer = shadow.getElementById("chatDisclaimer");
      const footerSection = shadow.getElementById("chatFooterSection");
      const footer = shadow.getElementById("chatFooter");
      body.innerHTML = "";

      // Clear body and add typing indicator at the END
      // Typing indicator should always be the LAST element in chat body
      body.innerHTML = "";

      // Create typing indicator (will be appended at the end after messages are loaded)
      const typingIndicator = document.createElement("div");
      typingIndicator.className = "chat-widget-typing-indicator hidden";
      typingIndicator.id = "typingIndicator";
      typingIndicator.innerHTML = `
        <div class="chat-widget-typing-dot"></div>
        <div class="chat-widget-typing-dot"></div>
        <div class="chat-widget-typing-dot"></div>
      `;
      body.appendChild(typingIndicator);

      if (currentView === "form") {
        if (disclaimer) disclaimer.classList.add("hidden");
        footerSection.classList.add("hidden");

        const fieldsHtml = settings.preChatForm.fields
          .map((f) => {
            let inputHtml = "";
            const isRequired = f.required ? "required" : "";

            if (f.type === "textarea") {
              inputHtml = `<textarea class="chat-widget-form-input" name="${f.id}" ${isRequired} placeholder="${f.label}"></textarea>`;
            } else {
              const inputType = f.type === "phone" ? "tel" : f.type;
              inputHtml = `<input class="chat-widget-form-input" type="${inputType}" name="${f.id}" ${isRequired} placeholder="${f.label}">`;
            }

            return `
            <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px;">${f.label}${
                f.required ? ' <span style="color:red">*</span>' : ""
              }</label>
              ${inputHtml}
            </div>
          `;
          })
          .join("");

        const formContainer = document.createElement("div");
        formContainer.className = "chat-widget-form-container";
        formContainer.innerHTML = `
          <div style="text-align:center; margin-bottom:5px; font-weight:600; font-size:14px; color:#111;">Welcome</div>
          <div style="text-align:center; margin-bottom:20px; font-size:14px; color:#666;">Please fill in your details to continue.</div>
          <form id="preChatForm">
            ${fieldsHtml}
            <button type="submit" class="chat-widget-form-btn">Start Chat</button>
          </form>
        `;
        body.appendChild(formContainer);

        const formEl = formContainer.querySelector("#preChatForm");
        formEl.addEventListener("submit", (e) => {
          e.preventDefault();
          const formData = new FormData(formEl);
          const data = Object.fromEntries(formData.entries());

          let capturedName = "";
          let capturedEmail = "";

          settings.preChatForm.fields.forEach((field) => {
            const val = data[field.id];
            if (!val) return;
            if (
              field.type === "text" &&
              (field.label.toLowerCase().includes("name") ||
                field.id.toLowerCase().includes("name"))
            )
              capturedName = val;
            if (
              field.type === "email" ||
              field.id.toLowerCase().includes("email")
            )
              capturedEmail = val;
          });

          if (!capturedName && capturedEmail) capturedName = capturedEmail;

          sessionStorage.setItem(SESSION_KEY_FORM, "true");
          if (capturedName)
            sessionStorage.setItem(`${SESSION_KEY_FORM}_name`, capturedName);
          if (capturedEmail)
            sessionStorage.setItem(`${SESSION_KEY_FORM}_email`, capturedEmail);

          currentView = "chat";
          renderView();
        });
      } else {
        if (disclaimer) disclaimer.classList.remove("hidden");
        footerSection.classList.remove("hidden");

        // Re-render file chips if there are selected files
        if (selectedFiles.length > 0) {
          setTimeout(() => renderFileChips(), 50);
        }

        // Show welcome message if not already shown and no messages exist
        if (!staticWelcomeShown) {
          const welcomeText =
            settings.appearance.header?.welcomeMessage ||
            settings.appearance.welcomeMessage;
          if (welcomeText) {
            // Check if there are any existing messages
            const hasMessages = Array.from(messages.values()).length > 0;
            if (!hasMessages) {
              appendMessageToUI(
                welcomeText,
                "agent",
                `static_welcome_${Date.now()}`,
                new Date(),
                "sent",
                null,
                false,
                null,
                "text",
                undefined,
              );
              staticWelcomeShown = true;
            }
          }
        }
      }
    };

    renderView();

    // --- 12. EVENTS ---
    const launcher = shadow.getElementById("launcherBtn");
    const windowEl = shadow.getElementById("chatWindow");
    const closeBtn = shadow.getElementById("closeBtn");
    const sendBtn = shadow.getElementById("sendBtn");
    const msgInput = shadow.getElementById("msgInput");
    const attachBtn = shadow.getElementById("attachBtn");
    const fileInput = shadow.getElementById("fileInput");

    const updateLauncherIcon = (isOpen) => {
      if (isOpen) {
        launcher.classList.add("open");
        launcher.innerHTML = closeIcon;
      } else {
        launcher.classList.remove("open");
        launcher.innerHTML = launcherContent;
      }
    };

    const toggle = (forceState) => {
      const isOpen = windowEl.classList.contains("open");
      const nextState = forceState !== undefined ? forceState : !isOpen;

      if (nextState) windowEl.classList.add("open");
      else windowEl.classList.remove("open");

      updateLauncherIcon(nextState);

      if (settings.behavior.stickyPlacement) {
        localStorage.setItem(STORAGE_KEY_OPEN, nextState);
      }
    };

    launcher.addEventListener("click", () => toggle());
    if (closeBtn) closeBtn.addEventListener("click", () => toggle(false));

    const handleSend = () => {
      const text = msgInput.value.trim();

      // If there are selected files, send them with caption
      if (selectedFiles.length > 0) {
        sendSelectedFiles(text || undefined).catch((err) => {
          console.error("UniBox: Failed to send media", err);
        });
        msgInput.value = "";
        return;
      }

      // Otherwise send text message
      if (!text) return;

      msgInput.value = "";

      const messageId = `msg_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      appendMessageToUI(
        text,
        "user",
        messageId,
        new Date(),
        "sent",
        null,
        false,
        null,
        "text",
        null,
      );

      sendMessageToApi(text).catch((err) => {
        console.error("UniBox: Failed to send message", err);
      });
    };

    attachBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        files.forEach((file) => {
          sendMediaMessage(file).catch((err) => {
            console.error("UniBox: Failed to add media file", err);
          });
        });
        fileInput.value = ""; // Reset input
      }
    });

    sendBtn.addEventListener("click", handleSend);
    msgInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        if (isTyping) {
          isTyping = false;
          emitTypingStatus(false);
          if (typingTimeout) {
            clearTimeout(typingTimeout);
            typingTimeout = null;
          }
        }
        handleSend();
      } else {
        handleUserTyping();
      }
    });

    // Update send button state based on selected files or text
    const updateSendButtonState = () => {
      const hasText = msgInput.value.trim().length > 0;
      const hasFiles = selectedFiles.length > 0;
      sendBtn.disabled = !hasText && !hasFiles;
      sendBtn.style.opacity = hasText || hasFiles ? "1" : "0.5";
      sendBtn.style.cursor = hasText || hasFiles ? "pointer" : "not-allowed";
    };

    msgInput.addEventListener("input", updateSendButtonState);
    updateSendButtonState();

    // Re-render chips when footer becomes visible (in case it was hidden)
    // Use debounce to prevent excessive calls from MutationObserver
    let chipRenderDebounce = null;
    let isRenderingChips = false; // Prevent recursive calls

    const observer = new MutationObserver(() => {
      // Skip if we're already rendering (prevents infinite loop)
      if (isRenderingChips) return;

      if (selectedFiles.length > 0) {
        // Debounce to prevent excessive calls
        if (chipRenderDebounce) {
          clearTimeout(chipRenderDebounce);
        }
        chipRenderDebounce = setTimeout(() => {
          isRenderingChips = true;
          try {
            renderFileChips();
            updateSendButtonState();
          } finally {
            // Reset flag after a short delay to allow DOM to settle
            setTimeout(() => {
              isRenderingChips = false;
            }, 50);
          }
        }, 100);
      }
    });

    // NOTE: `footer` is defined inside `renderView` and not in this scope.
    // To avoid ReferenceError and still react to footer changes, we resolve
    // the footer element here via the shadow root before observing.
    const footerEl = shadow.getElementById("chatFooter");
    if (footerEl) {
      observer.observe(footerEl, { childList: true, subtree: true });
    }

    function handleUserTyping() {
      if (!isTyping) {
        isTyping = true;
        emitTypingStatus(true);
      }

      if (typingTimeout) {
        clearTimeout(typingTimeout);
      }

      typingTimeout = setTimeout(() => {
        isTyping = false;
        emitTypingStatus(false);
        typingTimeout = null;
      }, 3000);
    }

    /**
     * Mark contact as active/reading - sends presence update via WebSocket
     * ALL status updates go via WebSocket only - no HTTP API calls
     */
    function markContactAsRead() {
      if (!userId || settings.testMode) return;
      if (!conversationId) return;

      // Send presence/activity update via WebSocket ONLY
      wsSend({
        action: "presence",
        conversationId: conversationId,
        status: "active",
      });
    }

    const chatWindow = shadow.getElementById("chatWindow");
    const chatBody = shadow.getElementById("chatBody");
    if (chatBody) {
      // Create a single tooltip element inside the chat body
      const tooltip = document.createElement("div");
      tooltip.id = "chatMessageTooltip";
      tooltip.className = "chat-widget-tooltip";
      tooltip.innerHTML =
        '<div class="chat-widget-tooltip-arrow"></div><span class="chat-widget-tooltip-text"></span>';
      chatBody.appendChild(tooltip);
      const tooltipTextEl = tooltip.querySelector(
        ".chat-widget-tooltip-text",
      );

      const showMessageTooltip = (msgEl) => {
        if (!msgEl) return;
        const tsStr = msgEl.getAttribute("data-timestamp");
        if (!tsStr) return;
        const ts = Number.parseInt(tsStr, 10);
        if (!Number.isFinite(ts)) return;

        const formatted = formatTimestamp(ts, true);
        if (!formatted) return;

        tooltipTextEl.textContent = formatted;

        // Temporarily show to measure width
        tooltip.classList.add("visible");

        const bodyRect = chatBody.getBoundingClientRect();
        const msgRect = msgEl.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        const centerX = msgRect.left + msgRect.width / 2;
        let left = centerX - tooltipRect.width / 2 - bodyRect.left;
        const minLeft = 8;
        const maxLeft = bodyRect.width - tooltipRect.width - 8;
        if (left < minLeft) left = minLeft;
        if (left > maxLeft) left = maxLeft;

        const top = msgRect.bottom - bodyRect.top + 8; // 8px gap below message

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
      };

      const hideMessageTooltip = () => {
        tooltip.classList.remove("visible");
      };

      chatBody.addEventListener("mouseover", (e) => {
        const target =
          e.target instanceof Element ? e.target : e.target.parentElement;
        if (!target) return;
        const msgEl = target.closest(".chat-widget-message");
        if (!msgEl || !chatBody.contains(msgEl)) {
          hideMessageTooltip();
          return;
        }
        showMessageTooltip(msgEl);
      });

      chatBody.addEventListener("mouseleave", () => {
        hideMessageTooltip();
      });

      let scrollTimeout;
      chatBody.addEventListener("scroll", () => {
        hideMessageTooltip();
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          markVisibleMessagesAsRead();
        }, 500);
      });

      const observer = new MutationObserver(() => {
        if (chatWindow.classList.contains("open")) {
          markContactAsRead();
          markVisibleMessagesAsRead();
        }
      });
      observer.observe(chatWindow, {
        attributes: true,
        attributeFilter: ["class"],
      });

      if (chatWindow.classList.contains("open")) {
        setTimeout(() => {
          markContactAsRead();
          markVisibleMessagesAsRead();
        }, 500);
      }
    }

    if (settings.behavior.autoOpen) {
      const hasHistory = localStorage.getItem(STORAGE_KEY_OPEN);
      if (hasHistory === null || hasHistory === "true") {
        const delay = settings.behavior.autoOpenDelay || 2000;
        setTimeout(() => toggle(true), delay);
      }
    }
  }

  function deepMerge(target, source) {
    for (const key in source) {
      if (source[key] instanceof Object && key in target) {
        Object.assign(source[key], deepMerge(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }

  function loadGoogleFont(font) {
    if (!font) return;
    const family = font.split(",")[0].replace(/['"]/g, "").trim();
    if (["sans-serif", "serif", "system-ui"].includes(family.toLowerCase()))
      return;
    const link = document.createElement("link");
    link.href = `https://fonts.googleapis.com/css2?family=${family.replace(
      / /g,
      "+",
    )}:wght@400;500;600&display=swap`;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
})();
