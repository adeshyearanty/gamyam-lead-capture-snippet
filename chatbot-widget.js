(function () {
  // --- 1. CONFIGURATION ---
  if (!window.UniBoxSettings || !window.UniBoxSettings.tenantId) {
    console.error('UniBox: Settings or Tenant ID missing.');
    return;
  }

  const userConfig = window.UniBoxSettings;

  // Storage Keys
  const SESSION_KEY_FORM = `unibox_form_submitted_${userConfig.tenantId}`;
  const STORAGE_KEY_OPEN = `unibox_open_${userConfig.tenantId}`;
  const STORAGE_KEY_USER = `unibox_guest_${userConfig.tenantId}`;

  // API URLs
  const API_BASE =
    userConfig.apiBaseUrl || 'https://dev-api.salesastra.ai/pulse/v1/chat';
  const API_S3_URL = API_BASE.replace(
    /\/chat\/?$/,
    '/s3/generate-access-url',
  );

  // Socket Config Helper
  function getSocketConfig(apiBase) {
    try {
      const urlObj = new URL(apiBase);
      const basePath = urlObj.pathname.replace(/\/chat\/?$/, '');
      return {
        namespaceUrl: `${urlObj.protocol}//${urlObj.host}${basePath}/events`,
        path: `${basePath}/socket.io/`,
      };
    } catch (e) {
      console.error('UniBox: Invalid API URL', e);
      return { namespaceUrl: '', path: '' };
    }
  }

  const SOCKET_CONFIG = getSocketConfig(API_BASE);

  const defaults = {
    tenantId: '',
    apiKey: '',
    testMode: false,
    appearance: {
      primaryColor: '#2563EB',
      secondaryColor: '#F3F4F6',
      backgroundColor: '#FFFFFF',
      fontFamily: 'Inter, sans-serif',
      iconStyle: 'rounded',
      logoUrl: '',
      header: {
        title: 'Support',
        welcomeMessage: 'Hi there! How can we help?',
        offlineMessage: 'We are currently offline.',
      },
      headerName: 'Support',
      welcomeMessage: 'Hi there! How can we help?',
      chatToggleIcon: {
        backgroundColor: '#2563EB',
        style: 'rounded',
      },
    },
    behavior: {
      botDelayMs: 600,
      typingIndicator: true,
      autoOpen: false,
      autoOpenDelay: 2000,
      stickyPlacement: 'bottom-right',
    },
    preChatForm: {
      enabled: false,
      fields: [],
    },
  };

  const settings = deepMerge(defaults, userConfig);

  // --- 2. STATE ---
  let conversationId = null;
  let socket = null;
  let userId = localStorage.getItem(STORAGE_KEY_USER);
  let resolvedLogoUrl = '';
  let messages = new Map();
  let isAgentOnline = false;
  let staticWelcomeShown = false;
  let typingTimeout = null;
  let isTyping = false;
  let agentTyping = false;

  // --- 3. HELPER: HEADERS ---
  function getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-tenant-id': settings.tenantId,
      'x-api-key': settings.apiKey,
    };
  }

  // --- 4. HELPER: UI LOADING STATE ---
  function setLoading(isLoading) {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById('chatBody');
    if (!body) return;

    if (isLoading) {
      body.innerHTML = `
        <div class="chat-widget-loader">
          <div class="chat-widget-loader-spinner"></div>
        </div>
      `;
    } else {
      const loader = body.querySelector('.chat-widget-loader');
      if (loader) loader.remove();
    }
  }

  // --- 5. DEPENDENCY LOADER ---
  function loadSocketScript(callback) {
    if (window.io) {
      callback();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.socket.io/4.7.4/socket.io.min.js';
    script.onload = callback;
    document.head.appendChild(script);
  }

  // --- 6. INITIALIZATION ---
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

  async function init() {
    loadGoogleFont(settings.appearance.fontFamily);

    if (settings.appearance.logoUrl) {
      try {
        resolvedLogoUrl = await fetchSignedUrl(settings.appearance.logoUrl);
      } catch (err) {
        console.warn('UniBox: Failed to load logo', err);
      }
    }

    renderWidget();

    if (settings.testMode) {
      console.warn('UniBox: Running in TEST MODE.');
    }

    loadSocketScript(() => {
      if (userId) {
        const hasSubmittedForm =
          sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
        if (!settings.preChatForm.enabled || hasSubmittedForm) {
          restoreExistingConversation();
        }
      }
    });
  }

  // --- 7. S3 LOGIC ---
  async function fetchSignedUrl(fileName) {
    if (fileName.startsWith('http')) return fileName;
    try {
      const res = await fetch(API_S3_URL, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ fileName: fileName }),
      });
      if (!res.ok) throw new Error('S3 Sign failed');
      const data = await res.text();
      try {
        return JSON.parse(data).url || JSON.parse(data).signedUrl || data;
      } catch (e) {
        return data;
      }
    } catch (error) {
      return '';
    }
  }

  // --- 8. API & SOCKET LOGIC ---

  async function restoreExistingConversation() {
    if (conversationId || !userId) return;
    setLoading(true);
    try {
      const restoreRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
        method: 'GET',
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
                (msg) => msg.id && msg.id.startsWith('static_welcome_'),
              );
              if (staticWelcome && staticWelcome.element) {
                staticWelcome.element.remove();
                messages.delete(staticWelcome.id);
              }
              staticWelcomeShown = false;
            }

            data.messages.forEach((msg) => {
              appendMessageToUI(
                msg.text || msg.text_body,
                msg.sender || (msg.direction === 'inbound' ? 'user' : 'agent'),
                msg.id || msg.messageId,
                msg.timestamp || msg.timestamp_meta,
                msg.status,
                msg.readAt,
                msg.readByUs,
                msg.readByUsAt,
              );
            });
            setTimeout(() => {
              markVisibleMessagesAsRead();
            }, 500);
          }
          connectSocket();
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

  async function initializeConversation() {
    if (conversationId) return;

    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.name = storedName;
      if (storedEmail) userDetails.email = storedEmail;
    }

    setLoading(true);

    try {
      if (!settings.testMode) {
        try {
          const restoreRes = await fetch(
            `${API_BASE}/thread/${userId}?limit=50`,
            {
              method: 'GET',
              headers: getHeaders(),
            },
          );
          if (restoreRes.ok) {
            const data = await restoreRes.json();
            if (data.conversation) {
              conversationId = data.conversation.id;
              setLoading(false);
              if (data.messages && Array.isArray(data.messages)) {
                data.messages.forEach((msg) => {
                  appendMessageToUI(
                    msg.text || msg.text_body,
                    msg.sender ||
                      (msg.direction === 'inbound' ? 'user' : 'agent'),
                    msg.id || msg.messageId,
                    msg.timestamp || msg.timestamp_meta,
                    msg.status,
                    msg.readAt,
                    msg.readByUs,
                    msg.readByUsAt,
                  );
                });
                markVisibleMessagesAsRead();
              }
              connectSocket();
              return;
            }
          }
        } catch (e) {}
      }

      const res = await fetch(`${API_BASE}/conversation`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          userId: userId,
          userName: userDetails.name || 'Guest User',
          userEmail: userDetails.email || '',
          testMode: settings.testMode,
        }),
      });

      if (!res.ok) throw new Error('Failed to start conversation');
      const data = await res.json();
      conversationId = data.conversationId;

      connectSocket();

      if (!settings.testMode) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const threadRes = await fetch(
            `${API_BASE}/thread/${userId}?limit=50`,
            {
              method: 'GET',
              headers: getHeaders(),
            },
          );

          setLoading(false);

          if (threadRes.ok) {
            const threadData = await threadRes.json();
            if (
              threadData.messages &&
              Array.isArray(threadData.messages) &&
              threadData.messages.length > 0
            ) {
              threadData.messages.forEach((msg) => {
                appendMessageToUI(
                  msg.text || msg.text_body,
                  msg.sender ||
                    (msg.direction === 'inbound' ? 'user' : 'agent'),
                  msg.id || msg.messageId,
                  msg.timestamp || msg.timestamp_meta,
                  msg.status,
                  msg.readAt,
                  msg.readByUs,
                  msg.readByUsAt,
                );
              });
              setTimeout(() => {
                markVisibleMessagesAsRead();
              }, 500);
            }
          } else {
            setLoading(false);
          }
        } catch (e) {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    } catch (error) {
      console.error('UniBox: Init Error', error);
      setLoading(false);
    }
  }

  function connectSocket() {
    if (socket || !conversationId || !window.io) return;

    const options = {
      path: SOCKET_CONFIG.path,
      auth: {
        tenantId: settings.tenantId,
        'x-api-key': settings.apiKey,
      },
      query: {
        'x-api-key': settings.apiKey,
      },
      transports: ['polling', 'websocket'],
      transportOptions: {
        polling: {
          extraHeaders: {
            'x-api-key': settings.apiKey,
          },
        },
      },
      reconnection: true,
    };

    socket = window.io(SOCKET_CONFIG.namespaceUrl, options);

    socket.on('connect', () => {
      socket.emit('join', {
        type: 'chat',
        conversationId: conversationId,
        userId: userId,
        isAgent: false,
      });

      setTimeout(() => {
        if (userId && conversationId) {
          fetch(`${API_BASE}/thread/${userId}?limit=50`, {
            method: 'GET',
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
                  appendMessageToUI(
                    msg.text || msg.text_body,
                    msg.sender ||
                      (msg.direction === 'inbound' ? 'user' : 'agent'),
                    msg.id || msg.messageId,
                    msg.timestamp || msg.timestamp_meta,
                    msg.status,
                    msg.readAt,
                    msg.readByUs,
                    msg.readByUsAt,
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
                'UniBox: Failed to fetch thread after socket connect',
                e,
              ),
            );
        }
      }, 500);
    });

    socket.on('read_receipt', (receipt) => {
      updateReadReceipt(receipt);
    });

    socket.on('typing', (data) => {
      if (data.conversationId === conversationId) {
        if (data.isAgent && data.isTyping) {
          agentTyping = true;
          showTypingIndicator(true);
        } else if (data.isAgent && !data.isTyping) {
          agentTyping = false;
          showTypingIndicator(false);
        }
      }
    });

    socket.on('message', (message) => {
      if (message.type === 'read_receipt') {
        updateReadReceipt(message);
        return;
      }
      
      const isUserMessage = message.sender === 'user';
      
      const existingMessage =
        messages.get(message.messageId) ||
        Array.from(messages.values()).find(
          (msg) =>
            msg.messageId === message.messageId ||
            msg.id === message.messageId,
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
        const optimisticMessage = Array.from(messages.values()).find(
          (msg) => {
            if (!msg.element || msg.sender !== 'user') return false;
            return (
              msg.text === message.text &&
              Math.abs(
                new Date(msg.timestamp) - new Date(message.timestamp),
              ) < 10000
            );
          },
        );

        if (optimisticMessage && optimisticMessage.element) {
          const oldId = optimisticMessage.id || optimisticMessage.messageId;
          optimisticMessage.id = message.messageId;
          optimisticMessage.messageId = message.messageId;
          optimisticMessage.status =
            message.status || optimisticMessage.status;
          optimisticMessage.readAt =
            message.readAt || optimisticMessage.readAt;
          optimisticMessage.readByUs =
            message.readByUs !== undefined
              ? message.readByUs
              : optimisticMessage.readByUs;
          optimisticMessage.readByUsAt =
            message.readByUsAt || optimisticMessage.readByUsAt;
          optimisticMessage.element.setAttribute(
            'data-message-id',
            message.messageId,
          );
          if (oldId && oldId !== message.messageId) {
            messages.delete(oldId);
          }
          messages.set(message.messageId, optimisticMessage);
          return;
        }
      }

      appendMessageToUI(
        message.text,
        message.sender,
        message.messageId,
        message.timestamp,
        message.status,
        message.readAt,
        message.readByUs,
        message.readByUsAt,
      );

      sortMessagesByTimestamp();

      if (!isUserMessage) {
        markVisibleMessagesAsRead();
      }
    });

    socket.on('online_status', (data) => {
      updateOnlineStatus(data.isOnline, data.isAgent);
    });

    socket.on('agent_online_status', (data) => {
      isAgentOnline = data.isOnline;
      updateOnlineStatusIndicator();
    });

    socket.on('connect_error', (err) => {
      console.error('UniBox: Socket Connection Error', err.message);
    });
  }

  async function sendMessageToApi(text) {
    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }

    const userDetails = {};
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    try {
      if (conversationId && !socket) {
        connectSocket();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const response = await fetch(`${API_BASE}/message/user`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          conversationId: conversationId || 'new',
          text: text,
          userId: userId,
          userName: userDetails.userName,
          userEmail: userDetails.userEmail,
          testMode: settings.testMode,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.conversationId && !conversationId) {
        conversationId = result.conversationId;
        connectSocket();
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const threadRes = await fetch(
            `${API_BASE}/thread/${userId}?limit=50`,
            {
              method: 'GET',
              headers: getHeaders(),
            },
          );
          if (threadRes.ok) {
            const threadData = await threadRes.json();
            if (threadData.messages && Array.isArray(threadData.messages)) {
              threadData.messages.forEach((msg) => {
                appendMessageToUI(
                  msg.text || msg.text_body,
                  msg.sender ||
                    (msg.direction === 'inbound' ? 'user' : 'agent'),
                  msg.id || msg.messageId,
                  msg.timestamp || msg.timestamp_meta,
                  msg.status,
                  msg.readAt,
                  msg.readByUs,
                  msg.readByUsAt,
                );
              });
              sortMessagesByTimestamp();
              markVisibleMessagesAsRead();
            }
          }
        } catch (e) {
          console.error('UniBox: Failed to fetch thread after message', e);
        }
      }

      return result;
    } catch (error) {
      console.error('UniBox: Send Error', error);
      const host = document.getElementById('unibox-root');
      if (host && host.shadowRoot) {
        const body = host.shadowRoot.getElementById('chatBody');
        if (body) {
          const errDiv = document.createElement('div');
          errDiv.style.textAlign = 'center';
          errDiv.style.fontSize = '12px';
          errDiv.style.color = 'red';
          errDiv.innerText = 'Failed to deliver message';
          body.appendChild(errDiv);
        }
      }
      throw error;
    }
  }

  function formatTimestamp(timestamp, showReadReceipt = false) {
    if (!timestamp) return '';
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);

    if (showReadReceipt) {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      const hoursStr = hours.toString().padStart(2, '0');
      return `${hoursStr}:${minutes} ${ampm}`;
    }

    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const hoursStr = hours.toString().padStart(2, '0');
    const day = date.getDate();
    const month = date.toLocaleString('default', { month: 'short' });
    return `${day} ${month}, ${hoursStr}:${minutes} ${ampm}`;
  }

  function getReadReceiptIcon(status, readAt, readByUs, readByUsAt, sender) {
    if (sender === 'user') {
      if (readByUs && readByUsAt) {
        return `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="chat-widget-read-receipt-icon" style="opacity: 1;">
          <path d="M15.8334 8.05566L7.81258 15.8334L4.16675 12.2981" stroke="#8D53F8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M15.8334 4.16699L7.81258 11.9448L4.16675 8.40942" stroke="#8D53F8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
      }
      return `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="chat-widget-read-receipt-icon" style="opacity: 0.5;">
        <path d="M15.8334 8.05566L7.81258 15.8334L4.16675 12.2981" stroke="#9DA2AB" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M15.8334 4.16699L7.81258 11.9448L4.16675 8.40942" stroke="#9DA2AB" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    }
    return '';
  }

  function appendMessageToUI(
    text,
    type,
    messageId,
    timestamp,
    status,
    readAt,
    readByUs,
    readByUsAt,
  ) {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById('chatBody');
    if (!body) return;

    const normalizedId = messageId || `msg_${Date.now()}`;
    const normalizedTimestamp = timestamp
      ? new Date(timestamp).getTime()
      : Date.now();

    // Check existing
    const existingInMap =
      messages.get(normalizedId) ||
      Array.from(messages.values()).find(
        (m) =>
          m.id === normalizedId ||
          m.messageId === normalizedId ||
          (m.text === text &&
            m.sender === type &&
            Math.abs(new Date(m.timestamp).getTime() - normalizedTimestamp) <
              5000),
      );

    if (existingInMap && existingInMap.element) {
      existingInMap.status = status || existingInMap.status;
      existingInMap.readAt = readAt || existingInMap.readAt;
      existingInMap.readByUs =
        readByUs !== undefined ? readByUs : existingInMap.readByUs;
      existingInMap.readByUsAt = readByUsAt || existingInMap.readByUsAt;
      return;
    }

    const existingInDOM = Array.from(body.children).find((child) => {
      const childId = child.getAttribute('data-message-id');
      if (childId === normalizedId) return true;
      return false;
    });

    if (existingInDOM) {
      if (normalizedId && !messages.has(normalizedId)) {
        messages.set(normalizedId, {
          id: normalizedId,
          messageId: normalizedId,
          text,
          sender: type,
          timestamp: timestamp || new Date(),
          status: status || 'sent',
          readAt,
          readByUs: readByUs || false,
          readByUsAt,
          element: existingInDOM,
        });
      }
      return;
    }

    // CREATE MESSAGE ELEMENTS WITH NEW CLASSES
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-widget-message ${type === 'agent' ? 'bot' : 'user'}`;
    msgDiv.setAttribute('data-message-id', normalizedId);
    msgDiv.setAttribute('data-timestamp', normalizedTimestamp.toString());

    const msgContent = document.createElement('div');
    msgContent.className = 'chat-widget-message-content';
    msgContent.textContent = text;
    msgDiv.appendChild(msgContent);

    const msgMeta = document.createElement('div');
    msgMeta.className = 'chat-widget-message-meta';

    // --- [MODIFIED START] ---
    // Read receipts and Timestamps removed from UI

    /*
    if (type === 'user') {
      const receiptSpan = document.createElement('span');
      receiptSpan.className = 'chat-widget-read-receipt';
      const receiptIcon = getReadReceiptIcon(
        status,
        readAt,
        readByUs,
        readByUsAt,
        'user',
      );
      if (receiptIcon) {
        receiptSpan.innerHTML = receiptIcon;
        msgMeta.appendChild(receiptSpan);
      }
    }

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-widget-message-time';
    timeSpan.textContent = formatTimestamp(timestamp, true);
    msgMeta.appendChild(timeSpan);
    */

    // Only append meta if there is something inside, otherwise we get empty margin space
    if (msgMeta.hasChildNodes()) {
        msgDiv.appendChild(msgMeta);
    }
    // --- [MODIFIED END] ---

    // Store message data
    if (messageId) {
      const messageData = {
        id: messageId,
        messageId: messageId,
        text,
        sender: type,
        timestamp: timestamp || new Date(),
        status: status || 'sent',
        readAt,
        readByUs: readByUs || false,
        readByUsAt,
        element: msgDiv,
      };
      messages.set(messageId, messageData);
      if (normalizedId !== messageId) {
        messages.set(normalizedId, messageData);
      }
    }

    body.appendChild(msgDiv);
    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  function sortMessagesByTimestamp() {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById('chatBody');
    if (!body) return;

    const messageElements = Array.from(body.children).filter((child) => {
      return child.hasAttribute('data-timestamp');
    });

    messageElements.sort((a, b) => {
      const timestampA = parseInt(a.getAttribute('data-timestamp') || '0');
      const timestampB = parseInt(b.getAttribute('data-timestamp') || '0');
      return timestampA - timestampB;
    });

    messageElements.forEach((element) => {
      body.appendChild(element);
    });

    requestAnimationFrame(() => {
      body.scrollTop = body.scrollHeight;
    });
  }

  function updateReadReceipt(receipt) {
    // --- [MODIFIED START] ---
    // Disabled UI updates for read receipts
    return;
    
    /*
    const messageId = receipt.messageId || receipt.id;
    if (!messageId) return;
    
    let message = messages.get(messageId);
    if (!message) {
      message = Array.from(messages.values()).find(
        (msg) => msg.id === messageId || msg.messageId === messageId
      );
    }
    
    if (!message || !message.element) return;
    
    const meta = message.element.querySelector('.chat-widget-message-meta');
    if (!meta) return;

    message.status = receipt.status || message.status;
    message.readAt = receipt.readAt || message.readAt;
    message.readByUs =
      receipt.readByUs !== undefined ? receipt.readByUs : message.readByUs;
    message.readByUsAt = receipt.readByUsAt || message.readByUsAt;

    if (message.sender === 'user') {
      let receiptContainer = meta.querySelector('.chat-widget-read-receipt');
      if (!receiptContainer) {
        receiptContainer = document.createElement('span');
        receiptContainer.className = 'chat-widget-read-receipt';
        const timeSpan = meta.querySelector('.chat-widget-message-time');
        if (timeSpan) {
          meta.insertBefore(receiptContainer, timeSpan);
        } else {
          meta.appendChild(receiptContainer);
        }
      }
      const receiptIcon = getReadReceiptIcon(
        message.status,
        message.readAt,
        message.readByUs,
        message.readByUsAt,
        message.sender,
      );
      if (receiptIcon) {
        receiptContainer.innerHTML = receiptIcon;
      }
    }
    */
    // --- [MODIFIED END] ---
  }

  async function markMessagesAsRead(messageIds) {
    if (!conversationId || !userId || settings.testMode) return;
    try {
      await fetch(`${API_BASE}/messages/read`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          conversationId: conversationId,
          userId: userId,
          messageIds: messageIds,
        }),
      });
    } catch (error) {
      console.error('UniBox: Failed to mark messages as read', error);
    }
  }

  function markVisibleMessagesAsRead() {
    if (!conversationId || !userId || settings.testMode) return;
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById('chatBody');
    if (!body) return;

    const unreadAgentMessages = Array.from(messages.values())
      .filter((msg) => {
        return msg.sender === 'agent' && 
               (msg.status !== 'read' || !msg.readAt);
      })
      .map((msg) => msg.id || msg.messageId)
      .filter(id => id);

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
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const statusIndicator = host.shadowRoot.getElementById(
      'onlineStatusIndicator',
    );
    if (statusIndicator) {
      statusIndicator.textContent = isAgentOnline ? '● Online' : '○ Offline';
      statusIndicator.className = `chat-widget-online-status ${isAgentOnline ? 'online' : 'offline'}`;
    }
  }

  function showTypingIndicator(show) {
    const host = document.getElementById('unibox-root');
    if (!host || !host.shadowRoot) return;
    const typingIndicator = host.shadowRoot.getElementById('typingIndicator');
    if (typingIndicator) {
      if (show) {
        typingIndicator.classList.remove('hidden');
        const body = host.shadowRoot.getElementById('chatBody');
        if (body) {
          requestAnimationFrame(() => {
            body.scrollTop = body.scrollHeight;
          });
        }
      } else {
        typingIndicator.classList.add('hidden');
      }
    }
  }

  function emitTypingStatus(typing) {
    if (!socket || !conversationId || !userId || !socket.connected) return;
    socket.emit('typing', {
      conversationId: conversationId,
      userId: userId,
      isTyping: typing,
      isAgent: false
    });
  }

  // --- 9. UI RENDERING ---
  function renderWidget() {
    const host = document.createElement('div');
    host.id = 'unibox-root';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    // Styles variables calculation
    // --- [MODIFIED START] ---
    // Force white background if a logo image is used
    let launcherBg =
      settings.appearance.chatToggleIcon.backgroundColor ||
      settings.appearance.primaryColor;
    
    if (resolvedLogoUrl) {
        launcherBg = '#FFFFFF';
    }
    // --- [MODIFIED END] ---

    const launcherIconColor =
      launcherBg.toLowerCase() === '#ffffff' ||
      launcherBg.toLowerCase() === '#fff'
        ? settings.appearance.primaryColor
        : '#FFFFFF';

    const placement = settings.behavior.stickyPlacement || 'bottom-right';
    const isTop = placement.includes('top');
    const isRight = placement.includes('right');
    const horizontalCss = isRight ? 'right: 20px;' : 'left: 20px;';
    const verticalLauncherCss = isTop ? 'top: 20px;' : 'bottom: 20px;';
    const verticalWindowCss = isTop ? 'top: 90px;' : 'bottom: 90px;';
    
    const getRadius = (style) => {
      if (style === 'rounded') return '12px';
      if (style === 'square') return '0px';
      return '50%';
    };
    const launcherRadius = getRadius(settings.appearance.chatToggleIcon.style);
    const headerLogoRadius = settings.appearance.iconStyle === 'round' ? '50%' : '8px';

    const styleTag = document.createElement('style');
    
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
          position: fixed; ${verticalLauncherCss} ${horizontalCss}
          width: 60px;
          height: 60px;
          background: ${launcherBg};
          color: ${launcherIconColor};
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

        .chat-widget-launcher:hover {
          transform: scale(1.05);
        }

        .chat-widget-window {
          position: fixed; ${verticalWindowCss} ${horizontalCss}
          width: 380px;
          height: 600px;
          max-width: calc(100vw - 40px);
          max-height: calc(100vh - 120px);
          background: #ffffff;
          border-radius: 12px;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          opacity: 0;
          pointer-events: none;
          transform: ${isTop ? "translateY(-20px)" : "translateY(20px)"} scale(0.95);
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
          background: ${settings.appearance.primaryColor};
          padding: 16px;
          color: #fff;
          display: flex;
          align-items: center;
          gap: 12px;
          flex-shrink: 0;
        }

        .chat-widget-header-logo {
          width: 32px;
          height: 32px;
          border-radius: ${headerLogoRadius};
          background: #fff;
          padding: 2px;
          object-fit: cover;
        }

        .chat-widget-header-title {
          font-weight: 600;
          font-size: 16px;
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
          color: #22c55e;
        }

        .chat-widget-online-status.offline {
          color: #9da2ab;
        }

        .chat-widget-body {
          flex: 1;
          padding: 24px;
          overflow-y: auto;
          background-color: #fafbfc;
          position: relative;
        }

        .chat-widget-loader {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100%;
        }

        .chat-widget-loader-spinner {
          border: 3px solid #f3f3f3;
          border-top: 3px solid ${settings.appearance.primaryColor};
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
          max-width: 85%;
          margin-bottom: 12px;
          display: flex;
          flex-direction: column;
        }

        .chat-widget-message.bot {
          align-self: flex-start;
        }

        .chat-widget-message.user {
          align-self: flex-end;
          margin-left: auto;
        }

        .chat-widget-message-content {
          padding: 14px 16px;
          border-radius: 10px;
          font-size: 14px;
          line-height: 1.43;
          word-break: break-word;
          font-weight: 400;
        }

        .chat-widget-message.bot .chat-widget-message-content {
          background: ${settings.appearance.secondaryColor};
          color: #18181e;
          border-radius: 10px;
          border-top-left-radius: 0;
        }

        .chat-widget-message.user .chat-widget-message-content {
          background: ${settings.appearance.backgroundColor};
          color: #18181e;
          border-radius: 10px;
          border-bottom-right-radius: 0;
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
          background: #f5f7f9;
          border-radius: 10px;
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
          border-color: ${settings.appearance.primaryColor};
        }

        .chat-widget-form-btn {
          width: 100%;
          padding: 12px;
          background: ${settings.appearance.primaryColor};
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }

        .chat-widget-footer {
          padding: 12px;
          background: #ffffff;
          border-top: 1px solid #eee;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .chat-widget-footer.hidden {
          display: none;
        }

        .chat-widget-input-wrapper {
          flex: 1;
          display: flex;
          align-items: center;
          background: #f3f4f6;
          border-radius: 20px;
          padding: 8px 12px;
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
          background: ${settings.appearance.primaryColor};
          color: white;
          border: none;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
    `;

    const chatIcon = `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`;

    const container = document.createElement('div');
    container.className = 'chat-widget-container';

    const headerLogoImg = resolvedLogoUrl
      ? `<img src="${resolvedLogoUrl}" class="chat-widget-header-logo" alt="Logo" />`
      : '';

    const launcherContent = resolvedLogoUrl
      ? `<img src="${resolvedLogoUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="Chat" />`
      : chatIcon;

    container.innerHTML = `
      <div class="chat-widget-launcher" id="launcherBtn">${launcherContent}</div>
      <div class="chat-widget-window" id="chatWindow">
        <div class="chat-widget-header">
           ${headerLogoImg}
           <div style="flex: 1;">
             <div class="chat-widget-header-title">${settings.appearance.header?.title || settings.appearance.headerName}</div>
             <div id="onlineStatusIndicator" class="chat-widget-online-status offline">○ Offline</div>
           </div>
           <div id="closeBtn" style="cursor:pointer; font-size:24px; opacity:0.8; line-height: 1;">&times;</div>
        </div>
        <div class="chat-widget-body" id="chatBody">
          <div class="chat-widget-typing-indicator hidden" id="typingIndicator">
            <div class="chat-widget-typing-dot"></div>
            <div class="chat-widget-typing-dot"></div>
            <div class="chat-widget-typing-dot"></div>
          </div>
        </div>
        <div class="chat-widget-footer hidden" id="chatFooter">
           <div class="chat-widget-input-wrapper">
             <input type="text" class="chat-widget-input" id="msgInput" placeholder="Type a message..." />
           </div>
           <button class="chat-widget-send-btn" id="sendBtn">
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
           </button>
        </div>
      </div>
    `;

    shadow.appendChild(styleTag);
    shadow.appendChild(container);

    // --- 10. VIEW LOGIC ---
    const isFormEnabled = settings.preChatForm.enabled;
    const hasSubmittedForm =
      sessionStorage.getItem(SESSION_KEY_FORM) === 'true';
    let currentView = isFormEnabled && !hasSubmittedForm ? 'form' : 'chat';

    const renderView = () => {
      const body = shadow.getElementById('chatBody');
      const footer = shadow.getElementById('chatFooter');
      body.innerHTML = '';
      
      // Re-add typing indicator to body (it gets cleared)
      body.innerHTML = `
        <div class="chat-widget-typing-indicator hidden" id="typingIndicator">
            <div class="chat-widget-typing-dot"></div>
            <div class="chat-widget-typing-dot"></div>
            <div class="chat-widget-typing-dot"></div>
        </div>
      `;

      if (currentView === 'form') {
        footer.classList.add('hidden');

        const fieldsHtml = settings.preChatForm.fields
          .map((f) => {
            let inputHtml = '';
            const isRequired = f.required ? 'required' : '';

            if (f.type === 'textarea') {
              inputHtml = `<textarea class="chat-widget-form-input" name="${f.id}" ${isRequired} placeholder="${f.label}"></textarea>`;
            } else {
              const inputType = f.type === 'phone' ? 'tel' : f.type;
              inputHtml = `<input class="chat-widget-form-input" type="${inputType}" name="${f.id}" ${isRequired} placeholder="${f.label}">`;
            }

            return `
            <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px;">${f.label}${f.required ? ' <span style="color:red">*</span>' : ''}</label>
              ${inputHtml}
            </div>
          `;
          })
          .join('');

        const formContainer = document.createElement('div');
        formContainer.className = 'chat-widget-form-container';
        formContainer.innerHTML = `
          <div style="text-align:center; margin-bottom:5px; font-weight:600; font-size:16px; color:#111;">Welcome</div>
          <div style="text-align:center; margin-bottom:20px; font-size:14px; color:#666;">Please fill in your details to continue.</div>
          <form id="preChatForm">
            ${fieldsHtml}
            <button type="submit" class="chat-widget-form-btn">Start Chat</button>
          </form>
        `;
        body.appendChild(formContainer);

        const formEl = formContainer.querySelector('#preChatForm');
        formEl.addEventListener('submit', (e) => {
          e.preventDefault();
          const formData = new FormData(formEl);
          const data = Object.fromEntries(formData.entries());

          let capturedName = '';
          let capturedEmail = '';

          settings.preChatForm.fields.forEach((field) => {
            const val = data[field.id];
            if (!val) return;
            if (
              field.type === 'text' &&
              (field.label.toLowerCase().includes('name') ||
                field.id.toLowerCase().includes('name'))
            )
              capturedName = val;
            if (
              field.type === 'email' ||
              field.id.toLowerCase().includes('email')
            )
              capturedEmail = val;
          });

          if (!capturedName && capturedEmail) capturedName = capturedEmail;

          sessionStorage.setItem(SESSION_KEY_FORM, 'true');
          if (capturedName)
            sessionStorage.setItem(`${SESSION_KEY_FORM}_name`, capturedName);
          if (capturedEmail)
            sessionStorage.setItem(`${SESSION_KEY_FORM}_email`, capturedEmail);

          currentView = 'chat';
          renderView();
        });
      } else {
        footer.classList.remove('hidden');

        if (!staticWelcomeShown && !userId) {
          const welcomeText =
            settings.appearance.header?.welcomeMessage ||
            settings.appearance.welcomeMessage;
          if (welcomeText) {
            appendMessageToUI(
              welcomeText,
              'agent',
              `static_welcome_${Date.now()}`,
              new Date(),
              'sent',
              null,
              false,
              null,
            );
            staticWelcomeShown = true;
          }
        }
      }
    };

    renderView();

    // --- 11. EVENTS ---
    const launcher = shadow.getElementById('launcherBtn');
    const windowEl = shadow.getElementById('chatWindow');
    const closeBtn = shadow.getElementById('closeBtn');
    const sendBtn = shadow.getElementById('sendBtn');
    const msgInput = shadow.getElementById('msgInput');

    const toggle = (forceState) => {
      const isOpen = windowEl.classList.contains('open');
      const nextState = forceState !== undefined ? forceState : !isOpen;

      if (nextState) windowEl.classList.add('open');
      else windowEl.classList.remove('open');

      if (settings.behavior.stickyPlacement) {
        localStorage.setItem(STORAGE_KEY_OPEN, nextState);
      }
    };

    launcher.addEventListener('click', () => toggle());
    closeBtn.addEventListener('click', () => toggle(false));

    const handleSend = () => {
      const text = msgInput.value.trim();
      if (!text) return;

      msgInput.value = '';

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      appendMessageToUI(
        text,
        'user',
        messageId,
        new Date(),
        'sent',
        null,
        false,
        null,
      );

      sendMessageToApi(text).catch((err) => {
        console.error('UniBox: Failed to send message', err);
      });
    };

    sendBtn.addEventListener('click', handleSend);
    msgInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
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

    async function markContactAsRead() {
      if (!userId || settings.testMode) return;
      try {
        await fetch(`${API_BASE}/read/${userId}`, {
          method: 'POST',
          headers: getHeaders(),
        });
      } catch (error) {
        console.error('UniBox: Failed to mark contact as read', error);
      }
    }

    const chatWindow = shadow.getElementById('chatWindow');
    const chatBody = shadow.getElementById('chatBody');
    if (chatBody) {
      let scrollTimeout;
      chatBody.addEventListener('scroll', () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          markVisibleMessagesAsRead();
        }, 500);
      });

      const observer = new MutationObserver(() => {
        if (chatWindow.classList.contains('open')) {
          markContactAsRead();
          markVisibleMessagesAsRead();
        }
      });
      observer.observe(chatWindow, {
        attributes: true,
        attributeFilter: ['class'],
      });
      
      if (chatWindow.classList.contains('open')) {
        setTimeout(() => {
          markContactAsRead();
          markVisibleMessagesAsRead();
        }, 500);
      }
    }

    if (settings.behavior.autoOpen) {
      const hasHistory = localStorage.getItem(STORAGE_KEY_OPEN);
      if (hasHistory === null || hasHistory === 'true') {
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
    const family = font.split(',')[0].replace(/['"]/g, '').trim();
    if (['sans-serif', 'serif', 'system-ui'].includes(family.toLowerCase()))
      return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@400;500;600&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
})();
