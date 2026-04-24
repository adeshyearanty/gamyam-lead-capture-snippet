"use client";

import { getAvatarInitials } from "@/components/ui/Avatar";
import { useMessageStream } from "@/hooks/useMessageStream";
import { getUserFromIdToken } from "@/lib/cognito/helper";
import { getS3Url } from "@/lib/services/s3Service";
import { markLiveChatMessagesAsRead } from "@/services/liveChatService";
import {
  addContactNote,
  assignContact,
  getContactIdForPlatform,
  getContactNotes,
  InternalNote,
  UnifiedContact,
  UnifiedMessage,
  updateContactPriority,
  updateContactStatus,
} from "@/services/unibox";
import { terminateVirtualAgent } from "@/services/virtualAgentService";
import leadInstance from "@/lib/instances/leadInstance";
import { getCookie } from "cookies-next/client";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { Button } from "../ui/Button";
import { CustomTooltip } from "../ui/CustomTooltip";
import MessageInput from "./MessageInput";
import whatsappInstance from "@/lib/instances/whatsappInstance";
import CreateLeadForm from "@/components/lead/CreateLeadForm";
import {
  PulseInlineLoading,
  PulseSpinner,
} from "@/components/ui/PulseInlineLoading";
import { PulseContactActionsMenu } from "./PulseContactActionsMenu";
import type { AssignableUserOption } from "@/lib/inbox/inboxAssignmentContext";
import useRbacPermissions from "@/hooks/useRbacPermissions";

interface ConversationViewProps {
  contact: UnifiedContact;
  messages: UnifiedMessage[];
  isLoading?: boolean;
  isSending?: boolean;
  onSendMessage?: (message: string) => void;
  onSendMedia?: (file: File, caption?: string) => void;
  onTyping?: () => void;
  onLoadMoreMessages?: () => void;
  hasMoreMessages?: boolean;
  isLoadingMoreMessages?: boolean;
  onUpdateMessage?: (
    messageId: string,
    updates: Partial<UnifiedMessage>,
  ) => void;
  isUserTyping?: boolean; // Typing indicator from parent (for live_chat)
  /** Pulse inbox assignable users (tab-filtered in parent) — shared cache, no per-row fetch */
  assignableUsers?: AssignableUserOption[];
  assignableUsersLoading?: boolean;
  /** Map for internal note author names (all tenant profiles) */
  noteAuthorMap?: Map<string, { name: string; email: string }>;
}

export default function ConversationView({
  contact,
  messages,
  isLoading = false,
  isSending = false,
  onSendMessage,
  onSendMedia,
  onTyping,
  onLoadMoreMessages,
  hasMoreMessages = false,
  isLoadingMoreMessages = false,
  onUpdateMessage,
  isUserTyping: isUserTypingProp = false,
  assignableUsers = [],
  assignableUsersLoading = false,
  noteAuthorMap: noteAuthorMapProp,
}: Readonly<ConversationViewProps>) {
  const { hasPermission } = useRbacPermissions();
  const canReplyConversation = hasPermission("pulse", "reply");
  const canAssignConversation = hasPermission("pulse", "assignConversation");
  const canModifyConversation = hasPermission("pulse", "modifyConversation");
  const canCreateLead = hasPermission("pulse", "createLead");
  const canCloseConversation = hasPermission("pulse", "closeConversation");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const isInitialLoadRef = useRef(true);
  const [floatingDate, setFloatingDate] = useState<string | null>(null);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const dateDividerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const currentVisibleDateRef = useRef<string | null>(null);
  const typingExitTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Set Status dropdown state
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  // More menu state (End Session only)
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  // Notes modal state
  const [showNotesModal, setShowNotesModal] = useState(false);
  // End session confirmation modal state
  const [showEndSessionConfirm, setShowEndSessionConfirm] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);
  const endSessionConfirmRef = useRef<HTMLDivElement>(null);
  // Session status state - tracks if session is active (for live_chat)
  const [isSessionActive, setIsSessionActive] = useState<boolean | null>(null);
  const [noteText, setNoteText] = useState("");
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [isNoteTextareaFocused, setIsNoteTextareaFocused] = useState(false);
  const [notes, setNotes] = useState<InternalNote[]>([]);
  const [notesPage, setNotesPage] = useState(1);
  const [notesTotalPages, setNotesTotalPages] = useState(1);
  const [isLoadingNotes, setIsLoadingNotes] = useState(false);
  const [isLoadingMoreNotes, setIsLoadingMoreNotes] = useState(false);
  const notesContainerRef = useRef<HTMLDivElement>(null);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const notesModalRef = useRef<HTMLDivElement>(null);
  const noteAuthorMap =
    noteAuthorMapProp ?? new Map<string, { name: string; email: string }>();
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const [showCreateLeadForm, setShowCreateLeadForm] = useState(false);
  const wasCreateLeadClosedByDuplicateRef = useRef(false);
  const [createLeadInitialData, setCreateLeadInitialData] = useState<
    Record<string, string> | undefined
  >(undefined);
  const [createLeadAiData, setCreateLeadAiData] = useState<
    { summary?: string } | undefined
  >(undefined);

  // Typing indicator and online status state for live_chat
  const [isUserTyping, setIsUserTyping] = useState(false);
  const [isUserOnline, setIsUserOnline] = useState<boolean | null>(null);
  const [isTypingIndicatorMounted, setIsTypingIndicatorMounted] = useState(false);
  const [isTypingIndicatorVisible, setIsTypingIndicatorVisible] = useState(false);

  useEffect(() => {
    const handleCloseForDuplicate = () => {
      if (showCreateLeadForm) {
        wasCreateLeadClosedByDuplicateRef.current = true;
        setShowCreateLeadForm(false);
      }
    };

    const handleReopenAfterDuplicate = () => {
      if (wasCreateLeadClosedByDuplicateRef.current) {
        setShowCreateLeadForm(true);
        wasCreateLeadClosedByDuplicateRef.current = false;
      }
    };

    globalThis.addEventListener(
      "closeCreateLeadFormForDuplicate",
      handleCloseForDuplicate,
    );
    globalThis.addEventListener(
      "openCreateLeadFormAfterDuplicate",
      handleReopenAfterDuplicate,
    );

    return () => {
      globalThis.removeEventListener(
        "closeCreateLeadFormForDuplicate",
        handleCloseForDuplicate,
      );
      globalThis.removeEventListener(
        "openCreateLeadFormAfterDuplicate",
        handleReopenAfterDuplicate,
      );
    };
  }, [showCreateLeadForm]);

  // Media preview state
  const [previewMedia, setPreviewMedia] = useState<{
    url: string;
    filename: string;
    type: UnifiedMessage["type"];
  } | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  // Get current user's cognito_sub for marking messages as read
  const getAgentUserId = useCallback((): string | null => {
    const idToken = getCookie("idToken") as string;
    const claims = getUserFromIdToken(idToken);
    return claims?.sub || null;
  }, []);

  // Mark messages as read for live_chat
  const markMessagesAsRead = useCallback(
    async (messageIds?: string[]) => {
      if (contact.platform !== "live_chat") return;

      const conversationId =
        messages.length > 0 ? messages[0]?.conversation_id : undefined;

      if (!conversationId) return;

      const agentUserId = getAgentUserId();
      if (!agentUserId) return;

      try {
        await markLiveChatMessagesAsRead(
          conversationId,
          agentUserId,
          messageIds,
        );
      } catch (error) {
        console.error("Failed to mark live chat messages as read:", error);
      }
    },
    [contact.platform, messages, getAgentUserId],
  );

  // Handle click on any media chip in the thread
  const handleMediaClick = useCallback(async (message: UnifiedMessage) => {
    if (
      message.type !== "image" &&
      message.type !== "document" &&
      message.type !== "video" &&
      message.type !== "audio"
    ) {
      return;
    }

    setIsPreviewLoading(true);
    try {
      const rawPayload: any = message.raw_payload || {};
      const s3Key = message.media_storage_url || rawPayload.s3_key || null;

      let url: string | null = null;

      if (s3Key) {
        url = await getS3Url(s3Key);
      }

      if (!url && message.media_url) {
        url = message.media_url;
      }

      if (!url) {
        console.error("No media URL available for message", message.id);
        setIsPreviewLoading(false);
        return;
      }

      const storageKey = message.media_storage_url ?? "";
      const derivedName = storageKey.split("/").pop() || "file";

      setPreviewMedia({
        url,
        filename: derivedName,
        type: message.type,
      });
    } catch (error) {
      console.error("Error loading media preview:", error);
    } finally {
      setIsPreviewLoading(false);
    }
  }, []);

  // Mark all visible messages as read (including welcome message) when conversation opens
  useEffect(() => {
    if (contact.platform === "live_chat" && messages.length > 0 && !isLoading) {
      const conversationId = messages[0]?.conversation_id;
      if (!conversationId) return;

      // Delay slightly to ensure socket is connected and room is joined
      const timeoutId = setTimeout(() => {
        // Mark all unread user messages as read when conversation opens
        const unreadUserMessages = messages
          .filter((msg) => msg.direction === "inbound" && !msg.read_by_us)
          .map((msg) => msg.id);

        if (unreadUserMessages.length > 0) {
          // Mark specific messages as read
          markMessagesAsRead(unreadUserMessages);
        } else {
          // Mark all unread messages if no specific IDs (catches any missed messages including welcome)
          markMessagesAsRead();
        }
      }, 500); // Wait 500ms for socket connection and room join

      return () => clearTimeout(timeoutId);
    }
  }, [contact.platform, contact._id, isLoading, messages, markMessagesAsRead]); // Run when conversation opens or contact changes

  // Clear local typing when final inbound message arrives.
  useEffect(() => {
    if (contact.platform !== "live_chat" || messages.length === 0) return;
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.direction === "inbound") {
      setIsUserTyping(false);
    }
  }, [contact.platform, messages]);

  // Get current user's cognito_sub
  const getCurrentUserSub = (): string | null => {
    const idToken = getCookie("idToken") as string;
    const claims = getUserFromIdToken(idToken);
    return claims?.sub || null;
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // Check if click is inside CustomFilterSelect dropdown (rendered via portal)
      const customSelectDropdown = document.querySelector(
        '[style*="zIndex: 999999"]',
      );
      if (customSelectDropdown?.contains(target)) {
        return; // Don't close if clicking inside CustomFilterSelect
      }

      // Also check for any element with the dropdown ref
      const allDropdowns = document.querySelectorAll(
        '[style*="zIndex: 999999"]',
      );
      for (const dropdown of allDropdowns) {
        if (dropdown.contains(target)) {
          return; // Don't close if clicking inside any CustomFilterSelect dropdown
        }
      }

      const isInsideStatusMenu = statusMenuRef.current?.contains(target);
      const isInsideMoreMenu = moreMenuRef.current?.contains(target);

      if (isInsideStatusMenu || isInsideMoreMenu) {
        return;
      }

      setTimeout(() => {
        setShowStatusMenu(false);
        setShowMoreMenu(false);
      }, 0);
    };

    if (showStatusMenu || showMoreMenu) {
      // Use capture phase but delay the closing
      document.addEventListener("mousedown", handleClickOutside, true);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside, true);
    }
  }, [showStatusMenu, showMoreMenu]);

  // Click outside handler for notes modal
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (notesModalRef.current && !notesModalRef.current.contains(target)) {
        // Use setTimeout to allow click events to fire first
        setTimeout(() => {
          setShowNotesModal(false);
          setNoteText("");
          setIsNoteTextareaFocused(false);
        }, 0);
      }
    };

    if (showNotesModal) {
      // Use capture phase but delay the closing
      document.addEventListener("mousedown", handleClickOutside, true);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside, true);
    }
  }, [showNotesModal]);

  // Click outside handler for end session confirmation modal
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        endSessionConfirmRef.current &&
        !endSessionConfirmRef.current.contains(target)
      ) {
        setTimeout(() => {
          setShowEndSessionConfirm(false);
        }, 0);
      }
    };

    if (showEndSessionConfirm) {
      document.addEventListener("mousedown", handleClickOutside, true);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside, true);
    }
  }, [showEndSessionConfirm]);

  const handleAssignToMe = async () => {
    if (!canAssignConversation) return;
    const currentUserSub = getCurrentUserSub();
    if (!currentUserSub) {
      toast.error("Unable to get current user information");
      return;
    }

    const contactId = getContactIdForPlatform(contact);
    if (!contactId) {
      toast.error("Unable to get contact ID");
      return;
    }

    try {
      await assignContact({
        contactId,
        platform: contact.platform,
        assigned_to: currentUserSub,
        sub: currentUserSub,
      });
      toast.success("Contact assigned to you");
      setShowStatusMenu(false);
    } catch (error: any) {
      console.error("Error assigning contact:", error);
      toast.error(error?.response?.data?.message || "Failed to assign contact");
    }
  };

  const handleAssignToUser = async (userSub: string) => {
    if (!canAssignConversation) return;
    const currentUserSub = getCurrentUserSub();
    if (!currentUserSub) {
      toast.error("Unable to get current user information");
      return;
    }

    const contactId = getContactIdForPlatform(contact);
    if (!contactId) {
      toast.error("Unable to get contact ID");
      return;
    }

    try {
      await assignContact({
        contactId,
        platform: contact.platform,
        assigned_to: userSub,
        sub: currentUserSub,
      });
      const selectedUser = assignableUsers.find((u) => u.sub === userSub);
      toast.success(`Contact assigned to ${selectedUser?.name || "user"}`);
      setShowStatusMenu(false);
    } catch (error: any) {
      console.error("Error assigning contact:", error);
      toast.error(error?.response?.data?.message || "Failed to assign contact");
    }
  };

  const handleUnassign = async () => {
    if (!canAssignConversation) return;
    const contactId = getContactIdForPlatform(contact);
    if (!contactId) {
      toast.error("Unable to get contact ID");
      return;
    }

    try {
      await updateContactStatus({
        contactId,
        platform: contact.platform,
        status: "not_assigned",
      });
      toast.success("Contact unassigned");
      setShowStatusMenu(false);
    } catch (error: any) {
      console.error("Error unassigning contact:", error);
      toast.error(
        error?.response?.data?.message || "Failed to unassign contact",
      );
    }
  };

  const handleStatusChange = async (
    status: "insufficient_data" | "junk" | "lead_created",
  ) => {
    if (!canModifyConversation) return;
    const contactId = getContactIdForPlatform(contact);
    if (!contactId) {
      toast.error("Unable to get contact ID");
      return;
    }

    try {
      await updateContactStatus({
        contactId,
        platform: contact.platform,
        status,
      });
      const statusLabel = status.replaceAll("_", " ");
      toast.success(`Contact status updated to ${statusLabel}`);
      setShowStatusMenu(false);
    } catch (error: any) {
      console.error("Error updating contact status:", error);
      toast.error(
        error?.response?.data?.message || "Failed to update contact status",
      );
    }
  };

  // Get priority icon
  const getPriorityIconSrc = (
    priority?: UnifiedContact["priority"],
  ): string | null => {
    if (!priority) return null;
    switch (priority) {
      case "low":
        return "/pulse/low.svg";
      case "normal":
        return "/pulse/normal.svg";
      case "high":
        return "/pulse/high.svg";
      default:
        return null;
    }
  };

  // Handle priority change
  const handlePriorityChange = async (priority: "low" | "normal" | "high") => {
    if (!canModifyConversation) return;
    const contactId = getContactIdForPlatform(contact);
    if (!contactId) {
      toast.error("Unable to get contact ID");
      return;
    }

    try {
      await updateContactPriority({
        contactId,
        platform: contact.platform,
        priority,
      });
      toast.success(`Contact priority updated to ${priority}`);
      setShowStatusMenu(false);
      setShowMoreMenu(false);
    } catch (error: any) {
      console.error("Error updating contact priority:", error);
      toast.error(
        error?.response?.data?.message || "Failed to update contact priority",
      );
    }
  };

  // Handle end session
  const handleEndSession = async () => {
    if (!canCloseConversation) return;
    // Get conversationId from session or from messages
    const conversationId =
      contact.session?.conversationId ||
      (messages.length > 0 ? messages[0]?.conversation_id : undefined);

    if (!conversationId) {
      toast.error("Unable to get conversation ID");
      return;
    }

    setIsEndingSession(true);
    try {
      // Endpoint: POST /v1/messages/session/end
      // Unified endpoint that works for all platforms (WhatsApp, Instagram, Messenger, Live Chat)
      // Using whatsappInstance which has baseURL PULSE_SERVICE_BASE
      // The full path will be: {baseURL}/messages/session/end
      const response = await whatsappInstance.post("/messages/session/end", {
        conversationId: conversationId,
      });

      if (response.data.success) {
        toast.success("Session ended successfully");
        setShowEndSessionConfirm(false);
        setShowMoreMenu(false);
        // Update session active state immediately (WebSocket event will also update it)
        setIsSessionActive(false);
        // Optionally refresh the contact data or update the session status
      }
    } catch (error: any) {
      console.error("Error ending session:", error);
      const errorData = error?.response?.data;

      // Handle specific error messages based on session status
      if (errorData?.status) {
        const status = errorData.status;
        if (status === "expired") {
          toast.error("Session has already expired");
        } else if (status === "resolved") {
          toast.error("Session has already been resolved");
        } else if (status === "archived") {
          toast.error("Session has already been archived");
        } else {
          toast.error("Session is already ended");
        }
      } else {
        toast.error(
          errorData?.error || errorData?.message || "Failed to end session",
        );
      }
    } finally {
      setIsEndingSession(false);
    }
  };

  // Handle adding note
  const handleAddNote = async () => {
    if (!noteText.trim()) {
      toast.error("Note cannot be empty");
      return;
    }

    const currentUserSub = getCurrentUserSub();
    if (!currentUserSub) {
      toast.error("Unable to get current user information");
      return;
    }

    const contactId = getContactIdForPlatform(contact);
    if (!contactId) {
      toast.error("Unable to get contact ID");
      return;
    }

    const noteToAdd = noteText.trim();

    // Clear text and remove focus immediately - let SSE event handle adding the note
    setNoteText("");
    setIsNoteTextareaFocused(false);

    // Blur the textarea to remove focus and hide buttons immediately
    if (noteTextareaRef.current) {
      noteTextareaRef.current.blur();
    }

    // Set loading state only for the API call, but buttons are already hidden
    setIsAddingNote(true);

    try {
      await addContactNote({
        contactId,
        platform: contact.platform,
        note: noteToAdd,
        sub: currentUserSub,
      });
      toast.success("Note added successfully");
      // The SSE event will handle adding the note to the list - no manual refetch needed
    } catch (error: any) {
      console.error("Error adding note:", error);
      toast.error(error?.response?.data?.message || "Failed to add note");
    } finally {
      setIsAddingNote(false);
    }
  };

  // Format note timestamp
  const formatNoteTimestamp = (timestamp: string): string => {
    try {
      const date = new Date(timestamp);
      const day = date.getDate();
      const month = date.toLocaleDateString("en-US", { month: "short" });
      const year = date.getFullYear();
      const time = date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
      return `${day} ${month} ${year} ${time}`;
    } catch (error) {
      return timestamp;
    }
  };

  // Get user name by sub
  const getUserName = (sub: string): string => {
    const user = noteAuthorMap.get(sub);
    return user ? user.name : sub;
  };

  // Fetch notes from API
  const fetchNotes = useCallback(
    async (
      page: number = 1,
      append: boolean = false,
      showLoading: boolean = true,
    ) => {
      const contactId = getContactIdForPlatform(contact);
      if (!contactId) {
        return;
      }

      const isFirstPage = page === 1;
      if (isFirstPage && showLoading) {
        setIsLoadingNotes(true);
      } else if (!isFirstPage && showLoading) {
        setIsLoadingMoreNotes(true);
      }

      try {
        const result = await getContactNotes({
          contactId,
          platform: contact.platform,
          page,
          limit: 50,
        });

        if (isFirstPage) {
          setNotes(result.notes || []);
        } else {
          setNotes((prev) => {
            // Avoid duplicates by checking created_at and created_by
            const existingKeys = new Set(
              prev.map((n) => `${n.created_by}-${n.created_at}`),
            );
            const newNotes = (result.notes || []).filter(
              (n) => !existingKeys.has(`${n.created_by}-${n.created_at}`),
            );
            return [...prev, ...newNotes];
          });
        }

        setNotesPage(result.page);
        setNotesTotalPages(result.totalPages);
      } catch (error) {
        console.error("Error loading notes:", error);
        if (page === 1) {
          setNotes([]);
        }
        toast.error("Failed to load notes");
      } finally {
        if (showLoading) {
          setIsLoadingNotes(false);
          setIsLoadingMoreNotes(false);
        }
      }
    },
    [contact],
  );

  // Load notes when modal opens
  useEffect(() => {
    if (showNotesModal) {
      setNotesPage(1);
      fetchNotes(1, false, true); // Show loading on initial load
    }
  }, [showNotesModal, fetchNotes]);

  // Set up Socket.IO connection for real-time note events
  const contactId = getContactIdForPlatform(contact);

  useMessageStream({
    type: "contact_notes",
    contactId: contactId || undefined,
    platform: contact.platform,
    onEvent: (event) => {
      if (event.eventType === "contact_note_added" && event.note) {
        const newNote: InternalNote = {
          note: event.note.note,
          created_by: event.note.created_by,
          created_at: event.note.created_at,
        };

        // Add the note to the list (newest first) - no loading indicator
        setNotes((prev) => {
          // Check if note already exists to avoid duplicates
          const exists = prev.some(
            (n) =>
              n.note === newNote.note &&
              n.created_by === newNote.created_by &&
              // Allow small time difference (within 2 seconds) for same note
              Math.abs(
                new Date(n.created_at).getTime() -
                  new Date(newNote.created_at).getTime(),
              ) < 2000,
          );

          if (exists) {
            return prev;
          }

          // Add new note to the beginning
          return [newNote, ...prev];
        });

        // Update pagination if needed
        setNotesTotalPages((prev) => Math.max(prev, 1));

        // Scroll to top to show the new note
        setTimeout(() => {
          if (notesContainerRef.current) {
            notesContainerRef.current.scrollTop = 0;
          }
        }, 50);
      }
    },
    onOpen: () => {
      console.log("✅ Notes Socket.IO connection established");
    },
    onError: (error) => {
      console.error("❌ Notes Socket.IO connection error:", error);
    },
    enabled: showNotesModal && !!contactId,
  });

  // Set up Socket.IO connection for live_chat real-time events (read receipts, typing, online status)

  // Use contact stream for all platforms to receive events
  const { socket: contactSocket } = useMessageStream({
    type: "contact",
    contactId: contactId || undefined,
    platform: contact.platform,
    onEvent: (event) => {
      // Handle message status updates via unified events
      if (
        event.eventType === "message_status_updated" &&
        event.message &&
        onUpdateMessage
      ) {
        requestAnimationFrame(() => {
          onUpdateMessage(event.message?.id || "", {
            status: event.message?.status || "queued",
            read_by_us: event.message?.read_by_us || false,
            read_by_us_at: event.message?.read_by_us_at || "",
          });
        });
        console.log("✅ Message status updated:", {
          id: event.message.id,
          status: event.message.status,
          read_by_us: event.message.read_by_us,
        });
      }

      // Handle message_read events (e.g. Messenger/Instagram read receipts)
      if (
        event.eventType === "message_read" &&
        event.message &&
        onUpdateMessage
      ) {
        const msg = event.message;
        requestAnimationFrame(() => {
          onUpdateMessage(msg.id || "", {
            status: "read",
            read_by_us: true,
            read_by_us_at: msg.read_at ?? msg.read_by_us_at ?? "",
          });
        });
        console.log("✅ Message read event captured:", {
          id: msg.id,
          read_at: msg.read_at,
        });
      }
    },
    enabled: !!contactId,
  });

  // Manually join the chat room for live_chat (required by API)
  useEffect(() => {
    if (!contactSocket || contact.platform !== "live_chat" || !contactId)
      return;

    // Get conversationId from messages
    const convId =
      messages.length > 0 ? messages[0]?.conversation_id : undefined;

    if (convId) {
      // Join the chat room as agent
      const agentUserId = getAgentUserId();
      if (agentUserId) {
        contactSocket.emit("join", {
          type: "chat",
          conversationId: convId,
          userId: agentUserId,
          isAgent: true,
        });
      }
    }
  }, [contactSocket, contact.platform, contactId, messages, getAgentUserId]);

  // Initialize session active state from contact.session.status
  // Works for all platforms (WhatsApp, Instagram, Messenger, Live Chat)
  // Reset when contact changes to prevent state from leaking between contacts
  useEffect(() => {
    if (contact.session) {
      setIsSessionActive(contact.session.status === "active");
    } else {
      // If no session data, check if we can infer from messages
      // For now, set to null if no session data available
      setIsSessionActive(null);
    }
  }, [contact._id, contact.session?.status]);

  // Add direct socket listeners for session status changes (all platforms)
  useEffect(() => {
    // Use contactSocket for all platforms (it's set up for all platforms now)
    const socket = contactSocket;
    if (!socket) return;

    // Listen for session status change events
    const handleSessionStatusChange = (event: {
      type: string;
      conversationId: string;
      platform?: "whatsapp" | "instagram" | "messenger" | "live_chat";
      status: "active" | "expired" | "resolved" | "archived";
      reason?:
        | "INACTIVITY_TIMEOUT"
        | "HARD_SESSION_TIMEOUT"
        | "MANUAL"
        | "RESTARTED";
      closedAt?: string | null;
      restartedAt?: string | null;
      timestamp?: number;
      isActive: boolean;
    }) => {
      // Get conversationId from current contact's session or messages
      // Always read fresh values from the current contact to avoid stale closures
      const currentPlatform = contact.platform;
      const currentConvId =
        messages.length > 0
          ? messages[0]?.conversation_id
          : contact.session?.conversationId;

      // Only handle if this event is for the current conversation
      // Strictly check both conversationId and platform to prevent cross-contact updates
      if (
        event.conversationId === currentConvId &&
        currentConvId && // Ensure we have a conversationId to match
        (!event.platform || event.platform === currentPlatform)
      ) {
        console.log("✅ Session status change event processed:", {
          conversationId: event.conversationId,
          status: event.status,
          isActive: event.isActive,
          reason: event.reason,
        });

        // Update session active state only for the current contact
        // The dependency array ensures this handler is recreated when contact changes
        // Batch state updates using requestAnimationFrame
        requestAnimationFrame(() => {
          setIsSessionActive(event.isActive);
        });
        // No toast messages for session events - UI updates are sufficient
      } else {
        console.log(
          "⚠️ Session status change event ignored (different conversation):",
          {
            eventConversationId: event.conversationId,
            currentConversationId: currentConvId,
            platform: event.platform,
            currentPlatform: currentPlatform,
          },
        );
      }
    };

    // Listen for read receipt events
    const handleReadReceipt = (receipt: {
      messageId: string;
      conversationId: string;
      readAt?: string;
      readByUs?: boolean;
      readByUsAt?: string;
      status?: "sent" | "delivered" | "read";
    }) => {
      if (onUpdateMessage && receipt.messageId) {
        // Batch updates using requestAnimationFrame to avoid excessive re-renders
        requestAnimationFrame(() => {
          onUpdateMessage(receipt.messageId, {
            status: receipt.status,
            read_by_us: receipt.readByUs,
            read_by_us_at: receipt.readByUsAt,
          });
        });

        console.log("✅ Read receipt processed:", {
          messageId: receipt.messageId,
          status: receipt.status,
          readByUs: receipt.readByUs,
        });
      }
    };

    // Listen for typing indicator events
    const handleTyping = (data: {
      conversationId: string;
      userId: string;
      isTyping: boolean;
      isAgent: boolean;
      timestamp?: number;
    }) => {
      // Only show typing indicator for user (not agent) in agent view
      if (!data.isAgent) {
        // Batch state updates using requestAnimationFrame
        requestAnimationFrame(() => {
          setIsUserTyping(data.isTyping);
        });

        console.log("✅ Typing event processed:", {
          userId: data.userId,
          isTyping: data.isTyping,
        });
      }
    };

    // Listen for online status events
    const handleOnlineStatus = (data: {
      conversationId: string;
      userId: string;
      isOnline: boolean;
      isAgent: boolean;
      timestamp?: number;
    }) => {
      // Only track user online status (not agent) in agent view
      if (!data.isAgent) {
        // Batch state updates using requestAnimationFrame
        requestAnimationFrame(() => {
          setIsUserOnline(data.isOnline);
        });

        console.log("✅ Online status event processed:", {
          userId: data.userId,
          isOnline: data.isOnline,
        });
      }
    };

    // Listen for new messages and mark them as read
    const handleMessage = (message: {
      conversationId: string;
      text: string;
      sender: "user" | "agent";
      messageId: string;
      timestamp: Date | string;
      status?: "sent" | "delivered" | "read";
      readByUs?: boolean;
      readByUsAt?: Date | string | null;
    }) => {
      console.log("✅ New message received:", {
        messageId: message.messageId,
        sender: message.sender,
        text: message.text?.substring(0, 30),
        status: message.status,
      });

      // Auto-mark user messages as read when received
      if (message.sender === "user" && !message.readByUs) {
        const agentUserId = getAgentUserId();
        if (agentUserId && message.conversationId) {
          // Use requestAnimationFrame to batch these operations
          requestAnimationFrame(() => {
            // Mark this specific message as read
            markLiveChatMessagesAsRead(message.conversationId, agentUserId, [
              message.messageId,
            ]).catch((err) => {
              console.error("Failed to mark message as read:", err);
            });

            // Also mark all unread messages when new message arrives
            markLiveChatMessagesAsRead(
              message.conversationId,
              agentUserId,
            ).catch((err) => {
              console.error("Failed to mark all messages as read:", err);
            });
          });
        }
      }
    };

    // Listen for session_status_change event (recommended approach)
    // This works for all platforms
    socket.on("session_status_change", handleSessionStatusChange);

    // Also listen via 'message' event for compatibility (session_status_change may come as message type)
    const handleMessageWithSessionCheck = (message: any) => {
      if (message.type === "session_status_change") {
        handleSessionStatusChange(message);
      } else {
        // Handle regular messages (only for live_chat)
        if (contact.platform === "live_chat") {
          handleMessage(message);
        }
      }
    };

    socket.on("message", handleMessageWithSessionCheck);

    // Live chat specific events
    if (contact.platform === "live_chat") {
      socket.on("read_receipt", handleReadReceipt);
      socket.on("typing", handleTyping);
      socket.on("online_status", handleOnlineStatus);
    }

    return () => {
      socket.off("session_status_change", handleSessionStatusChange);
      socket.off("message", handleMessageWithSessionCheck);
      if (contact.platform === "live_chat") {
        socket.off("read_receipt", handleReadReceipt);
        socket.off("typing", handleTyping);
        socket.off("online_status", handleOnlineStatus);
      }
    };
  }, [
    contactSocket,
    contact._id,
    contact.platform,
    contact.session?.conversationId,
    messages,
    onUpdateMessage,
    markMessagesAsRead,
    getAgentUserId,
  ]);

  // Handle infinite scroll for notes
  const handleNotesScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const scrollTop = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;

    // Load more when near bottom (within 100px)
    if (
      scrollHeight - scrollTop - clientHeight < 100 &&
      notesPage < notesTotalPages &&
      !isLoadingMoreNotes &&
      !isLoadingNotes
    ) {
      fetchNotes(notesPage + 1, true, true); // Show loading when loading more
    }
  };

  const priorityIcon = getPriorityIconSrc(contact.priority);

  // Get status configuration for current contact
  const getStatusConfig = (
    status?: UnifiedContact["status"],
  ): {
    label: string;
    bgClass: string;
    textClass: string;
    iconSrc: string;
  } | null => {
    if (!status) return null;

    const base = {
      label: status.replaceAll("_", " "),
    };

    switch (status) {
      case "assigned":
        return {
          ...base,
          bgClass: "bg-[#EFF5FF]",
          textClass: "text-[#3C84F6]",
          iconSrc: "/pulse/status/assigned.svg",
        };
      case "not_assigned":
        return {
          ...base,
          bgClass: "bg-[#FFF3E0]",
          textClass: "text-[#FB8C00]",
          iconSrc: "/pulse/status/unassigned.svg",
        };
      case "lead_created":
        return {
          ...base,
          bgClass: "bg-[#EFFFF3]",
          textClass: "text-[#22C04C]",
          iconSrc: "/pulse/status/lead_created.svg",
        };
      case "insufficient_data":
        return {
          ...base,
          bgClass: "bg-[#E8EAF6]",
          textClass: "text-[#3949AB]",
          iconSrc: "/pulse/status/insufficient.svg",
        };
      case "junk":
        return {
          ...base,
          bgClass: "bg-[#FFEAEA]",
          textClass: "text-[#C31616]",
          iconSrc: "/pulse/status/junk.svg",
        };
      default:
        return null;
    }
  };

  const statusConfig = getStatusConfig(contact.status);
  const currentStatusIcon = statusConfig
    ? statusConfig.iconSrc
    : "/pulse/status/unassigned.svg";
  const currentStatusLabel = statusConfig ? statusConfig.label : "Not assigned";

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (!isLoading && messages.length > 0 && messagesContainerRef.current) {
      const lastMessage = messages[messages.length - 1];
      const isNewMessage = lastMessage.id !== lastMessageIdRef.current;
      const isOutboundMessage = lastMessage.direction === "outbound";

      // Always scroll on initial load
      if (isInitialLoadRef.current) {
        isInitialLoadRef.current = false;
        requestAnimationFrame(() => {
          messagesContainerRef.current!.scrollTop =
            messagesContainerRef.current!.scrollHeight;
        });
        lastMessageIdRef.current = lastMessage.id;
        return;
      }

      // For new messages, check if we should auto-scroll
      if (isNewMessage) {
        const container = messagesContainerRef.current;
        const isNearBottom =
          container.scrollHeight -
            container.scrollTop -
            container.clientHeight <
          150;

        // Always scroll for outbound messages (user sent it)
        // Only scroll for inbound if user is near bottom
        if (isOutboundMessage || isNearBottom) {
          requestAnimationFrame(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
          });
        }

        lastMessageIdRef.current = lastMessage.id;
      }
    }
  }, [messages, isLoading]);

  // Smooth typing indicator transitions + near-bottom auto-scroll when indicator appears.
  const typingSignalActive =
    contact.platform === "live_chat" && (isUserTypingProp || isUserTyping);
  useEffect(() => {
    if (typingSignalActive) {
      if (typingExitTimeoutRef.current) {
        clearTimeout(typingExitTimeoutRef.current);
        typingExitTimeoutRef.current = null;
      }
      setIsTypingIndicatorMounted(true);
      requestAnimationFrame(() => {
        setIsTypingIndicatorVisible(true);
        const container = messagesContainerRef.current;
        if (!container) return;
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceFromBottom < 220) {
          messagesEndRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "end",
          });
        }
      });
      return;
    }

    setIsTypingIndicatorVisible(false);
    typingExitTimeoutRef.current = setTimeout(() => {
      setIsTypingIndicatorMounted(false);
      typingExitTimeoutRef.current = null;
    }, 220);
  }, [typingSignalActive]);

  // Infinite scroll: load older messages when near the top
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;

    // Clear existing timeout (not needed for static display, but keeping for cleanup)
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }

    // Check which date divider is currently visible near the top
    const scrollTop = el.scrollTop;
    const threshold = 100; // Show floating date when scrolling above this threshold

    if (scrollTop > threshold) {
      // Find the date divider that should be shown
      let visibleDate: string | null = null;
      let closestDistance = Infinity;

      // Check all date dividers to find which one is closest to the top
      dateDividerRefs.current.forEach((divElement, messageId) => {
        if (!divElement) return;

        // Calculate the position relative to the scrollable container
        let elementTop = 0;
        let currentElement: HTMLElement | null = divElement;

        while (currentElement && currentElement !== el) {
          elementTop += currentElement.offsetTop;
          currentElement = currentElement.offsetParent as HTMLElement | null;
        }

        // If this divider has scrolled past the top or is near it
        if (elementTop <= scrollTop + 100 && elementTop >= scrollTop - 300) {
          const distance = Math.abs(scrollTop - elementTop);
          if (distance < closestDistance) {
            closestDistance = distance;
            const message = messages.find((m) => m._id === messageId);
            if (message) {
              visibleDate = formatDateDivider(message);
            }
          }
        }
      });

      // Update the floating date (static - always show when above threshold)
      if (visibleDate !== currentVisibleDateRef.current) {
        currentVisibleDateRef.current = visibleDate;
        setFloatingDate(visibleDate);
      }
    } else {
      // Hide when near top
      currentVisibleDateRef.current = null;
      setFloatingDate(null);
    }

    // Handle loading more messages
    if (
      !onLoadMoreMessages ||
      !hasMoreMessages ||
      isLoadingMoreMessages ||
      isLoading
    ) {
      return;
    }
    if (scrollTop < 100) {
      onLoadMoreMessages();
    }
  };

  // Cleanup scroll timeout on unmount
  useEffect(() => {
    return () => {
      if (typingExitTimeoutRef.current) {
        clearTimeout(typingExitTimeoutRef.current);
      }
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Reset initial load flag when contact changes
  useEffect(() => {
    isInitialLoadRef.current = true;
    lastMessageIdRef.current = null;
  }, [contact._id]);

  // Close all modals when contact changes (e.g., when switching tabs or selecting different contact)
  useEffect(() => {
    setShowCreateLeadForm(false);
    setShowNotesModal(false);
    setShowEndSessionConfirm(false);
    setShowStatusMenu(false);
    setShowMoreMenu(false);
    setPreviewMedia(null);
  }, [contact._id]);

  const getPlatformIcon = (platform: UnifiedContact["platform"]): string => {
    switch (platform) {
      case "whatsapp":
        return "/pulse/whatsapp.svg";
      case "instagram":
        return "/pulse/insta.svg";
      case "messenger":
        return "/pulse/facebook.svg";
      case "live_chat":
        return "/pulse/pulse.svg";
      default:
        return "/pulse/pulse.svg";
    }
  };

  // Format timestamp - use display field from API if available
  const formatTimestamp = (message: UnifiedMessage) => {
    // Use display field from API if available
    if (message.timestamp_display) {
      // Extract time from display string (e.g., "Dec 26, 2025 1:20 AM" -> "1:20 AM")
      // Pattern matches: "1:20 AM", "10:30 PM", etc.
      const timeMatch = message.timestamp_display.match(
        /(\d{1,2}:\d{2}\s*(?:AM|PM))/i,
      );
      if (timeMatch && timeMatch[1]) {
        return timeMatch[1];
      }
      // If no time pattern found, return the full display string
      return message.timestamp_display;
    }

    // Fallback when display fields are not available:
    // Prefer canonical millisecond timestamp, then ISO fields.
    let tsMs: number | undefined;

    if (typeof message.timestamp === "number") {
      tsMs = message.timestamp;
    } else if (message.timestamp_iso) {
      const parsed = new Date(message.timestamp_iso).getTime();
      if (!Number.isNaN(parsed)) tsMs = parsed;
    }

    if (!tsMs) return "";

    const date = new Date(tsMs);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Format date divider - use display field from API if available
  const formatDateDivider = (message: UnifiedMessage) => {
    // Use display field from API if available
    if (message.timestamp_display) {
      const displayStr = message.timestamp_display;
      // Extract date part (e.g., "Dec 26, 2025 1:20 AM" -> "Dec 26, 2025")
      const dateMatch = displayStr.match(/^([^0-9]*\d{1,2},?\s*\d{4})/);
      if (dateMatch) {
        const dateStr = dateMatch[1].trim();
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Try to parse the date string
        const messageDate = new Date(dateStr);
        if (!isNaN(messageDate.getTime())) {
          messageDate.setHours(0, 0, 0, 0);

          if (messageDate.getTime() === today.getTime()) {
            return "Today";
          }

          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);
          if (messageDate.getTime() === yesterday.getTime()) {
            return "Yesterday";
          }

          return dateStr;
        }
      }
      // If parsing fails, return the full display string
      return displayStr;
    }

    // Fallback when display fields are not available:
    // Prefer canonical millisecond timestamp, then ISO fields.
    let tsMs: number | undefined;

    if (typeof message.timestamp === "number") {
      tsMs = message.timestamp;
    } else if (message.timestamp_iso) {
      const parsed = new Date(message.timestamp_iso).getTime();
      if (!Number.isNaN(parsed)) tsMs = parsed;
    }

    if (!tsMs) return "";

    const date = new Date(tsMs);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const messageDate = new Date(date);
    messageDate.setHours(0, 0, 0, 0);

    if (messageDate.getTime() === today.getTime()) {
      return "Today";
    }

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (messageDate.getTime() === yesterday.getTime()) {
      return "Yesterday";
    }

    return date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  };

  const shouldShowDateDivider = (
    currentMsg: UnifiedMessage,
    prevMsg?: UnifiedMessage,
  ) => {
    if (!prevMsg) return true;

    // Prefer canonical millisecond timestamp, then ISO fields, then legacy seconds.
    const resolveTsMs = (msg: UnifiedMessage): number | null => {
      if (typeof msg.timestamp === "number") {
        return msg.timestamp;
      }
      if (msg.timestamp_iso) {
        const parsed = new Date(msg.timestamp_iso).getTime();
        if (!Number.isNaN(parsed)) return parsed;
      }
      return null;
    };

    const currentMs = resolveTsMs(currentMsg);
    const prevMs = resolveTsMs(prevMsg);

    if (currentMs === null || prevMs === null) {
      return false;
    }

    const currentDate = new Date(currentMs);
    currentDate.setHours(0, 0, 0, 0);

    const prevDate = new Date(prevMs);
    prevDate.setHours(0, 0, 0, 0);

    return currentDate.getTime() !== prevDate.getTime();
  };

  const downloadFile = async (url: string, filename = "file") => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch file");

      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();

      link.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error("Error downloading file:", error);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-white min-h-0 relative">
      {/* Chat Header */}
      <div className="px-6 py-2 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[2px] bg-[#FFDADB] flex items-center justify-center flex-shrink-0">
            <span className="text-[14px] font-500 text-[#F85356]">
              {getAvatarInitials(
                contact.profile_name || contact.phone_number || "?",
              )}
            </span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-400 text-[#18181E]">
                {contact.profile_name || "Unknown"}
              </span>
              {/* {contact.phone_number && (
                <span className="text-[12px] font-400 text-[#9DA2AB]">
                  {contact.phone_number}
                </span>
              )} */}
              {contact.username && (
                <span className="text-[12px] font-400 text-[#9DA2AB]">
                  @{contact.username}
                </span>
              )}
              {contact.wa_id && (
                <span className="text-[12px] font-400 text-[#9DA2AB]">
                  +{contact.wa_id}
                </span>
              )}
              <Image
                src={getPlatformIcon(contact.platform)}
                alt={contact.platform}
                width={16}
                height={16}
              />
              {/* Online status indicator for live_chat */}
              {contact.platform === "live_chat" && isUserOnline !== null && (
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      isUserOnline ? "bg-[#22C04C]" : "bg-[#9DA2AB]"
                    }`}
                    style={{ flexShrink: 0 }}
                  />
                  <span
                    className={`text-[12px] font-400 ${
                      isUserOnline ? "text-[#22C04C]" : "text-[#9DA2AB]"
                    }`}
                  >
                    {isUserOnline ? "Online" : "Offline"}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          {/* Set Status Dropdown */}
          <div className="relative" ref={statusMenuRef}>
            <CustomTooltip content="Set Status">
              <button
                type="button"
                onClick={() => setShowStatusMenu(!showStatusMenu)}
                className={`text-[12px] rounded-[20px] px-2.5 py-1 transition-colors capitalize flex items-center gap-2 cursor-pointer ${
                  statusConfig
                    ? `${statusConfig.bgClass} ${statusConfig.textClass}`
                    : "bg-[#F5F5F5] text-[#18181E]"
                }`}
              >
                {statusConfig && (
                  <Image
                    src={currentStatusIcon}
                    alt={currentStatusLabel}
                    width={16}
                    height={16}
                  />
                )}
                <span>{statusConfig ? currentStatusLabel : "Set Status"}</span>
                {!statusConfig && (
                  <Image
                    src="/icons/arrowdown.svg"
                    alt="dropdown"
                    width={16}
                    height={16}
                    className={`transition-transform ${
                      showStatusMenu ? "rotate-180" : ""
                    }`}
                  />
                )}
              </button>
            </CustomTooltip>

            {showStatusMenu && (
              <div className="absolute right-0 top-full mt-4 z-50">
                <PulseContactActionsMenu
                  placement="right"
                  assignUserSelectPlacement="conversation"
                  priorityRowIconSrc={priorityIcon}
                  assignableUsers={assignableUsers}
                  assignableUsersLoading={assignableUsersLoading}
                  showUnassign={Boolean(contact.assigned_to)}
                  onAssignToMe={handleAssignToMe}
                  onAssignToUser={handleAssignToUser}
                  onPriorityChange={handlePriorityChange}
                  onUnassign={handleUnassign}
                  canAssignConversation={canAssignConversation}
                  canModifyConversation={canModifyConversation}
                  canCreateLead={canCreateLead}
                  onCreateLead={async () => {
                    if (!canCreateLead) return;
                    setShowStatusMenu(false);
                    const contactId = getContactIdForPlatform(contact);
                    const conversationId =
                      messages.length > 0
                        ? messages[messages.length - 1]?.conversation_id
                        : contact.session?.conversationId;
                    if (contactId && conversationId) {
                      try {
                        const res = await terminateVirtualAgent({
                          contactId,
                          conversationId,
                        });
                        const aiAttrs =
                          res.aiData?.ai_attributes_collected ??
                          (res as any).ai_attributes_collected ??
                          {};
                        const collected = res.aiData?.collected ?? {};
                        setCreateLeadInitialData({
                          ...collected,
                          ...(Object.keys(aiAttrs).length > 0
                            ? { ai_attributes_collected: aiAttrs }
                            : {}),
                        });
                        setCreateLeadAiData(
                          res.aiData?.summary
                            ? { summary: res.aiData.summary }
                            : undefined,
                        );
                      } catch (err) {
                        console.error("Virtual agent terminate failed:", err);
                        toast.error(
                          "Could not fetch AI summary. Opening form without prefill.",
                        );
                        setCreateLeadInitialData(undefined);
                        setCreateLeadAiData(undefined);
                      }
                    } else {
                      setCreateLeadInitialData(undefined);
                      setCreateLeadAiData(undefined);
                    }
                    setShowCreateLeadForm(true);
                  }}
                  onInsufficientData={() =>
                    handleStatusChange("insufficient_data")
                  }
                  onMarkJunk={() => handleStatusChange("junk")}
                />
              </div>
            )}
          </div>
          <CustomTooltip content="Internal Notes">
            <button
              type="button"
              onClick={() => {
                setShowNotesModal(true);
                setNoteText("");
              }}
              className="cursor-pointer hover:opacity-80 transition-opacity"
            >
              <Image
                src="/pulse/notes.svg"
                alt="Notes"
                width={24}
                height={24}
              />
            </button>
          </CustomTooltip>
          {/* <button className="hover:bg-gray-100 rounded transition-colors">
            <Image
              src="/icons/search.svg"
              alt="Search"
              width={24}
              height={24}
            />
          </button> */}
          {/* More Menu — End Session only (contact actions live under Set Status) */}
          {canCloseConversation &&
            (contact.session?.conversationId ||
              (messages.length > 0 && messages[0]?.conversation_id)) && (
              <div className="relative flex items-center" ref={moreMenuRef}>
                <CustomTooltip content="More">
                  <button
                    type="button"
                    onClick={() => {
                      setShowMoreMenu(!showMoreMenu);
                      setShowStatusMenu(false);
                    }}
                    className="cursor-pointer hover:opacity-80 transition-opacity p-0 flex items-center justify-center"
                    style={{ width: 24, height: 24 }}
                  >
                    <Image
                      src="/pulse/more.svg"
                      alt="More"
                      width={24}
                      height={24}
                    />
                  </button>
                </CustomTooltip>
                {showMoreMenu && (
                  <div
                    className="absolute right-0 top-full mt-4 bg-white rounded-[4px] z-50 min-w-[200px] p-1"
                    style={{
                      zIndex: 10000,
                      boxShadow: "0px 2px 15px 0px #6315FF17",
                    }}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isSessionActive !== false) {
                          setShowEndSessionConfirm(true);
                          setShowMoreMenu(false);
                        }
                      }}
                      disabled={
                        isSessionActive === false || !canCloseConversation
                      }
                      className={`flex items-center gap-2 w-full px-2 py-1.5 text-left text-[14px] text-[#36363D] rounded-[4px] ${
                        isSessionActive === false
                          ? "cursor-not-allowed opacity-50"
                          : "hover:bg-[#F6F6F6] cursor-pointer"
                      }`}
                    >
                      <Image
                        src="/icons/status.svg"
                        alt="End Session"
                        width={20}
                        height={20}
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                      {isSessionActive === false
                        ? contact.session?.status === "expired"
                          ? "Session Expired"
                          : "Session Ended"
                        : "End Session"}
                    </button>
                  </div>
                )}
              </div>
            )}
        </div>
      </div>

      {/* Messages Area */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto custom-select-scrollbar px-6 py-4 space-y-4 min-h-0 bg-[#FAFBFC] relative"
        onScroll={handleScroll}
      >
        {/* Floating Date Indicator */}
        {floatingDate && (
          <div className="sticky top-0 z-10 flex justify-center py-2 mb-2 pointer-events-none">
            <div className="bg-[#FAFBFC] px-3 py-1 rounded">
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-[#EFEFEF]"></div>
                <span className="text-[14px] font-400 leading-[20px] text-[#525261] whitespace-nowrap">
                  {floatingDate}
                </span>
                <div className="flex-1 h-px bg-[#EFEFEF]"></div>
              </div>
            </div>
          </div>
        )}
        {isLoading ? (
          <div className="flex items-center justify-center py-16 min-h-[min(280px,45vh)]">
            <PulseSpinner />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-gray-500">No messages yet</div>
          </div>
        ) : (
          <>
            {isLoadingMoreMessages && hasMoreMessages && (
              <div className="flex items-center justify-center py-2">
                <PulseSpinner size="sm" />
              </div>
            )}
            {messages.map((message, index) => (
              <div key={message._id}>
                {/* Date Divider */}
                {shouldShowDateDivider(message, messages[index - 1]) && (
                  <div
                    ref={(el) => {
                      if (el) {
                        dateDividerRefs.current.set(message._id, el);
                      } else {
                        dateDividerRefs.current.delete(message._id);
                      }
                    }}
                    className="text-center my-2"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-px bg-[#EAEBF2]"></div>
                      <span className="text-[14px] font-400 leading-[20px] text-[#525261] px-3 py-1 rounded whitespace-nowrap">
                        {formatDateDivider(message)}
                      </span>
                      <div className="flex-1 h-px bg-[#EAEBF2]"></div>
                    </div>
                  </div>
                )}

                {/* Message */}
                {message.direction === "inbound" ? (
                  <InboundMessage
                    message={message}
                    formatTimestamp={formatTimestamp}
                    onMediaClick={handleMediaClick}
                  />
                ) : (
                  <OutboundMessage
                    message={message}
                    formatTimestamp={formatTimestamp}
                    onMediaClick={handleMediaClick}
                  />
                )}
              </div>
            ))}

            {/* Typing Indicator for live_chat */}
            {contact.platform === "live_chat" && isTypingIndicatorMounted && (
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div
                      className={`astra-typing-shell astra-typing-shell-transition ${
                        isTypingIndicatorVisible
                          ? "astra-typing-shell-visible"
                          : "astra-typing-shell-hidden"
                      }`}
                    >
                      <span className="astra-typing-dot astra-typing-dot-1" />
                      <span className="astra-typing-dot astra-typing-dot-2" />
                      <span className="astra-typing-dot astra-typing-dot-3" />
                    </div>
                  </div>
                </div>
              )}

            {/* Scroll anchor - always at the bottom */}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Message Input Area */}
      <div className="flex-shrink-0">
        <MessageInput
          onSendMessage={canReplyConversation ? onSendMessage : undefined}
          onSendMedia={canReplyConversation ? onSendMedia : undefined}
          onTyping={canReplyConversation ? onTyping : undefined}
          isSending={isSending}
          platform={contact.platform}
          canReply={canReplyConversation}
        />
      </div>

      {/* Media Preview Modal */}
      {previewMedia && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
          onClick={() => setPreviewMedia(null)}
        >
          <div
            className="overflow-auto flex items-center justify-center flex-col gap-5"
            onClick={(e) => e.stopPropagation()}
          >
            {isPreviewLoading ? (
              <PulseSpinner className="min-h-[120px]" />
            ) : previewMedia.type === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewMedia.url}
                alt={previewMedia.filename}
                className="max-h-[70vh] max-w-[80vw] rounded"
              />
            ) : (
              <div className="flex items-center justify-center gap-2 p-2 rounded-[4px] border border-[#9DA2AB] cursor-pointer">
                <a
                  href={previewMedia.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[14px] text-white"
                  style={{ fontFamily: "DM Sans" }}
                >
                  {previewMedia.filename}
                </a>
              </div>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void downloadFile(previewMedia.url, previewMedia.filename);
              }}
              className="z-[12000] text-[#FFFFFF] px-3 py-2 text-[14px] font-medium leading-[16px] flex items-center gap-1 rounded-[4px] cursor-pointer border border-[#9DA2AB]"
              style={{ fontFamily: "DM Sans" }}
            >
              <Image
                src="/pulse/download.svg"
                alt="Download"
                width={16}
                height={16}
              />
              Download
            </button>
          </div>
        </div>
      )}

      {/* Notes Modal - Positioned at top right */}
      {showNotesModal && (
        <div
          ref={notesModalRef}
          className="absolute top-16 right-6 z-[10000] w-[700px] max-h-[400px] bg-white rounded-[4px] shadow-2xl flex flex-col"
          style={{ boxShadow: "0px 2px 15px 0px #18181E17" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 h-8 bg-[#F2ECFF] flex-shrink-0">
            <h3
              className="text-[14px] font-semibold text-[#18181E]"
              style={{ fontFamily: "DM Sans, sans-serif" }}
            >
              Internal Notes
            </h3>
            <button
              type="button"
              onClick={() => {
                setShowNotesModal(false);
                setNoteText("");
              }}
              className="cursor-pointer"
            >
              <Image src="/icons/x.svg" alt="Close" width={20} height={20} />
            </button>
          </div>

          {/* Add Note Section */}
          <div className="border-b border-[#EFEFEF] mx-4 pt-4 flex-shrink-0">
            <div className="mb-3">
              <textarea
                ref={noteTextareaRef}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onFocus={() => setIsNoteTextareaFocused(true)}
                onBlur={() => {
                  // Delay blur to allow button clicks
                  setTimeout(() => {
                    setIsNoteTextareaFocused(false);
                  }, 200);
                }}
                placeholder="Type your note"
                className="w-full border-none rounded-[4px] text-[14px] text-[#525261] font-light focus:outline-none resize-none custom-select-scrollbar"
                rows={3}
              />
            </div>
            {(isNoteTextareaFocused || notes.length === 0) && (
              <div className="flex justify-between mb-2">
                <Button
                  variant="secondary"
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent textarea blur
                  }}
                  onClick={() => {
                    setShowNotesModal(false);
                    setNoteText("");
                    setIsNoteTextareaFocused(false);
                  }}
                  disabled={isAddingNote}
                  className="w-[78px] h-[32px] bg-white"
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent textarea blur
                  }}
                  onClick={handleAddNote}
                  disabled={isAddingNote || !noteText.trim()}
                  className="w-[78px] h-[32px] bg-white"
                >
                  {isAddingNote ? "Saving..." : "Save"}
                </Button>
              </div>
            )}
          </div>

          {/* Notes List - Scrollable with Infinite Scroll */}
          {notes.length > 0 || isLoadingNotes ? (
            <div
              ref={notesContainerRef}
              className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0 custom-select-scrollbar"
              onScroll={handleNotesScroll}
            >
              {isLoadingNotes && notes.length === 0 ? (
                <PulseInlineLoading minHeight="160px" className="py-8" />
              ) : (
                <>
                  {notes.map((note, index) => {
                    const userName = getUserName(note.created_by);
                    const formattedDate = formatNoteTimestamp(note.created_at);
                    return (
                      <div
                        key={`${note.created_by}-${note.created_at}-${index}`}
                        className="border-b border-[#EFEFEF] pb-4 last:border-b-0 last:pb-0"
                      >
                        <div
                          className="text-xs text-gray-500 mb-2"
                          style={{ fontFamily: "DM Sans, sans-serif" }}
                        >
                          <span className="text-[12px] font-light text-[#525261]">
                            By
                          </span>{" "}
                          <span className="text-[14px] font-regular text-[#18181E]">
                            {userName}
                          </span>{" "}
                          <span className="text-[12px] font-light text-[#525261]">
                            on
                          </span>{" "}
                          <span className="text-[14px] font-regular text-[#18181E]">
                            {formattedDate}
                          </span>
                        </div>
                        <div
                          className="text-[14px] text-[#525261] whitespace-pre-wrap text-justify"
                          style={{ fontFamily: "DM Sans, sans-serif" }}
                        >
                          {note.note}
                        </div>
                      </div>
                    );
                  })}
                  {isLoadingMoreNotes && (
                    <div className="flex justify-center py-2">
                      <PulseSpinner size="sm" />
                    </div>
                  )}
                </>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* End Session Confirmation Modal */}
      {showEndSessionConfirm && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
          onClick={() => setShowEndSessionConfirm(false)}
        >
          <div
            ref={endSessionConfirmRef}
            className="bg-white rounded-[4px] p-6 max-w-[400px] w-full mx-4"
            style={{
              boxShadow: "0px 2px 15px 0px #18181E17",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              className="text-[14px] font-semibold text-[#18181E] mb-2"
              style={{ fontFamily: "DM Sans, sans-serif" }}
            >
              End Session
            </h3>
            <p
              className="text-[14px] text-[#525261] mb-6"
              style={{ fontFamily: "DM Sans, sans-serif" }}
            >
              Are you sure you want to end this session? This action cannot be
              undone.
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="secondary"
                onClick={() => setShowEndSessionConfirm(false)}
                disabled={isEndingSession}
                className="w-[78px] h-[32px] bg-white"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleEndSession}
                disabled={isEndingSession}
                className="h-[32px] bg-white"
              >
                {isEndingSession ? "Ending..." : "End Session"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Create Lead Form Modal - only update contact status when lead is created */}
      {showCreateLeadForm && (
        <>
          <div
            className="fixed inset-0 bg-black z-[500]"
            style={{
              backdropFilter: "blur(214px)",
              opacity: 0.5,
            }}
            onClick={() => setShowCreateLeadForm(false)}
          />
          <div className="fixed right-0 top-0 bottom-0 w-[70vw] max-w-[1500px] z-[1000] shadow-2xl scrollbar-hide">
            <CreateLeadForm
              initialData={createLeadInitialData}
              onCancel={() => {
                setShowCreateLeadForm(false);
                setCreateLeadInitialData(undefined);
                setCreateLeadAiData(undefined);
              }}
              onCreate={async (form, createdLeadId) => {
                if (
                  createdLeadId &&
                  createLeadAiData?.summary &&
                  createLeadAiData.summary.trim()
                ) {
                  try {
                    const tenantId = getCookie("tenantId") as string;
                    const claims = getUserFromIdToken(
                      getCookie("idToken") as string,
                    );
                    await leadInstance.post("/notes", {
                      content: `<p>${String(createLeadAiData.summary)
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")}</p>`,
                      leadId: createdLeadId,
                      createdBy: claims?.sub || "system",
                      organizationId: tenantId || "system",
                    });
                    toast.success("Lead and AI summary note created");
                  } catch (e) {
                    console.error("Failed to create AI summary note:", e);
                    toast.success("Lead created");
                  }
                }
                const cid = getContactIdForPlatform(contact);
                if (cid) {
                  try {
                    await updateContactStatus({
                      contactId: cid,
                      platform: contact.platform,
                      status: "lead_created",
                    });
                    toast.success("Contact status updated to lead created");
                  } catch (error: any) {
                    console.error("Error updating contact status:", error);
                    toast.error(
                      error?.response?.data?.message ||
                        "Failed to update contact status",
                    );
                  }
                }
                setShowCreateLeadForm(false);
                setCreateLeadInitialData(undefined);
                setCreateLeadAiData(undefined);
              }}
            />
          </div>
        </>
      )}
      <style jsx>{`
        .astra-typing-shell {
          width: 60px;
          height: 48px;
          border-top-left-radius: 10px;
          border-top-right-radius: 10px;
          border-bottom-right-radius: 10px;
          border-bottom-left-radius: 0;
          padding: 14px 16px;
          gap: 4px;
          display: inline-flex;
          align-items: center;
          justify-content: flex-start;
          background: #f5f5f5;
        }

        .astra-typing-shell-transition {
          transition:
            opacity 0.2s ease,
            transform 0.2s ease;
          will-change: opacity, transform;
        }

        .astra-typing-shell-visible {
          opacity: 1;
          transform: translateY(0);
        }

        .astra-typing-shell-hidden {
          opacity: 0;
          transform: translateY(4px);
        }

        .astra-typing-dot {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: #9ca3af;
          transform-origin: center;
          animation: astraTypingDots 1.15s infinite ease-in-out;
        }

        .astra-typing-dot-1 {
          animation-delay: 0s;
        }

        .astra-typing-dot-2 {
          animation-delay: 0.18s;
        }

        .astra-typing-dot-3 {
          animation-delay: 0.36s;
        }

        @keyframes astraTypingDots {
          0%,
          100% {
            transform: scale(1);
            background: #9ca3af;
            opacity: 0.78;
          }
          30% {
            transform: scale(1.33);
            background: #8d53f8;
            opacity: 1;
          }
          60% {
            transform: scale(1.08);
            background: #b5bac4;
            opacity: 0.92;
          }
        }
      `}</style>
    </div>
  );
}

interface MessageProps {
  message: UnifiedMessage;
  formatTimestamp: (message: UnifiedMessage) => string;
  onMediaClick?: (message: UnifiedMessage) => void;
}

function resolveMessageFlow(
  message: UnifiedMessage,
): NonNullable<UnifiedMessage["flow"]> | null {
  const direct = message.flow;
  if (direct && typeof direct === "object") return direct;
  const raw = message.raw_payload;
  if (raw && typeof raw === "object" && "flow" in raw) {
    const nested = (raw as { flow?: UnifiedMessage["flow"] }).flow;
    if (nested && typeof nested === "object") return nested;
  }
  return null;
}

function getMessageFlowOptionLabels(message: UnifiedMessage): {
  key: string;
  label: string;
}[] {
  const flow = resolveMessageFlow(message);
  const options = flow?.options;
  if (!Array.isArray(options) || options.length === 0) return [];
  return options
    .map((opt, index) => {
      const id = typeof opt?.id === "string" ? opt.id.trim() : "";
      const title = typeof opt?.title === "string" ? opt.title.trim() : "";
      const label = title || id;
      if (!label) return null;
      return { key: id || `flow-opt-${index}`, label };
    })
    .filter((x): x is { key: string; label: string } => x != null);
}

function extractNumberedOptions(text: string | null): {
  cleanedText: string | null;
  options: string[];
} {
  if (!text) return { cleanedText: null, options: [] };
  const normalized = text.trim();
  if (!normalized) return { cleanedText: null, options: [] };

  const optionRegex = /(?:^|\s)(\d+)\.\s+(.+?)(?=(?:\s+\d+\.\s+)|$)/g;
  const matches = Array.from(normalized.matchAll(optionRegex));

  if (matches.length < 2) {
    return { cleanedText: normalized, options: [] };
  }

  const firstMatch = matches[0];
  if (!firstMatch || firstMatch.index == null) {
    return { cleanedText: normalized, options: [] };
  }

  const prefix = normalized.slice(0, firstMatch.index).trim();
  const options = matches
    .map((match) => String(match[2] || "").trim())
    .filter((label) => label.length > 0);

  if (options.length < 2) {
    return { cleanedText: normalized, options: [] };
  }

  return {
    cleanedText: prefix || null,
    options,
  };
}

function shouldParseFallbackOptions(text: string | null): boolean {
  if (!text) return false;

  // Question-node validation rules often contain comma-separated values.
  // Keep the original text intact instead of trying to split it into chips.
  if (/validation\s*rules?/i.test(text)) {
    return false;
  }

  return true;
}

function PdfFileIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M18.7059 22H5.29412C4.5794 22 4 21.3604 4 20.5714V3.42857C4 2.63959 4.5794 2 5.29412 2H14L20 8.62338V20.5714C20 21.3604 19.4206 22 18.7059 22Z"
        fill="#975FFF"
      />
      <g opacity="0.1">
        <path d="M15.7058 11.026H8.29407V10.2468H15.7058V11.026Z" fill="white" />
        <path d="M15.7058 12.9741H8.29407V12.1949H15.7058V12.9741Z" fill="white" />
        <path d="M8.29407 14.9222H15.7058V14.1429H8.29407V14.9222Z" fill="white" />
        <path d="M15.7058 16.8702H8.29407V16.091H15.7058V16.8702Z" fill="white" />
        <path d="M8.29407 18.8183H15.7058V18.039H8.29407V18.8183Z" fill="white" />
      </g>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7.42812 16.1417C7.49127 16.2114 7.57112 16.2464 7.66002 16.2464C7.74819 16.2464 7.82745 16.212 7.89036 16.1434C7.95653 16.0747 7.99143 15.9862 7.99143 15.8857V14.9178H8.71955C9.02593 14.9178 9.28687 14.861 9.4952 14.7383C9.69765 14.6191 9.85026 14.4617 9.94387 14.263C10.0334 14.073 10.078 13.8677 10.078 13.6491C10.078 13.4305 10.0334 13.2252 9.94387 13.0351C9.85026 12.8364 9.69765 12.679 9.4952 12.5598C9.28687 12.4371 9.02593 12.3804 8.71955 12.3804H7.66002C7.56896 12.3804 7.48877 12.4189 7.42658 12.4919C7.36446 12.5614 7.33325 12.6489 7.33325 12.7462V15.8857C7.33325 15.9838 7.36497 16.072 7.42812 16.1417ZM9.2622 14.0515L9.26168 14.052L9.26117 14.0526C9.16795 14.1505 8.98549 14.2169 8.67772 14.2169H7.99143V13.0813H8.67772C8.98549 13.0813 9.16795 13.1477 9.26117 13.2456L9.26168 13.2461L9.2622 13.2466C9.36802 13.3551 9.41978 13.4863 9.41978 13.6491C9.41978 13.8118 9.36802 13.943 9.2622 14.0515Z"
        fill="white"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M13.0014 15.9441L13.0017 15.9439C13.2664 15.7577 13.4673 15.5164 13.6014 15.2205C13.7333 14.9291 13.7997 14.622 13.7997 14.3006C13.7997 13.9791 13.7333 13.672 13.6014 13.3807C13.4673 13.0848 13.2664 12.8451 13.0016 12.6622C12.7343 12.472 12.4122 12.3804 12.0416 12.3804H11.1076C11.0165 12.3804 10.9363 12.4189 10.8741 12.4919C10.812 12.5614 10.7808 12.6489 10.7808 12.7462V15.86C10.7808 15.9582 10.8125 16.0463 10.8757 16.116C10.9388 16.1857 11.0187 16.2208 11.1076 16.2208H12.0416C12.4122 16.2208 12.7341 16.1309 13.0014 15.9441ZM13.0034 13.6618L13.0036 13.6622L13.0039 13.6626C13.0975 13.8419 13.1461 14.0532 13.1461 14.3006C13.1461 14.5477 13.0976 14.7609 13.0037 14.944C12.9096 15.124 12.7772 15.2661 12.6037 15.3713C12.4315 15.4724 12.2282 15.525 11.9905 15.525H11.439V13.0761H11.9905C12.2279 13.0761 12.431 13.1304 12.6031 13.2346L12.6037 13.235L12.6044 13.2353C12.7771 13.3368 12.9093 13.4785 13.0034 13.6618Z"
        fill="white"
      />
      <path
        d="M14.6908 16.1417C14.7539 16.2114 14.8338 16.2464 14.9227 16.2464C15.0109 16.2464 15.0901 16.212 15.153 16.1434C15.2192 16.0747 15.2541 15.9862 15.2541 15.8857V14.6459H16.5677C16.6518 14.6459 16.7282 14.6139 16.7887 14.5481C16.8524 14.4823 16.8852 14.3968 16.8852 14.3006C16.8852 14.2052 16.853 14.1204 16.7904 14.0548C16.7309 13.9857 16.6541 13.9501 16.5677 13.9501H15.2541V13.0761H16.7304C16.8145 13.0761 16.8909 13.0441 16.9513 12.9784C17.0151 12.9125 17.0479 12.8271 17.0479 12.7308C17.0479 12.6355 17.0156 12.5507 16.953 12.485C16.8936 12.4159 16.8168 12.3804 16.7304 12.3804H14.9227C14.8316 12.3804 14.7514 12.4189 14.6892 12.4919C14.6271 12.5614 14.5959 12.6489 14.5959 12.7462V15.8857C14.5959 15.9838 14.6276 16.072 14.6908 16.1417Z"
        fill="white"
      />
      <path
        d="M20.0001 8.62338H15.2942C14.5795 8.62338 14.0001 7.98378 14.0001 7.19481V2L20.0001 8.62338Z"
        fill="#8D53F8"
      />
    </svg>
  );
}

function getMediaChipMeta(message: UnifiedMessage) {
  // Try to get filename from media_storage_url first, then fallback to media_url
  const storageKey = message.media_storage_url ?? "";
  let filename = storageKey.split("/").pop() || "";

  // If no filename from storage_url, try to extract from media_url
  if (!filename && message.media_url) {
    try {
      const url = new URL(message.media_url);
      // Try to get filename from pathname
      const pathParts = url.pathname.split("/").filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart && lastPart.includes(".")) {
        filename = lastPart;
      }
    } catch {
      // URL parsing failed, ignore
    }
  }

  // If still no filename, use "file" as fallback
  if (!filename) {
    filename = "file";
  }

  const lower = filename.toLowerCase();

  const isImage =
    message.type === "image" ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".gif");

  // Use a more descriptive label if filename is just "file"
  const label =
    filename === "file" && message.type
      ? `${message.type.charAt(0).toUpperCase() + message.type.slice(1)} File`
      : filename;

  return { label, isImage };
}

function isLikelyIdentifier(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  const uuidLike =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const compactIdLike = /^[a-z0-9-]{20,}$/i;
  return uuidLike.test(normalized) || compactIdLike.test(normalized);
}

function InboundMessage({
  message,
  formatTimestamp,
  onMediaClick,
}: MessageProps) {
  // Check for media - handle both null and empty string for text_body
  // Check for both media_storage_url (S3) and media_url (external CDN like Facebook/Instagram)
  const hasMediaUrl =
    (!!message.media_storage_url && message.media_storage_url.trim() !== "") ||
    (!!message.media_url && message.media_url.trim() !== "");
  const hasMedia =
    (message.type === "image" ||
      message.type === "document" ||
      message.type === "video" ||
      message.type === "audio") &&
    hasMediaUrl;
  const { label } = getMediaChipMeta(message);
  // Normalize text_body - treat empty string as null
  const normalizedTextBody =
    message.text_body && message.text_body.trim()
      ? message.text_body.trim()
      : null;
  const hasContent = normalizedTextBody || hasMedia;

  if (!hasContent) {
    return null;
  }

  return (
    <div className="flex items-start gap-3">
      <div className="flex-1">
        <div className="bg-[#F5F7F9] rounded-[10px] rounded-tl-none px-4 py-[14px] max-w-[700px] w-fit">
          {normalizedTextBody && (
            <p className="text-[14px] font-400 leading-[20px] text-[#18181E]">
              {normalizedTextBody}
            </p>
          )}
          {hasMedia && (
            <button
              type="button"
              onClick={() => onMediaClick?.(message)}
              className={`${
                normalizedTextBody ? "mt-2" : ""
              } flex items-center gap-2 h-9 px-3 rounded-[6px] bg-white cursor-pointer hover:bg-[#F4F4FF] border border-[#EFEFEF]`}
              style={{
                fontFamily: "DM Sans",
                fontWeight: 400,
                fontSize: "14px",
                lineHeight: "20px",
                color: "#18181E",
              }}
            >
              <PdfFileIcon />
              <span className="truncate max-w-[220px]">{label}</span>
            </button>
          )}
        </div>
        <span className="text-[12px] font-400 leading-[16px] text-[#18181E] mt-2 block">
          {formatTimestamp(message)}
        </span>
      </div>
    </div>
  );
}

function OutboundMessage({
  message,
  formatTimestamp,
  onMediaClick,
}: MessageProps) {
  // Check for media - handle both null and empty string for text_body
  // Check for both media_storage_url (S3) and media_url (external CDN like Facebook/Instagram)
  const hasMediaUrl =
    (!!message.media_storage_url && message.media_storage_url.trim() !== "") ||
    (!!message.media_url && message.media_url.trim() !== "");
  const hasMedia =
    (message.type === "image" ||
      message.type === "document" ||
      message.type === "video" ||
      message.type === "audio") &&
    hasMediaUrl;
  const { label } = getMediaChipMeta(message);
  // Normalize text_body - treat empty string as null
  const normalizedTextBody =
    message.text_body && message.text_body.trim()
      ? message.text_body.trim()
      : null;
  const flowOptionLabelsFromPayload = getMessageFlowOptionLabels(message);
  const fallbackOptionParse =
    flowOptionLabelsFromPayload.length === 0 &&
    shouldParseFallbackOptions(normalizedTextBody)
      ? extractNumberedOptions(normalizedTextBody)
      : { cleanedText: normalizedTextBody, options: [] };
  const displayText = fallbackOptionParse.cleanedText;
  const flowOptionLabels =
    flowOptionLabelsFromPayload.length > 0
      ? flowOptionLabelsFromPayload
      : fallbackOptionParse.options.map((label, index) => ({
          key: `text-opt-${index}`,
          label,
        }));
  const hasContent = displayText || hasMedia || flowOptionLabels.length > 0;

  const getAgentLabel = () => {
    const fromAgentObject = message.agent?.name?.trim();
    if (fromAgentObject && !isLikelyIdentifier(fromAgentObject)) {
      return fromAgentObject;
    }

    const agentId = message.agent_id?.trim();

    const fromFlatField = message.agent_name?.trim();
    if (
      fromFlatField &&
      (!agentId || fromFlatField !== agentId) &&
      !isLikelyIdentifier(fromFlatField)
    ) {
      return fromFlatField;
    }

    // Fallback: if this is an AI reply with no explicit agent identity, show Pulse AI
    if (message.is_ai_reply) {
      return "Pulse AI";
    }

    // Final fallback when no attribution is available
    return "Agent";
  };

  const getStatusIcon = () => {
    // For live_chat, show read receipts for outbound messages (agent messages)
    if (message.platform === "live_chat") {
      switch (message.status) {
        case "read":
          return (
            <Image src="/pulse/read.svg" alt="Read" width={16} height={16} />
          );
        case "delivered":
          return (
            <Image
              src="/pulse/delivered.svg"
              alt="Delivered"
              width={16}
              height={16}
            />
          );
        case "sent":
          return (
            <Image src="/pulse/sent.svg" alt="Sent" width={16} height={16} />
          );
        case "queued":
          return (
            <Image
              src="/pulse/queued.svg"
              alt="Queued"
              width={16}
              height={16}
            />
          );
        default:
          return null;
      }
    }

    switch (message.status) {
      case "read":
        return (
          <Image src="/pulse/read.svg" alt="Read" width={20} height={20} />
        );
      case "delivered":
        return (
          <Image
            src="/pulse/delivered.svg"
            alt="Delivered"
            width={20}
            height={20}
          />
        );
      case "sent":
        return (
          <Image src="/pulse/sent.svg" alt="Sent" width={20} height={20} />
        );
      case "queued":
        return (
          <Image src="/pulse/queued.svg" alt="Queued" width={20} height={20} />
        );
      case "failed":
        return (
          <Image
            src="/icons/outOfOffice.svg"
            alt="Failed"
            width={20}
            height={20}
          />
        );
      default:
        return null;
    }
  };

  if (!hasContent) {
    return null;
  }

  const isAiReply = message.is_ai_reply === true;

  return (
    <div className="flex items-end justify-end gap-3">
      <div className="flex-1 flex justify-end">
        <div className="max-w-md">
          {isAiReply && (
            <div className="flex justify-end mb-0.5">
              <span className="text-[11px] font-400 text-[#6b7280]">
                {getAgentLabel()}
              </span>
            </div>
          )}
          <div className="bg-[#ECE1FF] rounded-[10px] rounded-br-none px-4 py-[14px]">
            {displayText && (
              <p className="text-[14px] font-400 leading-[20px] text-[#18181E]">
                {displayText}
              </p>
            )}

            {hasMedia && (
              <div className={displayText ? "mt-2" : ""}>
                <button
                  type="button"
                  onClick={() => onMediaClick?.(message)}
                  className="flex items-center gap-2 h-9 px-3 rounded-[6px] bg-white cursor-pointer hover:bg-[#F4F4FF] border border-[#EFEFEF]"
                  style={{
                    fontFamily: "DM Sans",
                    fontWeight: 400,
                    fontSize: "14px",
                    lineHeight: "20px",
                    color: "#18181E",
                  }}
                >
                  <PdfFileIcon />
                  <span className="truncate max-w-[220px]">{label}</span>
                </button>
              </div>
            )}
            {flowOptionLabels.length > 0 ? (
              <ul
                className={`m-0 list-none flex flex-wrap gap-2 p-0 ${displayText || hasMedia ? "mt-3" : ""}`}
                aria-label="Conversation options shown to visitor"
              >
                {flowOptionLabels.map((opt) => (
                  <li key={opt.key} className="w-fit">
                    <div className="inline-flex rounded-[4px] bg-white px-2.5 py-2 text-left text-[14px] font-500 leading-4 text-[#8D53F8] whitespace-nowrap">
                      {opt.label}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-1 mt-2">
            <CustomTooltip
              content={
                message.status === "read"
                  ? "Read"
                  : message.status === "delivered"
                    ? "Delivered"
                    : message.status === "sent"
                      ? "Sent"
                      : message.status === "failed"
                        ? "Message failed to send"
                        : "Not sent"
              }
              position="top"
            >
              {getStatusIcon()}
            </CustomTooltip>
            <span className="text-[12px] font-400 leading-[16px] text-[#18181E]">
              {formatTimestamp(message)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
