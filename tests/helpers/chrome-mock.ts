import { vi } from 'vitest';

/**
 * A fake of the slice of the `chrome.*` API the service worker touches.
 *
 * The worker registers its listeners at import time and has no exports, so
 * tests drive it the way Chrome does: install this on globalThis, import the
 * module, then push messages through the captured onMessage listener. That
 * keeps the tests black-box — they exercise the real message protocol rather
 * than internals the worker never exposes.
 */

/**
 * The host_permissions in public/manifest.json. Chrome populates `Tab.url` and
 * `Tab.title` only for a tab whose *current* URL matches one of these, since
 * the manifest grants no `tabs` permission.
 */
const VENDOR_HOST_RE =
  /^https:\/\/www\.(avis|budget|enterprise|hertz|hilton|hyatt|marriott|nationalcar|sixt)\.com\//;

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

export interface FakeTab {
  id: number;
  url: string;
  windowId: number;
  /** What chrome.tabs.get would report. Set by a test to stand in for a page
   *  that loaded something other than the search we asked for. */
  title: string;
}

export interface ChromeHarness {
  /** Tabs currently open, by id. */
  tabs: Map<number, FakeTab>;
  /** Windows currently open, by id. */
  windows: Set<number>;
  /** Every window id ever created, so a leak is visible after cleanup. */
  windowsCreated: number[];
  /**
   * Options every window/tab was created with, and when. CLAUDE.md's politeness
   * contract — minimised, unfocused, inactive tabs, staggered — lives entirely
   * in these arguments, so the harness has to keep them or the tests cannot
   * tell a polite run from a run that hijacks the user's browser.
   */
  windowOptions: chrome.windows.CreateData[];
  tabOptions: Array<{ options: chrome.tabs.CreateProperties; at: number }>;
  session: Map<string, unknown>;
  local: Map<string, unknown>;
  /** Messages the worker broadcast to the popup. */
  broadcasts: unknown[];
  /** Send a message as the popup (no sender tab) and await the reply. */
  fromPopup: (message: unknown) => Promise<unknown>;
  /** Send a message as a content script running in `tabId`. */
  fromTab: (tabId: number, message: unknown) => Promise<unknown>;
  /** Simulate the user closing a tab. */
  userClosesTab: (tabId: number) => void;
  /** Make the next `storage.session.set` reject, once. */
  failNextSessionWrite: () => void;
  /** Make the next `windows.create` resolve undefined, as Chrome may. */
  failNextWindowCreate: () => void;
  restore: () => void;
}

export function installChromeMock(): ChromeHarness {
  const messageListeners: MessageListener[] = [];
  const tabRemovedListeners: Array<(tabId: number) => void> = [];
  const tabs = new Map<number, FakeTab>();
  const windows = new Set<number>();
  const windowsCreated: number[] = [];
  const session = new Map<string, unknown>();
  const local = new Map<string, unknown>();
  const broadcasts: unknown[] = [];
  const windowOptions: chrome.windows.CreateData[] = [];
  const tabOptions: Array<{ options: chrome.tabs.CreateProperties; at: number }> = [];
  let nextTabId = 100;
  let nextWindowId = 1;
  let failSessionWrite = false;
  let failWindowCreate = false;

  const readArea =
    (store: Map<string, unknown>) =>
    (key?: string | string[] | null): Promise<Record<string, unknown>> => {
      const keys = key === undefined || key === null ? [...store.keys()] : [key].flat();
      const out: Record<string, unknown> = {};
      for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k));
      return Promise.resolve(out);
    };

  const fireRemoved = (tabId: number): void => {
    for (const listener of [...tabRemovedListeners]) listener(tabId);
  };

  const fakeChrome = {
    runtime: {
      onMessage: {
        addListener: (fn: MessageListener) => messageListeners.push(fn),
      },
      sendMessage: (message: unknown) => {
        broadcasts.push(structuredClone(message));
        // Real Chrome REJECTS when nothing is listening, which is the usual
        // case here because the popup is usually closed. Resolving instead
        // would make broadcast()'s .catch() look unnecessary, and dropping it
        // would then produce an unhandled rejection on every state change.
        return Promise.reject(
          new Error('Could not establish connection. Receiving end does not exist.'),
        );
      },
    },
    storage: {
      session: {
        get: readArea(session),
        set: (items: Record<string, unknown>) => {
          if (failSessionWrite) {
            failSessionWrite = false;
            return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
          }
          for (const [k, v] of Object.entries(items)) session.set(k, structuredClone(v));
          return Promise.resolve();
        },
        remove: (key: string) => {
          session.delete(key);
          return Promise.resolve();
        },
      },
      local: {
        get: readArea(local),
        set: (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
          return Promise.resolve();
        },
      },
    },
    tabs: {
      create: (options: chrome.tabs.CreateProperties) => {
        tabOptions.push({ options: { ...options }, at: Date.now() });
        const id = nextTabId++;
        tabs.set(id, { id, url: options.url ?? '', windowId: options.windowId ?? 0, title: '' });
        return Promise.resolve({ id });
      },
      // Rejects for an unknown id, like the real thing: the background reads a
      // timed-out tab just before closing it, and "the tab is already gone" is
      // a case that has to behave.
      //
      // `url` and `title` are omitted for a tab whose current URL is not one
      // this extension has a host permission for — which is what Chrome does,
      // because the manifest grants no `tabs` permission. Returning them
      // unconditionally modelled a permission the extension does not hold and
      // hid a real bug: an off-origin redirect was reported as "never
      // navigated", a confident wrong answer in the very case the feature
      // exists for.
      get: (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) return Promise.reject(new Error('No tab with id'));
        const visible = VENDOR_HOST_RE.test(tab.url);
        return Promise.resolve({
          id: tab.id,
          ...(visible ? { url: tab.url, title: tab.title } : {}),
        });
      },
      remove: (tabId: number) => {
        if (!tabs.has(tabId)) return Promise.reject(new Error('No tab with id'));
        tabs.delete(tabId);
        fireRemoved(tabId);
        return Promise.resolve();
      },
      onRemoved: {
        addListener: (fn: (tabId: number) => void) => tabRemovedListeners.push(fn),
      },
    },
    windows: {
      create: (options: chrome.windows.CreateData = {}) => {
        windowOptions.push({ ...options });
        // chrome.windows.create is typed Promise<Window | undefined> and can
        // genuinely resolve undefined.
        if (failWindowCreate) {
          failWindowCreate = false;
          return Promise.resolve(undefined);
        }
        const id = nextWindowId++;
        windows.add(id);
        windowsCreated.push(id);
        return Promise.resolve({ id });
      },
      // The background asks this after a failed close, to tell "already gone"
      // from "still there and I could not close it" — which need opposite
      // handling for the stored id.
      get: (windowId: number) => {
        if (!windows.has(windowId)) return Promise.reject(new Error('No window with id'));
        return Promise.resolve({ id: windowId });
      },
      remove: (windowId: number) => {
        if (!windows.has(windowId)) return Promise.reject(new Error('No window with id'));
        windows.delete(windowId);
        // Chrome tears down the window's tabs with it.
        for (const [id, tab] of [...tabs]) {
          if (tab.windowId === windowId) {
            tabs.delete(id);
            fireRemoved(id);
          }
        }
        return Promise.resolve();
      },
    },
  };

  const previous = (globalThis as { chrome?: unknown }).chrome;
  (globalThis as { chrome?: unknown }).chrome = fakeChrome;

  const deliver = (message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> =>
    new Promise((resolve) => {
      let settled = false;
      for (const listener of messageListeners) {
        listener(message, sender, (response?: unknown) => {
          if (settled) return;
          settled = true;
          resolve(response);
        });
      }
      // No listener answered — mirrors a message nothing handles.
      if (messageListeners.length === 0) resolve(undefined);
    });

  return {
    tabs,
    windows,
    windowsCreated,
    windowOptions,
    tabOptions,
    session,
    local,
    broadcasts,
    fromPopup: (message) => deliver(message, {}),
    fromTab: (tabId, message) =>
      deliver(message, { tab: { id: tabId } } as unknown as chrome.runtime.MessageSender),
    userClosesTab: (tabId) => {
      tabs.delete(tabId);
      fireRemoved(tabId);
    },
    failNextSessionWrite: () => {
      failSessionWrite = true;
    },
    failNextWindowCreate: () => {
      failWindowCreate = true;
    },
    restore: () => {
      (globalThis as { chrome?: unknown }).chrome = previous;
      vi.resetModules();
    },
  };
}
