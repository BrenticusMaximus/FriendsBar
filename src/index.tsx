import React, { useEffect, useState } from "react";
import {
  executeInTab,
  fetchNoCors,
  routerHook,
} from "@decky/api";
import {
  modules as webpackModuleMap,
  definePlugin,
  getReactRoot,
  Navigation,
  PanelSection,
  PanelSectionRow,
  Router,
  ModalRoot,
  SliderField,
  TextField,
  ToggleField,
  showModal,
  searchBarClasses,
  staticClasses,
} from "@decky/ui";
import { FaUserFriends } from "react-icons/fa";

const ROOT_ID = "friendsbar-root";
const STYLE_ID = "friendsbar-style";
const GLOBAL_COMPONENT_NAME = "friendsbar-global-mount";
const REFRESH_MS = 60_000;
const REMOUNT_MS = 2_000;
const STORE_PROBE_CACHE_MS = 5_000;
const MAX_VISIBLE_FRIENDS = 10;
const STEAM_ID64_BASE = BigInt("76561197960265728");
const SP_TAB_TIMEOUT_MS = 7_000;
const WEBPACK_SCAN_CACHE_MS = 5 * 60_000;
const DOM_CACHE_MS = 120_000;
const STEAM_WEB_API_KEY_STORAGE = "friendsbar-steam-web-api-key";
const X_OFFSET_STORAGE = "friendsbar-x-offset";
const Y_OFFSET_STORAGE = "friendsbar-y-offset";
const ENABLED_STORAGE = "friendsbar-enabled";
const HIDE_IN_STORE_STORAGE = "friendsbar-hide-in-store";
const HIDE_ON_GAME_PAGE_STORAGE = "friendsbar-hide-on-game-page";
const TAP_ACTION_STORAGE = "friendsbar-tap-action";
const COUNT_ONLY_MODE_STORAGE = "friendsbar-count-only-mode";
const X_OFFSET_MIN_PX = -350;
const X_OFFSET_MAX_PX = 350;
const Y_OFFSET_MIN_PX = -25;
const Y_OFFSET_MAX_PX = 500;
const SP_TAB_CANDIDATES = [
  "SP",
  "sp",
  "SharedJSContext",
  "Steam",
  "SteamUI",
  "MainMenu",
  "GamepadUI",
  "Library",
] as const;

type RuntimeState = {
  displayedCount: number;
  onlineCount: number;
  lastUpdated: string | null;
  mounted: boolean;
  mountMode: "none" | "anchored" | "fallback";
  source: string;
  steamId: string | null;
  hasOAuthToken: boolean;
  hasWebApiKey: boolean;
  documentSource: string;
  sourceDebug: string;
  spProbe: string;
  routeDebug: string;
  storeDebug: string;
  hiddenBySettings: boolean;
  error: string | null;
};

type RawFriendLink = {
  steamid?: string;
};

type RawFriendSummary = {
  steamid?: string;
  personaname?: string;
  avatar?: string;
  avatarmedium?: string;
  avatarfull?: string;
  personastate?: number;
  gameid?: string;
  gameextrainfo?: string;
};

type FriendPresence = {
  steamId: string;
  personaName: string;
  avatarUrl: string;
  inGame: boolean;
  idle: boolean;
  gameName?: string;
};

type FetchTextFn = (url: string) => Promise<string | null>;

type FriendLoadResult = {
  friends: FriendPresence[];
  source: string;
  debug: string;
};

type TapAction = "chat" | "toggle-count";

const DEFAULT_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="100%" height="100%" fill="#2f4052"/><circle cx="32" cy="24" r="11" fill="#8aa0b3"/><rect x="14" y="40" width="36" height="16" rx="8" fill="#8aa0b3"/></svg>'
)}`;

const splitClassMap = (classMap?: string): string | null => {
  if (!classMap) {
    return null;
  }
  const parts = classMap
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `.${part}`);
  return parts.length ? parts.join("") : null;
};

class FriendsBarRuntime {
  private running = false;
  private refreshing = false;
  private forceRefreshQueued = false;
  private mountTimer: number | null = null;
  private refreshTimer: number | null = null;
  private observer: MutationObserver | null = null;
  private root: HTMLDivElement | null = null;
  private targetDocument: Document | null = null;
  private preferredDocument: Document | null = null;
  private listeners = new Set<(state: RuntimeState) => void>();
  private webpackFriendContainers: any[] = [];
  private webpackContainersLastScan = 0;
  private lastSPProbe = "";
  private domCachedFriends: FriendPresence[] = [];
  private domCachedAt = 0;
  private quickAccessVisible = false;
  private storeContextActive = false;
  private storeContextCheckedAt = 0;
  private lastRouteDebug = "";
  private lastStoreDebug = "";
  private state: RuntimeState = {
    displayedCount: 0,
    onlineCount: 0,
    lastUpdated: null,
    mounted: false,
    mountMode: "none",
    source: "none",
    steamId: null,
    hasOAuthToken: false,
    hasWebApiKey: false,
    documentSource: "unknown",
    sourceDebug: "",
    spProbe: "",
    routeDebug: "",
    storeDebug: "",
    hiddenBySettings: false,
    error: null,
  };

  public start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.ensureStyle();
    this.ensureRoot();
    this.ensureMounted();
    this.startObservers();
    this.setState({ hasWebApiKey: this.hasWebApiKey() });
    void this.refresh();
    this.refreshTimer = window.setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);
    this.mountTimer = window.setInterval(() => {
      this.ensureMounted();
      void this.refreshRouteVisibility();
    }, REMOUNT_MS);
  }

  public stop() {
    this.running = false;
    if (this.mountTimer !== null) {
      window.clearInterval(this.mountTimer);
      this.mountTimer = null;
    }
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.root?.remove();
    this.root = null;
    document.getElementById(STYLE_ID)?.remove();
    this.targetDocument?.getElementById(STYLE_ID)?.remove();
    this.targetDocument = null;
    this.preferredDocument = null;
    this.webpackFriendContainers = [];
    this.webpackContainersLastScan = 0;
    this.lastSPProbe = "";
    this.domCachedFriends = [];
    this.domCachedAt = 0;
    this.storeContextActive = false;
    this.storeContextCheckedAt = 0;
    this.setState({
      mounted: false,
      mountMode: "none",
      displayedCount: 0,
      onlineCount: 0,
      source: "none",
      steamId: null,
      hasOAuthToken: false,
      hasWebApiKey: false,
      documentSource: "unknown",
      sourceDebug: "",
      spProbe: "",
      routeDebug: "",
      storeDebug: "",
      hiddenBySettings: false,
      error: null,
    });
  }

  public getState(): RuntimeState {
    return this.state;
  }

  public subscribe(listener: (state: RuntimeState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public hasWebApiKey(): boolean {
    return Boolean(this.getWebApiKey());
  }

  public getConfiguredWebApiKey(): string {
    try {
      return window.localStorage.getItem(STEAM_WEB_API_KEY_STORAGE)?.trim() || "";
    } catch {
      return "";
    }
  }

  public setWebApiKey(value: string) {
    const sanitized = value.trim();
    try {
      if (sanitized) {
        window.localStorage.setItem(STEAM_WEB_API_KEY_STORAGE, sanitized);
      } else {
        window.localStorage.removeItem(STEAM_WEB_API_KEY_STORAGE);
      }
    } catch {
      // ignore storage failures
    }
    this.setState({ hasWebApiKey: this.hasWebApiKey() });
    void this.refresh();
  }

  public getEnabled(): boolean {
    return this.readStoredBoolean(ENABLED_STORAGE, true);
  }

  public setEnabled(value: boolean) {
    this.writeStoredBoolean(ENABLED_STORAGE, value, true);
    void this.refresh();
  }

  public getHideInStore(): boolean {
    return this.readStoredBoolean(HIDE_IN_STORE_STORAGE, false);
  }

  public setHideInStore(value: boolean) {
    this.writeStoredBoolean(HIDE_IN_STORE_STORAGE, value, false);
    void this.refresh();
  }

  public getHideOnGamePage(): boolean {
    return this.readStoredBoolean(HIDE_ON_GAME_PAGE_STORAGE, false);
  }

  public setHideOnGamePage(value: boolean) {
    this.writeStoredBoolean(HIDE_ON_GAME_PAGE_STORAGE, value, false);
    void this.refresh();
  }

  public getTapAction(): TapAction {
    try {
      const value = window.localStorage.getItem(TAP_ACTION_STORAGE);
      return value === "toggle-count" ? "toggle-count" : "chat";
    } catch {
      return "chat";
    }
  }

  public setTapAction(value: TapAction) {
    try {
      if (value === "chat") {
        window.localStorage.removeItem(TAP_ACTION_STORAGE);
        this.setCountOnlyMode(false);
      } else {
        window.localStorage.setItem(TAP_ACTION_STORAGE, value);
      }
    } catch {
      // ignore storage failures
    }
    void this.refresh();
  }

  public getCountOnlyMode(): boolean {
    return this.readStoredBoolean(COUNT_ONLY_MODE_STORAGE, false);
  }

  public setCountOnlyMode(value: boolean) {
    this.writeStoredBoolean(COUNT_ONLY_MODE_STORAGE, value, false);
  }

  public getXOffset(): number {
    return this.readStoredOffset(
      X_OFFSET_STORAGE,
      X_OFFSET_MIN_PX,
      X_OFFSET_MAX_PX,
      0
    );
  }

  public getYOffset(): number {
    return this.readStoredOffset(
      Y_OFFSET_STORAGE,
      Y_OFFSET_MIN_PX,
      Y_OFFSET_MAX_PX,
      0
    );
  }

  public setXOffset(value: number) {
    this.writeStoredOffset(
      X_OFFSET_STORAGE,
      value,
      X_OFFSET_MIN_PX,
      X_OFFSET_MAX_PX,
      0
    );
    this.applyPositionOffsets();
  }

  public setYOffset(value: number) {
    this.writeStoredOffset(
      Y_OFFSET_STORAGE,
      value,
      Y_OFFSET_MIN_PX,
      Y_OFFSET_MAX_PX,
      0
    );
    this.applyPositionOffsets();
  }

  public setPreferredDocument(doc: Document | null) {
    this.preferredDocument = doc;
    if (doc) {
      this.targetDocument = doc;
      if (this.running) {
        this.ensureStyle();
        this.ensureRoot();
        this.ensureMounted();
      }
    }
  }

  public setQuickAccessVisible(visible: boolean) {
    this.quickAccessVisible = visible;
    void this.refresh();
  }

  public forceRefresh() {
    this.storeContextCheckedAt = 0;
    this.domCachedAt = 0;
    this.domCachedFriends = [];
    this.webpackContainersLastScan = 0;
    this.webpackFriendContainers = [];
    if (this.refreshing) {
      this.forceRefreshQueued = true;
      return;
    }
    void this.refresh();
  }

  private setState(patch: Partial<RuntimeState>) {
    this.state = {
      ...this.state,
      ...patch,
    };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private getWebApiKey(): string | null {
    try {
      const key = window.localStorage.getItem(STEAM_WEB_API_KEY_STORAGE)?.trim();
      if (key) {
        return key;
      }
    } catch {
      // ignore storage access failures
    }
    return null;
  }

  private clampOffset(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  private readStoredOffset(
    storageKey: string,
    min: number,
    max: number,
    defaultValue: number
  ): number {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) {
        return this.clampOffset(defaultValue, min, max);
      }
      const parsed = Number(raw);
      return this.clampOffset(parsed, min, max);
    } catch {
      return this.clampOffset(defaultValue, min, max);
    }
  }

  private writeStoredOffset(
    storageKey: string,
    value: number,
    min: number,
    max: number,
    defaultValue: number
  ) {
    const clamped = this.clampOffset(value, min, max);
    const normalizedDefault = this.clampOffset(defaultValue, min, max);
    try {
      if (clamped === normalizedDefault) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, `${clamped}`);
      }
    } catch {
      // ignore storage failures
    }
  }

  private readStoredBoolean(storageKey: string, defaultValue: boolean): boolean {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === null) {
        return defaultValue;
      }
      return raw === "1";
    } catch {
      return defaultValue;
    }
  }

  private writeStoredBoolean(
    storageKey: string,
    value: boolean,
    defaultValue: boolean
  ) {
    try {
      if (value === defaultValue) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, value ? "1" : "0");
      }
    } catch {
      // ignore storage failures
    }
  }

  private getTargetDocument(): Document {
    const mainDoc = this.getMainWindowDocument();
    if (mainDoc?.body) {
      this.targetDocument = mainDoc;
      return mainDoc;
    }

    if (this.preferredDocument?.body) {
      this.targetDocument = this.preferredDocument;
      return this.preferredDocument;
    }

    if (this.targetDocument?.body) {
      return this.targetDocument;
    }

    try {
      const topDoc = window.top?.document;
      if (topDoc?.body) {
        this.targetDocument = topDoc;
        return topDoc;
      }
    } catch {
      // Cross-origin access is not expected in Decky but keep this safe.
    }

    this.targetDocument = document;
    return document;
  }

  private getMainWindowDocument(): Document | null {
    try {
      const mainWindow =
        (Router as any)?.WindowStore?.GamepadUIMainWindowInstance
          ?.BrowserWindow ??
        (window as any).SteamUIStore?.GetFocusedWindowInstance?.()
          ?.BrowserWindow ??
        null;
      const doc = mainWindow?.document as Document | undefined;
      if (doc?.body) {
        return doc;
      }
    } catch {
      // Ignore access errors and fall back.
    }
    return null;
  }

  private getMainBrowserWindow(): Window | null {
    try {
      const mainWindow =
        (Router as any)?.WindowStore?.GamepadUIMainWindowInstance
          ?.BrowserWindow ??
        (window as any).SteamUIStore?.GetFocusedWindowInstance?.()
          ?.BrowserWindow ??
        null;
      if (mainWindow?.document?.body) {
        return mainWindow as Window;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private getCandidateWindows(): Window[] {
    const candidates = new Set<Window>();
    const addWindow = (value: Window | null | undefined) => {
      if (!value) {
        return;
      }
      candidates.add(value);
      try {
        const frameCount = Math.min(value.frames?.length ?? 0, 8);
        for (let index = 0; index < frameCount; index += 1) {
          const frameWindow = value.frames[index];
          if (frameWindow) {
            candidates.add(frameWindow);
          }
        }
      } catch {
        // ignore cross-frame access issues
      }
    };

    addWindow(this.getMainBrowserWindow());
    addWindow(this.getTargetDocument().defaultView ?? null);
    addWindow(window);
    try {
      addWindow(window.top ?? null);
    } catch {
      // ignore
    }

    return Array.from(candidates);
  }

  private resolveDocumentSource(): string {
    if (this.getMainWindowDocument()) {
      return "router-main-window";
    }
    if (this.preferredDocument?.body) {
      return "global-component";
    }
    try {
      if (window.top?.document?.body) {
        return "window-top";
      }
    } catch {
      // ignore
    }
    return "local-document";
  }

  private getViewportWidth(): number {
    const doc = this.getTargetDocument();
    return doc.defaultView?.innerWidth ?? window.innerWidth;
  }

  private ensureStyle() {
    const doc = this.getTargetDocument();
    if (doc.getElementById(STYLE_ID)) {
      return;
    }
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        --friendsbar-icon-size: 32px;
        --friendsbar-overflow-size: 30px;
        --friendsbar-activity-width: 3px;
        --friendsbar-left-nudge: 28px;
        --friendsbar-offset-x: 0px;
        --friendsbar-offset-y: 0px;
        display: none;
        align-items: center;
        gap: 6px;
        margin-right: 8px;
        z-index: 25;
        pointer-events: auto;
      }

      #${ROOT_ID}.friendsbar-anchored {
        position: relative;
        margin-right: 0;
        transform: translate(var(--friendsbar-offset-x), var(--friendsbar-offset-y));
      }

      #${ROOT_ID}.friendsbar-fallback {
        position: fixed;
        top: calc(env(safe-area-inset-top, 0px) + 6px);
        right: clamp(320px, 24vw, 560px);
        margin-right: 0;
        transform: translate(
          calc((-1 * var(--friendsbar-left-nudge)) + var(--friendsbar-offset-x)),
          var(--friendsbar-offset-y)
        );
        background: transparent;
        border: 0;
        border-radius: 0;
        padding: 0;
        box-shadow: none;
        backdrop-filter: none;
      }

      #${ROOT_ID} .friendsbar-friend {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--friendsbar-icon-size);
        height: var(--friendsbar-icon-size);
        border: 0;
        border-radius: 0;
        padding: 0;
        background: transparent;
        overflow: hidden;
        opacity: 1;
        transform: translate(0, 0);
        transition: opacity 220ms ease, transform 220ms ease;
      }

      #${ROOT_ID} .friendsbar-friend img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 0;
        border: 0;
      }

      #${ROOT_ID} .friendsbar-activity {
        position: absolute;
        right: 0;
        left: auto;
        top: 0;
        bottom: 0;
        width: var(--friendsbar-activity-width);
        border-radius: 1px;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.38);
        z-index: 2;
      }

      #${ROOT_ID} .friendsbar-activity.green-solid {
        background: #4bc95f;
      }

      #${ROOT_ID} .friendsbar-activity.blue-solid {
        background: #49a2ff;
      }

      #${ROOT_ID} .friendsbar-activity.green-dotted {
        background-image: repeating-linear-gradient(
          to bottom,
          #4bc95f 0 4px,
          transparent 4px 8px
        );
      }

      #${ROOT_ID} .friendsbar-activity.blue-dotted {
        background-image: repeating-linear-gradient(
          to bottom,
          #49a2ff 0 4px,
          transparent 4px 8px
        );
      }

      #${ROOT_ID} .friendsbar-overflow {
        width: var(--friendsbar-overflow-size);
        height: var(--friendsbar-overflow-size);
        border-radius: 0;
        border: 1px solid rgba(255, 255, 255, 0.25);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: rgba(255, 255, 255, 0.95);
        background: rgba(24, 30, 36, 0.9);
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        opacity: 1;
        transform: translate(0, 0);
        transition: opacity 220ms ease, transform 220ms ease;
      }

      #${ROOT_ID} .friendsbar-enter-start {
        opacity: 0;
        transform: translateX(8px);
      }

      #${ROOT_ID} .friendsbar-leave-ghost {
        position: absolute !important;
        margin: 0 !important;
        pointer-events: none !important;
        opacity: 0;
        transform: translateX(-8px);
      }
    `;
    doc.head.appendChild(style);
  }

  private ensureRoot() {
    if (this.root?.isConnected) {
      return;
    }
    const doc = this.getTargetDocument();
    this.root = doc.createElement("div");
    this.root.id = ROOT_ID;
    this.applyPositionOffsets();
  }

  private startObservers() {
    const doc = this.getTargetDocument();
    if (!doc.body) {
      return;
    }
    this.observer = new MutationObserver(() => {
      this.ensureMounted();
    });
    this.observer.observe(doc.body, {
      childList: true,
      subtree: true,
    });
  }

  private ensureMounted() {
    if (!this.root) {
      return;
    }

    const topBarRow = this.findTopBarIconRow();
    if (topBarRow) {
      const rowButtons = this.collectTopRightIconButtons(topBarRow);
      const searchAnchor = this.findSearchAnchorInRow(topBarRow);
      const firstIcon =
        searchAnchor ?? rowButtons[0] ?? (topBarRow.firstElementChild as HTMLElement | null);
      if (this.root.parentElement !== topBarRow) {
        topBarRow.insertBefore(this.root, firstIcon);
      } else if (this.root !== firstIcon) {
        topBarRow.insertBefore(this.root, firstIcon);
      }
      this.root.classList.add("friendsbar-anchored");
      this.root.classList.remove("friendsbar-fallback");
      this.syncIconSizeToTopBar();
      this.applyPositionOffsets();
      this.applyVisibilityForCurrentContext();
      this.setState({ mounted: true, mountMode: "anchored" });
      return;
    }

    const anchor = this.findSearchAnchor() ?? this.collectTopRightIconButtons()[0];
    if (anchor && anchor.parentElement) {
      if (this.root.parentElement !== anchor.parentElement) {
        anchor.parentElement.insertBefore(this.root, anchor);
      } else if (this.root.nextElementSibling !== anchor) {
        anchor.parentElement.insertBefore(this.root, anchor);
      }
      this.root.classList.add("friendsbar-anchored");
      this.root.classList.remove("friendsbar-fallback");
      this.syncIconSizeToTopBar();
      this.applyPositionOffsets();
      this.applyVisibilityForCurrentContext();
      this.setState({ mounted: true, mountMode: "anchored" });
      return;
    }

    const doc = this.getTargetDocument();
    if (!doc.body) {
      this.setState({ mounted: false, mountMode: "none" });
      return;
    }

    if (this.root.parentElement !== doc.body) {
      doc.body.appendChild(this.root);
    }
    this.root.classList.add("friendsbar-fallback");
    this.root.classList.remove("friendsbar-anchored");
    this.syncIconSizeToTopBar();
    this.applyPositionOffsets();
    this.applyVisibilityForCurrentContext();
    this.setState({ mounted: true, mountMode: "fallback" });
  }

  private findSearchAnchorInRow(row: HTMLElement): HTMLElement | null {
    const selectors: string[] = [];
    const pushMappedSelector = (mapped?: string) => {
      const selector = splitClassMap(mapped);
      if (selector) {
        selectors.push(selector);
      }
    };
    pushMappedSelector(searchBarClasses.SearchIconRight);
    pushMappedSelector(searchBarClasses.SearchIconLeft);
    pushMappedSelector(searchBarClasses.SearchBox);
    selectors.push(
      "[aria-label*='search' i]",
      "[title*='search' i]",
      "[class*='search']",
      "[class*='Search']"
    );

    const candidates: HTMLElement[] = [];
    for (const selector of selectors) {
      const nodes = Array.from(row.querySelectorAll(selector));
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        const clickable = node.closest(
          "button,[role='button'],div[role='button'],a"
        );
        const candidate =
          clickable instanceof HTMLElement && row.contains(clickable)
            ? clickable
            : node;
        if (!candidates.includes(candidate)) {
          candidates.push(candidate);
        }
      }
    }

    if (!candidates.length) {
      return null;
    }
    candidates.sort(
      (left, right) =>
        left.getBoundingClientRect().left - right.getBoundingClientRect().left
    );
    return candidates[0] ?? null;
  }


  private syncIconSizeToTopBar() {
    if (!this.root) {
      return;
    }
    const viewportWidth = this.getViewportWidth();
    const doc = this.getTargetDocument();
    const avatarCandidates = Array.from(doc.querySelectorAll("img"))
      .filter((img): img is HTMLImageElement => img instanceof HTMLImageElement)
      .filter((img) => !this.root?.contains(img))
      .filter((img) => {
        const rect = img.getBoundingClientRect();
        if (rect.right < viewportWidth * 0.45) {
          return false;
        }
        if (rect.top < -8 || rect.top > 150) {
          return false;
        }
        if (rect.width < 20 || rect.width > 64 || rect.height < 20 || rect.height > 64) {
          return false;
        }
        return Math.abs(rect.width - rect.height) <= 6;
      })
      .sort((left, right) => left.getBoundingClientRect().right - right.getBoundingClientRect().right);

    let measured = 0;
    if (avatarCandidates.length) {
      const referenceAvatar = avatarCandidates[avatarCandidates.length - 1];
      const rect = referenceAvatar.getBoundingClientRect();
      measured = Math.round(Math.min(rect.width, rect.height));
    } else {
      const buttonCandidates = this.collectTopRightIconButtons().filter(
        (button) => !this.root?.contains(button)
      );
      if (!buttonCandidates.length) {
        return;
      }
      const referenceButton = buttonCandidates[buttonCandidates.length - 1];
      const rect = referenceButton.getBoundingClientRect();
      measured = Math.round(Math.min(rect.width, rect.height));
    }

    const iconSize = Math.max(28, Math.min(48, measured || 32));
    const overflowSize = Math.max(24, iconSize - 2);
    const activityWidth = Math.max(5, Math.min(10, Math.round(iconSize * 0.2)));

    this.root.style.setProperty("--friendsbar-icon-size", `${iconSize}px`);
    this.root.style.setProperty("--friendsbar-overflow-size", `${overflowSize}px`);
    this.root.style.setProperty("--friendsbar-activity-width", `${activityWidth}px`);
  }

  private applyPositionOffsets() {
    if (!this.root) {
      return;
    }
    const requestedX = this.getXOffset();
    const requestedY = this.getYOffset();

    // When anchored in the top bar, use configured offsets directly.
    // In fallback mode, additionally clamp to viewport bounds.
    if (this.root.classList.contains("friendsbar-anchored")) {
      this.root.style.setProperty("--friendsbar-offset-x", `${requestedX}px`);
      this.root.style.setProperty("--friendsbar-offset-y", `${requestedY}px`);
      return;
    }

    // Measure a baseline rect with neutral offsets, then clamp so the final position
    // remains in-bounds for the current viewport.
    this.root.style.setProperty("--friendsbar-offset-x", "0px");
    this.root.style.setProperty("--friendsbar-offset-y", "0px");

    const rect = this.root.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      this.root.style.setProperty("--friendsbar-offset-x", `${requestedX}px`);
      this.root.style.setProperty("--friendsbar-offset-y", `${requestedY}px`);
      return;
    }

    const doc = this.getTargetDocument();
    const viewportWidth = doc.defaultView?.innerWidth ?? window.innerWidth;
    const viewportHeight = doc.defaultView?.innerHeight ?? window.innerHeight;
    const edgePadding = 2;

    const minX = edgePadding - rect.left;
    const maxX = viewportWidth - edgePadding - rect.right;
    const minY = edgePadding - rect.top;
    const maxY = viewportHeight - edgePadding - rect.bottom;

    const clampedX = Math.max(minX, Math.min(maxX, requestedX));
    const clampedY = Math.max(minY, Math.min(maxY, requestedY));

    this.root.style.setProperty("--friendsbar-offset-x", `${Math.round(clampedX)}px`);
    this.root.style.setProperty("--friendsbar-offset-y", `${Math.round(clampedY)}px`);
  }

  private findSearchAnchor(): HTMLElement | null {
    const mappedSearchIcon =
      this.findByMappedClass(searchBarClasses.SearchIconRight) ??
      this.findByMappedClass(searchBarClasses.SearchIconLeft);
    if (mappedSearchIcon) {
      const clickable = mappedSearchIcon.closest(
        "button,[role='button'],div[role='button']"
      );
      if (clickable instanceof HTMLElement) {
        return clickable;
      }
    }

    const mappedSearchBox = this.findByMappedClass(searchBarClasses.SearchBox);
    if (mappedSearchBox) {
      const clickable = mappedSearchBox.closest(
        "button,[role='button'],div[role='button']"
      );
      if (clickable instanceof HTMLElement) {
        return clickable;
      }
    }

    const topRightButtons = this.collectTopRightIconButtons();
    const explicitSearch = topRightButtons.find((button) =>
      this.looksLikeSearchButton(button)
    );
    if (explicitSearch) {
      return explicitSearch;
    }

    // In Steam's top-right strip, the magnifier is typically the left-most icon.
    if (topRightButtons.length >= 4) {
      return topRightButtons[0];
    }

    return null;
  }

  private findByMappedClass(classMap?: string): HTMLElement | null {
    const doc = this.getTargetDocument();
    const selector = splitClassMap(classMap);
    if (!selector) {
      return null;
    }
    return doc.querySelector(selector) as HTMLElement | null;
  }

  private findTopBarIconRow(): HTMLElement | null {
    const buttons = this.collectTopRightIconButtons();
    if (buttons.length < 3) {
      return null;
    }

    const viewportWidth = this.getViewportWidth();
    const scored = new Map<HTMLElement, number>();

    for (const button of buttons) {
      let node: HTMLElement | null = button.parentElement;
      let depth = 0;
      while (node && depth < 5) {
        const rect = node.getBoundingClientRect();
        const validGeometry =
          rect.top > -8 &&
          rect.top < 160 &&
          rect.height >= 24 &&
          rect.height <= 120 &&
          rect.width >= 120 &&
          rect.right > viewportWidth * 0.5;
        if (validGeometry) {
          const current = scored.get(node) ?? 0;
          // Favor containers higher in the chain but still near buttons.
          scored.set(node, current + (6 - depth));
        }
        node = node.parentElement;
        depth += 1;
      }
    }

    let best: HTMLElement | null = null;
    let bestScore = -Infinity;
    for (const [candidate, baseScore] of scored) {
      const rowButtons = this.collectTopRightIconButtons(candidate);
      if (rowButtons.length < 3) {
        continue;
      }
      const rect = candidate.getBoundingClientRect();
      const compactness = Math.max(0, 180 - rect.height);
      const rightAffinityPenalty = Math.max(0, viewportWidth - rect.right);
      const score =
        baseScore * 10 +
        rowButtons.length * 8 +
        compactness -
        rightAffinityPenalty;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  private collectTopRightIconButtons(scope?: ParentNode): HTMLElement[] {
    const doc = this.getTargetDocument();
    const root = scope ?? doc;
    const viewportWidth = this.getViewportWidth();
    const buttons = Array.from(
      root.querySelectorAll("button,[role='button'],div[role='button']")
    ).filter((node): node is HTMLElement => node instanceof HTMLElement);

    return buttons
      .filter((button) => !this.root?.contains(button))
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        if (rect.width < 14 || rect.width > 120 || rect.height < 14 || rect.height > 120) {
          return false;
        }
        if (rect.top < -8 || rect.top > 150) {
          return false;
        }
        if (rect.right < viewportWidth * 0.45) {
          return false;
        }
        const computed = doc.defaultView?.getComputedStyle(button);
        if (!computed) {
          return true;
        }
        if (computed.display === "none" || computed.visibility === "hidden") {
          return false;
        }
        return parseFloat(computed.opacity || "1") > 0.05;
      })
      .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
  }

  private looksLikeSearchButton(element: HTMLElement): boolean {
    const textFingerprint = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("aria-description"),
      element.className,
      element.innerHTML.slice(0, 280),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (!textFingerprint) {
      return false;
    }

    return (
      textFingerprint.includes("search") ||
      textFingerprint.includes("magnify") ||
      textFingerprint.includes("find")
    );
  }

  private async refresh() {
    if (!this.running || this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      await this.refreshRouteVisibility();
      this.ensureMounted();
      const { friends, source, debug } = await this.loadOnlineFriends();
      this.renderFriends(friends);
      this.setState({
        displayedCount: Math.min(friends.length, MAX_VISIBLE_FRIENDS),
        onlineCount: friends.length,
        lastUpdated: new Date().toISOString(),
        source,
        steamId: this.resolveCurrentSteamId(),
        hasOAuthToken: Boolean(this.resolveOAuthToken()),
        hasWebApiKey: this.hasWebApiKey(),
        documentSource: this.resolveDocumentSource(),
        sourceDebug: debug,
        spProbe: this.lastSPProbe,
        error: null,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to refresh";
      this.setState({
        displayedCount: 0,
        onlineCount: 0,
        source: "error",
        steamId: this.resolveCurrentSteamId(),
        hasOAuthToken: Boolean(this.resolveOAuthToken()),
        hasWebApiKey: this.hasWebApiKey(),
        documentSource: this.resolveDocumentSource(),
        sourceDebug: "",
        spProbe: this.lastSPProbe,
        error: message,
      });
      if (this.root) {
        this.root.style.display = "none";
      }
    } finally {
      this.refreshing = false;
      if (this.forceRefreshQueued && this.running) {
        this.forceRefreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async refreshRouteVisibility() {
    const routes = this.getRouteCandidates();
    const storeFromRoutes = routes.some((route) => this.isStoreRoute(route));
    const storeFromWindowState = this.detectStoreFromWindowState();
    const storeFromTabProbe = await this.detectStoreFromTabs();
    this.storeContextActive =
      storeFromRoutes || storeFromWindowState || storeFromTabProbe;
    this.storeContextCheckedAt = Date.now();
    this.lastRouteDebug = routes.slice(0, 6).join(" || ").slice(0, 400);
    this.lastStoreDebug = `route:${storeFromRoutes} window:${storeFromWindowState} tab:${storeFromTabProbe}`;
    this.setState({
      routeDebug: this.lastRouteDebug || "(none)",
      storeDebug: this.lastStoreDebug,
      hiddenBySettings: this.shouldHideBySettings(),
    });
    this.applyVisibilityForCurrentContext();
  }

  private getRouteCandidates(): string[] {
    const candidates = new Set<string>();
    const pushLocation = (loc?: Location | null) => {
      if (!loc) {
        return;
      }
      const composed = `${loc.pathname || ""}${loc.hash || ""}${loc.search || ""}`
        .trim()
        .toLowerCase();
      if (composed) {
        candidates.add(composed);
      }
      const href = String(loc.href || "").trim().toLowerCase();
      if (href) {
        candidates.add(href);
      }
    };

    pushLocation(this.getTargetDocument().defaultView?.location ?? null);
    pushLocation(window.location);
    try {
      pushLocation(window.top?.location ?? null);
    } catch {
      // ignore cross-origin access
    }
    for (const candidateWindow of this.getCandidateWindows()) {
      try {
        pushLocation((candidateWindow as any)?.location ?? null);
      } catch {
        // ignore cross-origin access
      }
    }

    return Array.from(candidates);
  }

  private isStoreRoute(route: string): boolean {
    const variants = new Set<string>([route]);
    const tryDecode = (value: string) => {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded && decoded !== value) {
          variants.add(decoded);
        }
      } catch {
        // ignore decode issues
      }
    };
    tryDecode(route);
    for (const value of Array.from(variants)) {
      tryDecode(value);
    }

    const hasStoreSignal = (value: string): boolean =>
      value.includes("/store") ||
      value.includes("#/store") ||
      value.includes("tab=store") ||
      value.includes("storehome") ||
      value.includes("store.steampowered.com") ||
      value.includes("store%2esteampowered%2ecom") ||
      (value.includes("openurl") && value.includes("store"));

    for (const value of variants) {
      if (hasStoreSignal(value)) {
        return true;
      }
    }

    return (
      Array.from(
        this.getTargetDocument().querySelectorAll(
          "a[href*='store.steampowered.com'], iframe[src*='store.steampowered.com']"
        )
      ).length > 0
    );
  }

  private isGamePageRoute(route: string): boolean {
    return (
      route.includes("/library/app/") ||
      route.includes("/library/details/") ||
      route.includes("#/library/app/") ||
      route.includes("#/library/details/") ||
      route.includes("/app/") ||
      route.includes("appid=") ||
      route.includes("gamedetails") ||
      route.includes("appdetails")
    );
  }

  private shouldHideBySettings(): boolean {
    if (!this.getEnabled()) {
      return true;
    }
    const routes = this.getRouteCandidates();
    if (!routes.length) {
      return false;
    }
    if (
      this.getHideInStore() &&
      (this.storeContextActive || routes.some((route) => this.isStoreRoute(route)))
    ) {
      return true;
    }
    if (this.getHideOnGamePage() && routes.some((route) => this.isGamePageRoute(route))) {
      return true;
    }
    return false;
  }

  private async isStoreContextActive(): Promise<boolean> {
    const now = Date.now();
    if (now - this.storeContextCheckedAt < STORE_PROBE_CACHE_MS) {
      return this.storeContextActive;
    }

    const routes = this.getRouteCandidates();
    if (routes.some((route) => this.isStoreRoute(route))) {
      return true;
    }
    if (this.detectStoreFromWindowState()) {
      return true;
    }

    const probeCode = `
      (() => {
        try {
          const href = String(window.location?.href || "").toLowerCase();
          const path = String(window.location?.pathname || "").toLowerCase();
          const hash = String(window.location?.hash || "").toLowerCase();
          const search = String(window.location?.search || "").toLowerCase();
          const full = href + " " + path + " " + hash + " " + search;
          if (full.includes("store.steampowered.com") || full.includes("/store") || full.includes("#/store")) {
            return true;
          }
          const hasStoreFrame = !!document.querySelector("iframe[src*='store.steampowered.com'], webview[src*='store.steampowered.com']");
          if (hasStoreFrame) {
            return true;
          }
          const bodyText = String(document.body?.textContent || "").toLowerCase();
          if (bodyText.includes("store.steampowered.com")) {
            return true;
          }
          return false;
        } catch {
          return false;
        }
      })();
    `;

    const probes = await this.runStoreTabProbe(probeCode);
    return probes.some(Boolean);
  }

  private async detectStoreFromTabs(): Promise<boolean> {
    const probeCode = `
      (() => {
        try {
          const href = String(window.location?.href || "").toLowerCase();
          const path = String(window.location?.pathname || "").toLowerCase();
          const hash = String(window.location?.hash || "").toLowerCase();
          const search = String(window.location?.search || "").toLowerCase();
          const full = href + " " + path + " " + hash + " " + search;
          if (full.includes("store.steampowered.com") || full.includes("/store") || full.includes("#/store")) {
            return true;
          }
          const hasStoreFrame = !!document.querySelector("iframe[src*='store.steampowered.com'], webview[src*='store.steampowered.com']");
          if (hasStoreFrame) {
            return true;
          }
          return false;
        } catch {
          return false;
        }
      })();
    `;
    const probes = await this.runStoreTabProbe(probeCode);
    return probes.some(Boolean);
  }

  private async runStoreTabProbe(code: string): Promise<boolean[]> {
    return Promise.all(
      SP_TAB_CANDIDATES.map(async (tab) => {
        try {
          const result = await Promise.race([
            executeInTab(tab, true, code),
            new Promise<null>((resolve) => {
              window.setTimeout(() => resolve(null), 1_000);
            }),
          ]);
          const value =
            result && typeof result === "object" && "result" in result
              ? (result as any).result
              : result;
          return value === true || value === "true";
        } catch {
          return false;
        }
      })
    );
  }

  private detectStoreFromWindowState(): boolean {
    const looksLikeStore = (value: unknown): boolean => {
      if (typeof value !== "string") {
        return false;
      }
      const text = value.toLowerCase();
      return (
        text.includes("store.steampowered.com") ||
        text.includes("#/store") ||
        text.includes("/store") ||
        text.includes("tab=store") ||
        text.includes("storehome") ||
        (text.includes("openurl") && text.includes("store"))
      );
    };

    const focusedCandidates = [
      (window as any).SteamUIStore?.GetFocusedWindowInstance?.(),
      (Router as any)?.WindowStore?.GetFocusedWindowInstance?.(),
      (Router as any)?.WindowStore?.m_FocusedWindowInstance,
      (Router as any)?.WindowStore?.m_FocusedWindow,
      (Router as any)?.WindowStore,
      (window as any).SteamUIStore,
    ];

    for (const candidate of focusedCandidates) {
      if (!candidate) {
        continue;
      }

      const directValues = [
        candidate?.strTitle,
        candidate?.m_strTitle,
        candidate?.title,
        candidate?.name,
        candidate?.WindowType,
        candidate?.m_eWindowType,
        candidate?.route,
        candidate?.path,
        candidate?.url,
        candidate?.href,
        candidate?.location?.href,
        candidate?.BrowserWindow?.location?.href,
        candidate?.BrowserWindow?.document?.URL,
        candidate?.BrowserWindow?.document?.location?.href,
      ];
      if (directValues.some(looksLikeStore)) {
        return true;
      }

      const queue: unknown[] = [candidate];
      const seen = new WeakSet<object>();
      let scanned = 0;
      while (queue.length && scanned < 250) {
        const next = queue.shift();
        scanned += 1;
        if (!next || typeof next !== "object") {
          continue;
        }
        const objectValue = next as Record<string, unknown>;
        if (seen.has(objectValue)) {
          continue;
        }
        seen.add(objectValue);
        const keys = Object.keys(objectValue).slice(0, 80);
        for (const key of keys) {
          const value = objectValue[key];
          if (
            typeof value === "string" &&
            /url|href|path|route|uri|src|title|name|location/i.test(key) &&
            looksLikeStore(value)
          ) {
            return true;
          }
          if (value && typeof value === "object") {
            queue.push(value);
          }
        }
      }
    }

    return false;
  }

  private applyVisibilityForCurrentContext() {
    if (!this.root) {
      return;
    }
    if (!this.root.childElementCount) {
      this.root.style.display = "none";
      return;
    }
    this.root.style.display = this.shouldHideBySettings() ? "none" : "inline-flex";
  }

  private handleFriendTap(steamId: string) {
    if (this.getTapAction() === "toggle-count") {
      this.setCountOnlyMode(!this.getCountOnlyMode());
      void this.refresh();
      return;
    }
    this.openFriendChat(steamId);
  }

  private renderFriends(friends: FriendPresence[]) {
    if (!this.root) {
      return;
    }

    if (this.shouldHideBySettings()) {
      this.root.style.display = "none";
      return;
    }

    if (!friends.length) {
      this.root.replaceChildren();
      this.root.style.display = "none";
      return;
    }

    if (this.getCountOnlyMode()) {
      const existing = this.collectRenderableChildrenByKey();
      const countKey = "count-toggle";
      const countNode =
        (existing.get(countKey) as HTMLButtonElement | undefined) ??
        this.createCountToggle(friends.length);
      countNode.textContent = `${friends.length}`;
      countNode.title = `${friends.length} online friends (tap to toggle icon/count view)`;
      this.renderWithAnimation([countNode]);
      this.root.style.display = "inline-flex";
      return;
    }

    const visible = friends.slice(0, MAX_VISIBLE_FRIENDS);
    const existing = this.collectRenderableChildrenByKey();
    const nodes: HTMLElement[] = visible.map((friend) => {
      const key = `friend:${friend.steamId}`;
      const current = existing.get(key);
      if (current instanceof HTMLButtonElement) {
        this.updateFriendButton(current, friend);
        return current;
      }
      return this.createFriendButton(friend);
    });

    if (friends.length > MAX_VISIBLE_FRIENDS) {
      const overflowKey = "overflow";
      const overflowText = `+${friends.length - MAX_VISIBLE_FRIENDS}`;
      const overflowTitle = `${friends.length - MAX_VISIBLE_FRIENDS} more online`;
      const current = existing.get(overflowKey);
      if (current instanceof HTMLDivElement) {
        current.textContent = overflowText;
        current.title = overflowTitle;
        nodes.push(current);
      } else {
        const doc = this.root.ownerDocument ?? this.getTargetDocument();
        const extra = doc.createElement("div");
        extra.className = "friendsbar-overflow";
        extra.dataset.fbKey = overflowKey;
        extra.textContent = overflowText;
        extra.title = overflowTitle;
        nodes.push(extra);
      }
    }

    this.renderWithAnimation(nodes);
    this.applyPositionOffsets();
    this.applyVisibilityForCurrentContext();
  }

  private createFriendButton(friend: FriendPresence): HTMLButtonElement {
    const doc = this.root?.ownerDocument ?? this.getTargetDocument();
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "friendsbar-friend";
    button.dataset.fbKey = `friend:${friend.steamId}`;
    button.title = this.buildTitle(friend);
    button.onclick = () => {
      this.handleFriendTap(friend.steamId);
    };

    const bar = doc.createElement("span");
    bar.className = `friendsbar-activity ${this.activityClass(friend)}`;

    const avatar = doc.createElement("img");
    avatar.src = friend.avatarUrl;
    avatar.alt = friend.personaName;
    avatar.loading = "lazy";
    avatar.onerror = () => {
      if (avatar.src !== DEFAULT_AVATAR) {
        avatar.src = DEFAULT_AVATAR;
      }
    };

    button.appendChild(bar);
    button.appendChild(avatar);
    return button;
  }

  private updateFriendButton(button: HTMLButtonElement, friend: FriendPresence) {
    button.title = this.buildTitle(friend);
    button.onclick = () => {
      this.handleFriendTap(friend.steamId);
    };
    button.dataset.fbKey = `friend:${friend.steamId}`;

    const bar = button.querySelector(".friendsbar-activity") as HTMLSpanElement | null;
    if (bar) {
      bar.className = `friendsbar-activity ${this.activityClass(friend)}`;
    }

    const avatar = button.querySelector("img") as HTMLImageElement | null;
    if (avatar) {
      avatar.src = friend.avatarUrl;
      avatar.alt = friend.personaName;
    }
  }

  private createCountToggle(totalOnline: number): HTMLButtonElement {
    const doc = this.root?.ownerDocument ?? this.getTargetDocument();
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "friendsbar-overflow";
    button.dataset.fbKey = "count-toggle";
    button.title = `${totalOnline} online friends (tap to toggle icon/count view)`;
    button.textContent = `${totalOnline}`;
    button.onclick = () => {
      this.setCountOnlyMode(!this.getCountOnlyMode());
      void this.refresh();
    };
    return button;
  }

  private collectRenderableChildrenByKey(): Map<string, HTMLElement> {
    const out = new Map<string, HTMLElement>();
    if (!this.root) {
      return out;
    }
    const children = Array.from(this.root.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement
    );
    for (const child of children) {
      if (child.classList.contains("friendsbar-leave-ghost")) {
        continue;
      }
      const key = child.dataset.fbKey;
      if (key) {
        out.set(key, child);
      }
    }
    return out;
  }

  private renderWithAnimation(nextNodes: HTMLElement[]) {
    if (!this.root) {
      return;
    }

    const currentNodes = Array.from(this.root.children).filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && !node.classList.contains("friendsbar-leave-ghost")
    );
    const currentByKey = new Map<string, HTMLElement>();
    const oldRects = new Map<string, DOMRect>();
    for (const node of currentNodes) {
      const key = node.dataset.fbKey;
      if (!key) {
        continue;
      }
      currentByKey.set(key, node);
      oldRects.set(key, node.getBoundingClientRect());
    }

    const nextKeys = new Set<string>();
    for (const node of nextNodes) {
      const key = node.dataset.fbKey;
      if (key) {
        nextKeys.add(key);
      }
    }

    const leavingNodes = currentNodes.filter((node) => {
      const key = node.dataset.fbKey;
      return key && !nextKeys.has(key);
    });

    this.root.replaceChildren(...nextNodes);

    for (const leaving of leavingNodes) {
      this.spawnLeavingGhost(leaving);
    }

    const newRects = new Map<string, DOMRect>();
    for (const node of nextNodes) {
      const key = node.dataset.fbKey;
      if (!key) {
        continue;
      }
      newRects.set(key, node.getBoundingClientRect());
    }

    for (const node of nextNodes) {
      const key = node.dataset.fbKey;
      if (!key) {
        continue;
      }
      const oldRect = oldRects.get(key);
      const newRect = newRects.get(key);
      if (!newRect) {
        continue;
      }
      if (!oldRect) {
        node.classList.add("friendsbar-enter-start");
        void node.getBoundingClientRect();
        node.classList.remove("friendsbar-enter-start");
        continue;
      }
      const dx = oldRect.left - newRect.left;
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        continue;
      }
      const previousTransition = node.style.transition;
      node.style.transition = "none";
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      void node.getBoundingClientRect();
      node.style.transition = previousTransition;
      node.style.transform = "";
    }
  }

  private spawnLeavingGhost(node: HTMLElement) {
    if (!this.root) {
      return;
    }
    const rootRect = this.root.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const ghost = node.cloneNode(true) as HTMLElement;
    ghost.classList.add("friendsbar-leave-ghost");
    ghost.style.left = `${rect.left - rootRect.left}px`;
    ghost.style.top = `${rect.top - rootRect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.opacity = "1";
    ghost.style.transform = "translateX(0)";
    this.root.appendChild(ghost);
    requestAnimationFrame(() => {
      ghost.style.opacity = "0";
      ghost.style.transform = "translateX(-8px)";
    });
    window.setTimeout(() => {
      ghost.remove();
    }, 240);
  }

  private buildTitle(friend: FriendPresence): string {
    const status = friend.inGame
      ? friend.idle
        ? "in game (idle)"
        : "in game"
      : friend.idle
        ? "online (idle)"
        : "online";
    if (friend.gameName) {
      return `${friend.personaName} - ${status} - ${friend.gameName}`;
    }
    return `${friend.personaName} - ${status}`;
  }

  private activityClass(friend: FriendPresence): string {
    if (friend.inGame) {
      return friend.idle ? "green-dotted" : "green-solid";
    }
    return friend.idle ? "blue-dotted" : "blue-solid";
  }

  private openFriendChat(steamId: string) {
    const steamClient = (window as any).SteamClient;
    if (steamClient?.WebChat?.ShowFriendChatDialog) {
      steamClient.WebChat.ShowFriendChatDialog(steamId);
      return;
    }
    if (steamClient?.Overlay?.OpenChatDialog) {
      steamClient.Overlay.OpenChatDialog(steamId);
      return;
    }
    Navigation.NavigateToChat();
  }

  private async loadOnlineFriends(): Promise<FriendLoadResult> {
    const steamId = this.resolveCurrentSteamId();
    const attempts: Array<{ source: string; count: number }> = [];

    if (steamId) {
      const webApiFriends = await this.fetchWebApiKeyOnlineFriends(steamId);
      attempts.push({ source: "steam-web-api-key", count: webApiFriends.length });
      if (webApiFriends.length) {
        return {
          friends: this.sortFriends(webApiFriends),
          source: `steam-web-api-key(${webApiFriends.length})`,
          debug: attempts.map((item) => `${item.source}:${item.count}`).join(" | "),
        };
      }
    }

    if (steamId) {
      const oauthFriends = await this.fetchOAuthOnlineFriends(steamId);
      attempts.push({ source: "oauth-api", count: oauthFriends.length });
      if (oauthFriends.length) {
        return {
          friends: this.sortFriends(oauthFriends),
          source: `oauth-api(${oauthFriends.length})`,
          debug: attempts.map((item) => `${item.source}:${item.count}`).join(" | "),
        };
      }
    }

    const communityFriends = await this.fetchPlayerListOnlineFriends();
    attempts.push({ source: "community-html", count: communityFriends.length });
    if (communityFriends.length) {
      return {
        friends: this.sortFriends(communityFriends),
        source: `community-html(${communityFriends.length})`,
        debug: attempts.map((item) => `${item.source}:${item.count}`).join(" | "),
      };
    }

    return {
      friends: [],
      source: "none",
      debug: attempts.map((item) => `${item.source}:${item.count}`).join(" | "),
    };
  }

  private fetchWebpackStoreOnlineFriends(): FriendPresence[] {
    const containers = this.getWebpackFriendContainers();
    if (!containers.length) {
      return [];
    }

    const bySteamId = new Map<string, FriendPresence>();
    for (const container of containers) {
      const records = this.collectRawFriendRecords(container);
      for (const raw of records) {
        const parsed = this.parsePresenceFromRaw(raw);
        if (!parsed) {
          continue;
        }
        const existing = bySteamId.get(parsed.steamId);
        if (!existing) {
          bySteamId.set(parsed.steamId, parsed);
        } else {
          bySteamId.set(parsed.steamId, this.preferPresence(existing, parsed));
        }
      }
    }

    return this.sortFriends(Array.from(bySteamId.values()));
  }

  private fetchDeckUIDomOnlineFriends(): FriendPresence[] {
    const now = Date.now();
    const bySteamId = new Map<string, FriendPresence>();

    const parseNode = (node: Element, doc: Document) => {
      const element = node as HTMLElement;
      const steamId = this.readSteamIdFromNode(element);
      if (!steamId) {
        return;
      }

      const container =
        (element.closest(
          "[class*='friend'],[class*='Friend'],[class*='persona'],[class*='chat'],li,div,a"
        ) as HTMLElement | null) ?? element;

      const classTokens = new Set<string>();
      const addClassTokens = (value: string | null | undefined) => {
        if (!value) {
          return;
        }
        for (const token of value.toLowerCase().split(/\s+/g)) {
          const normalized = token.trim();
          if (normalized) {
            classTokens.add(normalized);
          }
        }
      };
      addClassTokens(element.className);
      addClassTokens(container.className);
      let parent: HTMLElement | null = container.parentElement;
      let depth = 0;
      while (parent && depth < 4) {
        addClassTokens(parent.className);
        parent = parent.parentElement;
        depth += 1;
      }
      for (const item of Array.from(container.querySelectorAll("[class]")).slice(0, 50)) {
        if (item instanceof HTMLElement) {
          addClassTokens(item.className);
        }
      }

      const stateNode = container.querySelector(
        "[data-personastate], [data-persona-state]"
      ) as HTMLElement | null;
      const personaStateRaw =
        container.getAttribute("data-personastate") ??
        container.getAttribute("data-persona-state") ??
        element.getAttribute("data-personastate") ??
        element.getAttribute("data-persona-state") ??
        stateNode?.getAttribute("data-personastate") ??
        stateNode?.getAttribute("data-persona-state");
      const personaState =
        personaStateRaw !== null && personaStateRaw !== undefined
          ? Number(personaStateRaw)
          : Number.NaN;

      const statusText = String(
        container.textContent ?? element.textContent ?? ""
      )
        .toLowerCase()
        .replace(/\s+/g, " ");
      const inGame =
        classTokens.has("ingame") ||
        classTokens.has("in-game") ||
        classTokens.has("friendstatus_ingame") ||
        classTokens.has("friendstatus_in-game") ||
        statusText.includes("currently playing") ||
        statusText.includes("in-game") ||
        statusText.includes("playing");
      const idle =
        (Number.isFinite(personaState) &&
          (personaState === 3 || personaState === 4)) ||
        classTokens.has("away") ||
        classTokens.has("idle") ||
        classTokens.has("snooze") ||
        classTokens.has("friendstatus_away") ||
        classTokens.has("friendstatus_idle") ||
        classTokens.has("friendstatus_snooze") ||
        statusText.includes(" away") ||
        statusText.includes("snooze") ||
        statusText.includes("idle");
      const onlineSignals =
        inGame ||
        idle ||
        (Number.isFinite(personaState) && personaState > 0) ||
        classTokens.has("online") ||
        classTokens.has("busy") ||
        classTokens.has("friendstatus_online") ||
        classTokens.has("friendstatus_busy") ||
        classTokens.has("friendstatus_lookingtoplay") ||
        classTokens.has("friendstatus_lookingtotrade") ||
        classTokens.has("persona_state_online") ||
        classTokens.has("persona_state_busy") ||
        classTokens.has("persona_state_lookingtoplay") ||
        classTokens.has("persona_state_lookingtotrade");
      const onlineText =
        statusText.includes("currently online") ||
        statusText.includes("online") ||
        statusText.includes("busy") ||
        statusText.includes("looking to play") ||
        statusText.includes("looking to trade");
      const online = onlineSignals || onlineText;
      if (!online) {
        return;
      }

      const avatar =
        (container.querySelector("img") as HTMLImageElement | null) ??
        (element.querySelector("img") as HTMLImageElement | null);
      const nameSource =
        container.getAttribute("aria-label") ??
        container.getAttribute("title") ??
        avatar?.alt ??
        container.querySelector("[class*='name'],[class*='Name'],.persona")
          ?.textContent ??
        container.textContent ??
        element.textContent ??
        "";
      const personaName = nameSource.trim().split("\n")[0].trim() || "Friend";

      const parsed: FriendPresence = {
        steamId,
        personaName,
        avatarUrl: avatar?.src || DEFAULT_AVATAR,
        inGame,
        idle,
      };

      const existing = bySteamId.get(steamId);
      if (!existing) {
        bySteamId.set(steamId, parsed);
      } else {
        bySteamId.set(steamId, this.preferPresence(existing, parsed));
      }
    };

    for (const candidateWindow of this.getCandidateWindows()) {
      const doc = (candidateWindow as any)?.document as Document | undefined;
      if (!doc?.body) {
        continue;
      }
      const selectors = [
        "[data-steamid]",
        "[data-miniprofile]",
        "[data-accountid]",
        "a[href*='/profiles/']",
        "a[href*='/miniprofile/']",
      ];
      const nodes = Array.from(doc.querySelectorAll(selectors.join(","))).slice(
        0,
        4_000
      );
      for (const node of nodes) {
        parseNode(node, doc);
      }
    }

    const friends = this.sortFriends(Array.from(bySteamId.values()));
    if (friends.length) {
      this.domCachedFriends = friends;
      this.domCachedAt = now;
      return friends;
    }
    if (now - this.domCachedAt < DOM_CACHE_MS && this.domCachedFriends.length) {
      return this.domCachedFriends;
    }
    return [];
  }

  private readSteamIdFromNode(element: HTMLElement): string | null {
    const candidates: Array<string | null | undefined> = [];
    let cursor: HTMLElement | null = element;
    let depth = 0;
    while (cursor && depth < 5) {
      candidates.push(
        cursor.getAttribute("data-steamid"),
        cursor.getAttribute("data-miniprofile"),
        cursor.getAttribute("data-accountid"),
        cursor.id
      );
      const href = (cursor as HTMLAnchorElement).href;
      if (href) {
        candidates.push(href);
      }
      cursor = cursor.parentElement;
      depth += 1;
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const profileMatch = candidate.match(/profiles\/(\d{17})/);
      if (profileMatch?.[1]) {
        return profileMatch[1];
      }
      const miniProfileMatch = candidate.match(/miniprofile\/(\d+)/);
      if (miniProfileMatch?.[1]) {
        const normalized = this.normalizeSteamId(miniProfileMatch[1]);
        if (normalized) {
          return normalized;
        }
      }
      const normalized = this.normalizeSteamId(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private fetchReactTreeOnlineFriends(): FriendPresence[] {
    const roots = new Set<any>();
    const addRootFromNode = (node: Node | null | undefined) => {
      if (!node) {
        return;
      }
      try {
        const root = getReactRoot(node);
        if (root && (typeof root === "object" || typeof root === "function")) {
          roots.add(root);
        }
      } catch {
        // ignore
      }
    };

    for (const candidateWindow of this.getCandidateWindows()) {
      const doc = (candidateWindow as any)?.document as Document | undefined;
      if (!doc?.body) {
        continue;
      }
      addRootFromNode(doc.body);
      const candidates = Array.from(
        doc.querySelectorAll("main,header,[class*='TopBar'],[class*='topbar']")
      ).slice(0, 30);
      for (const node of candidates) {
        addRootFromNode(node);
      }
    }

    if (!roots.size) {
      return [];
    }

    const bySteamId = new Map<string, FriendPresence>();
    const visited = new WeakSet<object>();
    const queue: Array<{ value: unknown; depth: number }> = [];
    for (const root of roots) {
      queue.push({ value: root, depth: 0 });
    }

    let scanned = 0;
    const maxScanned = 18_000;
    while (queue.length > 0 && scanned < maxScanned) {
      const next = queue.shift();
      if (!next) {
        break;
      }
      const { value, depth } = next;
      if (!value || (typeof value !== "object" && typeof value !== "function")) {
        continue;
      }
      const obj = value as object;
      if (visited.has(obj)) {
        continue;
      }
      visited.add(obj);
      scanned += 1;

      const candidateContainers = [
        (value as any).memoizedProps,
        (value as any).pendingProps,
        (value as any).memoizedState,
        (value as any).stateNode,
        (value as any).props,
      ];
      for (const container of candidateContainers) {
        const rawRecords = this.collectRawRecordsFromUnknown(container);
        for (const raw of rawRecords) {
          const parsed = this.parsePresenceFromRaw(raw);
          if (!parsed) {
            continue;
          }
          const existing = bySteamId.get(parsed.steamId);
          if (!existing) {
            bySteamId.set(parsed.steamId, parsed);
          } else {
            bySteamId.set(parsed.steamId, this.preferPresence(existing, parsed));
          }
        }
      }

      if (depth >= 6) {
        continue;
      }

      const directKeys = [
        "child",
        "sibling",
        "return",
        "alternate",
        "memoizedProps",
        "pendingProps",
        "memoizedState",
        "stateNode",
        "dependencies",
        "updateQueue",
      ];
      for (const key of directKeys) {
        const child = (value as any)[key];
        if (child && (typeof child === "object" || typeof child === "function")) {
          queue.push({ value: child, depth: depth + 1 });
        }
      }

      const keys = Object.keys(value as Record<string, unknown>).slice(0, 120);
      for (const key of keys) {
        if (
          depth > 2 &&
          !/friend|persona|online|presence|state|status|props|memoized|child|sibling|list|map|store|data/i.test(
            key
          )
        ) {
          continue;
        }
        const child = (value as any)[key];
        if (!child || (typeof child !== "object" && typeof child !== "function")) {
          continue;
        }
        queue.push({ value: child, depth: depth + 1 });
      }
    }

    return this.sortFriends(Array.from(bySteamId.values()));
  }

  private getWebpackFriendContainers(): any[] {
    const now = Date.now();
    if (
      this.webpackFriendContainers.length &&
      now - this.webpackContainersLastScan < WEBPACK_SCAN_CACHE_MS
    ) {
      return this.webpackFriendContainers;
    }

    const out: any[] = [];
    const seen = new Set<any>();
    const add = (value: unknown) => {
      if (!value) {
        return;
      }
      if (typeof value !== "object" && typeof value !== "function") {
        return;
      }
      if (!this.looksLikeFriendContainer(value)) {
        return;
      }
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    };

    const bannedFunctionName = /register|add|remove|send|invite|open|show|set|toggle|start|stop|clear|post/i;
    for (const moduleRecord of webpackModuleMap.values()) {
      for (const root of [moduleRecord?.default, moduleRecord]) {
        if (!root || (typeof root !== "object" && typeof root !== "function")) {
          continue;
        }
        add(root);
        if (typeof root !== "object") {
          continue;
        }
        const keys = Object.keys(root).slice(0, 220);
        for (const key of keys) {
          const child = (root as any)[key];
          add(child);

          if (typeof child !== "function" || child.length > 0) {
            continue;
          }
          if (bannedFunctionName.test(key)) {
            continue;
          }
          if (!/^(get|use)/i.test(key)) {
            continue;
          }
          if (!/friend|persona|social|player|chat|presence|online/i.test(key)) {
            continue;
          }

          try {
            const resolved = child.call(root);
            add(resolved);
          } catch {
            // ignore getter invocation errors
          }
        }
      }
    }

    this.webpackFriendContainers = out;
    this.webpackContainersLastScan = now;
    return out;
  }

  private looksLikeFriendContainer(value: unknown): boolean {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return false;
    }
    const record = value as Record<string, unknown>;

    const directKeys = [
      "m_mapFriends",
      "m_mapFriendSteamIDToFriend",
      "m_mapFriendSteamIDToPersona",
      "m_mapFriendSteamIDToUser",
      "m_mapPlayers",
      "m_mapPlayerCache",
      "m_mapPersonaStates",
      "m_mapPresence",
      "m_mapOnlineFriends",
      "m_rgFriends",
      "friends",
      "rgFriends",
      "GetFriends",
      "GetFriendList",
      "GetOnlineFriends",
      "GetCachedFriends",
      "GetPersona",
      "GetFriend",
    ];
    for (const key of directKeys) {
      if (key in record) {
        return true;
      }
    }

    const keys = Object.keys(record).slice(0, 120);
    if (!keys.length) {
      return false;
    }
    let signalCount = 0;
    for (const key of keys) {
      if (/friend|persona|social|player|chat|presence|online|state|status/i.test(key)) {
        signalCount += 1;
        if (signalCount >= 2) {
          return true;
        }
      }
    }
    return false;
  }

  private async fetchSteamClientOnlineFriends(): Promise<FriendPresence[]> {
    const modules = new Set<any>();
    const addModule = (value: unknown) => {
      if (value && (typeof value === "object" || typeof value === "function")) {
        modules.add(value);
      }
    };

    for (const candidateWindow of this.getCandidateWindows()) {
      const steamClient = (candidateWindow as any).SteamClient;
      addModule(steamClient);
      addModule(steamClient?.Friends);
      addModule(steamClient?.WebChat);
    }

    const bySteamId = new Map<string, FriendPresence>();
    const positiveNameAllowList = new Set([
      "GetFriends",
      "GetFriendList",
      "GetFriendsList",
      "GetOnlineFriends",
      "GetFriendPersonaStates",
      "GetPersonaStates",
      "GetFriendSummaries",
      "GetPlayerSummaries",
      "GetPresence",
      "GetFriendPresence",
    ]);
    const bannedNamePattern =
      /register|invite|add|remove|show|open|toggle|set|start|stop|clear|post|send|display|connect|disconnect|dialog/i;

    for (const module of modules) {
      const methodNames = Object.getOwnPropertyNames(module);
      for (const methodName of methodNames) {
        if (bannedNamePattern.test(methodName)) {
          continue;
        }
        const probablyGetter =
          positiveNameAllowList.has(methodName) ||
          /^Get[A-Z].*(Friend|Persona|Player|Presence|Online|User)/.test(
            methodName
          );
        if (!probablyGetter) {
          continue;
        }
        const method = module?.[methodName];
        if (typeof method !== "function") {
          continue;
        }
        if (method.length > 1) {
          continue;
        }

        let result: unknown;
        try {
          const maybeResult = method.call(module);
          result = await Promise.race([
            Promise.resolve(maybeResult),
            new Promise<null>((resolve) => {
              window.setTimeout(() => resolve(null), 1_200);
            }),
          ]);
        } catch {
          continue;
        }
        if (!result) {
          continue;
        }

        const rawRecords = this.collectRawRecordsFromUnknown(result);
        for (const raw of rawRecords) {
          const parsed = this.parsePresenceFromRaw(raw);
          if (!parsed) {
            continue;
          }
          const existing = bySteamId.get(parsed.steamId);
          if (!existing) {
            bySteamId.set(parsed.steamId, parsed);
          } else {
            bySteamId.set(parsed.steamId, this.preferPresence(existing, parsed));
          }
        }
      }
    }

    return this.sortFriends(Array.from(bySteamId.values()));
  }

  private collectRawRecordsFromUnknown(input: unknown): any[] {
    const out: any[] = [];
    const seen = new Set<any>();
    const visited = new WeakSet<object>();
    const queue: Array<{ value: unknown; depth: number }> = [
      { value: input, depth: 0 },
    ];
    let scanned = 0;
    const maxScanned = 2_000;

    const addRecord = (value: any) => {
      if (!value) {
        return;
      }
      if (typeof value === "object" || typeof value === "function") {
        if (!seen.has(value)) {
          seen.add(value);
          out.push(value);
        }
      }
    };

    while (queue.length > 0 && scanned < maxScanned) {
      const next = queue.shift();
      if (!next) {
        break;
      }
      const { value, depth } = next;
      scanned += 1;
      if (!value) {
        continue;
      }

      if (typeof value === "object" || typeof value === "function") {
        addRecord(value);
      }

      if (depth >= 4) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value.slice(0, 120)) {
          queue.push({ value: item, depth: depth + 1 });
        }
        continue;
      }

      if (value instanceof Map || value instanceof Set) {
        let idx = 0;
        for (const item of value.values()) {
          if (idx >= 120) {
            break;
          }
          queue.push({ value: item, depth: depth + 1 });
          idx += 1;
        }
        continue;
      }

      if (typeof value === "object" || typeof value === "function") {
        const objectValue = value as Record<string, unknown>;
        if (visited.has(objectValue as object)) {
          continue;
        }
        visited.add(objectValue as object);

        const specialKeys = [
          "response",
          "result",
          "data",
          "friends",
          "players",
          "personas",
          "items",
          "entries",
          "list",
          "values",
          "rows",
        ];
        for (const key of specialKeys) {
          const child = objectValue[key];
          if (child) {
            queue.push({ value: child, depth: depth + 1 });
          }
        }

        const keys = Object.keys(objectValue).slice(0, 120);
        for (const key of keys) {
          const child = objectValue[key];
          if (!child || (typeof child !== "object" && typeof child !== "function")) {
            continue;
          }
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }

    return out;
  }

  private async fetchSPTabOnlineFriends(): Promise<FriendPresence[]> {
    const code = this.getSPFriendExtractionCode();
    type TabProbe = {
      tab: string;
      rows: any[];
      success: boolean;
      note: string;
    };
    const probes = await Promise.all(
      SP_TAB_CANDIDATES.map(async (tab): Promise<TabProbe> => {
        try {
          const response = await Promise.race([
            executeInTab(tab, true, code),
            new Promise<null>((resolve) => {
              window.setTimeout(() => resolve(null), SP_TAB_TIMEOUT_MS);
            }),
          ]);
          if (!response) {
            return {
              tab,
              rows: [],
              success: false,
              note: "timeout/null",
            };
          }
          const success = Boolean((response as any)?.success ?? true);
          const rawResult = (response as any)?.result ?? response;
          const rows = this.extractRowsFromUnknown(rawResult);
          const debugRaw =
            rawResult && typeof rawResult === "object"
              ? (rawResult as any).debug
              : undefined;
          const debug =
            typeof debugRaw === "string"
              ? debugRaw.replace(/\s+/g, " ").slice(0, 96)
              : "";
          const note = success
            ? debug
              ? `ok:${debug}`
              : "ok"
            : debug
              ? `exec-failed:${debug}`
              : "exec-failed";
          return { tab, rows, success, note };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "exception";
          return {
            tab,
            rows: [],
            success: false,
            note: `error:${message.slice(0, 36)}`,
          };
        }
      })
    );

    this.lastSPProbe = probes
      .map((probe) => `${probe.tab}:${probe.rows.length}:${probe.note}`)
      .join(" | ");

    const best = probes.sort((left, right) => right.rows.length - left.rows.length)[0];
    if (!best || !best.rows.length) {
      return [];
    }

    const byId = new Map<string, FriendPresence>();
    for (const row of best.rows) {
      const parsed = this.parsePresenceFromRaw(row);
      if (!parsed) {
        continue;
      }
      const existing = byId.get(parsed.steamId);
      if (!existing) {
        byId.set(parsed.steamId, parsed);
      } else {
        byId.set(parsed.steamId, this.preferPresence(existing, parsed));
      }
    }

    return this.sortFriends(Array.from(byId.values()));
  }

  private extractRowsFromUnknown(rawResult: unknown): any[] {
    if (!rawResult) {
      return [];
    }
    if (Array.isArray(rawResult)) {
      return rawResult;
    }
    if (typeof rawResult === "string") {
      try {
        const parsed = JSON.parse(rawResult);
        return this.extractRowsFromUnknown(parsed);
      } catch {
        return [];
      }
    }
    if (typeof rawResult !== "object") {
      return [];
    }

    const obj = rawResult as Record<string, unknown>;
    const directArrayKeys = [
      "friends",
      "players",
      "result",
      "data",
      "items",
      "rows",
      "entries",
      "list",
      "personas",
      "values",
    ];
    for (const key of directArrayKeys) {
      const value = obj[key];
      if (Array.isArray(value)) {
        return value;
      }
    }

    const nestedKeys = ["response", "payload", "body", "output"];
    for (const key of nestedKeys) {
      const value = obj[key];
      const extracted = this.extractRowsFromUnknown(value);
      if (extracted.length) {
        return extracted;
      }
    }

    return [];
  }

  private getSPFriendExtractionCode(): string {
    return `
      (async () => {
        const BASE = 76561197960265728n;
        const normalizeSteamId = (value) => {
          if (value === null || value === undefined) return null;
          const text = String(value);
          const match = text.match(/\\d+/);
          if (!match) return null;
          const digits = match[0];
          if (digits.length === 17) return digits;
          if (digits.length <= 10) {
            try {
              const accountId = BigInt(digits);
              if (accountId > 0n) return (BASE + accountId).toString();
            } catch {}
          }
          return null;
        };

        const out = new Map();
        const MAX_ITEMS = 6000;
        let processed = 0;
        const toNumber = (value) => {
          const n = Number(value);
          return Number.isFinite(n) ? n : 0;
        };
        const callMaybe = (obj, key) => {
          try {
            const fn = obj?.[key];
            if (typeof fn === "function") {
              return fn.call(obj);
            }
          } catch {}
          return undefined;
        };
        const eachCollectionValue = (value, cb) => {
          if (!value) return;
          if (Array.isArray(value)) {
            for (let i = 0; i < value.length && i < 600; i += 1) cb(value[i]);
            return;
          }
          if (value instanceof Map || value instanceof Set) {
            let idx = 0;
            for (const item of value.values()) {
              if (idx >= 600) break;
              cb(item);
              idx += 1;
            }
            return;
          }
          if (typeof value === "object" && typeof value[Symbol.iterator] === "function") {
            let idx = 0;
            for (const item of value) {
              if (idx >= 600) break;
              cb(item);
              idx += 1;
            }
          }
        };
        const debugParts = [];
        const dbg = (label) => {
          if (debugParts.length < 18) {
            debugParts.push(String(label).replace(/\\s+/g, " ").slice(0, 64));
          }
        };
        const collectFromAny = (value, tokens, steamIds, depth = 0, visited = new WeakSet()) => {
          if (value === null || value === undefined || depth > 5) return;
          if (typeof value === "string") {
            const text = value;
            const secureMatch = text.match(/(\\d{17})\\|\\|([A-Za-z0-9._~-]{16,})/);
            if (secureMatch?.[1]) steamIds.add(secureMatch[1]);
            if (secureMatch?.[2]) tokens.add(secureMatch[2]);

            const tokenPatterns = [
              /(?:access[_-]?token|oauth[_-]?token|webapi[_-]?token|auth[_-]?token)["']?\\s*[:=]\\s*["']([A-Za-z0-9._~-]{16,})/ig,
              /(?:token)=([A-Za-z0-9._~-]{20,})/ig,
            ];
            for (const pattern of tokenPatterns) {
              let m;
              while ((m = pattern.exec(text))) {
                if (m?.[1]) tokens.add(m[1]);
              }
            }

            const steamPatterns = [
              /(?:steamid|steam_id)["']?\\s*[:=]\\s*["']?(\\d{17})/ig,
              /(?:accountid|account_id)["']?\\s*[:=]\\s*["']?(\\d{1,10})/ig,
            ];
            for (const pattern of steamPatterns) {
              let m;
              while ((m = pattern.exec(text))) {
                const normalized = normalizeSteamId(m?.[1]);
                if (normalized) steamIds.add(normalized);
              }
            }
            return;
          }
          if (typeof value !== "object" && typeof value !== "function") return;
          if (typeof value === "object") {
            if (visited.has(value)) return;
            visited.add(value);
          }
          if (Array.isArray(value)) {
            for (let i = 0; i < value.length && i < 120; i += 1) {
              collectFromAny(value[i], tokens, steamIds, depth + 1, visited);
            }
            return;
          }
          if (value instanceof Map || value instanceof Set) {
            let i = 0;
            for (const entry of value.values()) {
              if (i >= 120) break;
              collectFromAny(entry, tokens, steamIds, depth + 1, visited);
              i += 1;
            }
            return;
          }
          const record = value;
          const keys = Object.keys(record);
          for (let i = 0; i < keys.length && i < 140; i += 1) {
            const key = keys[i];
            const child = record[key];
            if (child === null || child === undefined) continue;
            if (typeof child === "string") {
              if (/token|oauth|auth|webapi/i.test(key) && child.length >= 16) {
                tokens.add(child);
              }
              if (/steam|account/i.test(key)) {
                const normalized = normalizeSteamId(child);
                if (normalized) steamIds.add(normalized);
              }
            }
            if (typeof child === "number" && /account/i.test(key)) {
              const normalized = normalizeSteamId(child);
              if (normalized) steamIds.add(normalized);
            }
            if (typeof child === "object" || typeof child === "function") {
              collectFromAny(child, tokens, steamIds, depth + 1, visited);
            }
          }
        };
        const extractFriendIds = (payload) => {
          const arrays = [
            payload?.friendslist?.friends,
            payload?.response?.friends,
            payload?.friends,
            payload?.data?.friends,
            payload?.result?.friends,
          ];
          const ids = [];
          for (const arr of arrays) {
            if (!Array.isArray(arr)) continue;
            for (const row of arr) {
              const normalized = normalizeSteamId(
                row?.steamid ?? row?.steamId ?? row?.friendid ?? row?.accountid ?? row?.accountId
              );
              if (normalized) ids.push(normalized);
            }
          }
          return Array.from(new Set(ids));
        };
        const extractPlayers = (payload) => {
          const arrays = [
            payload?.response?.players,
            payload?.players,
            payload?.data?.players,
            payload?.result?.players,
            payload?.data?.personas,
            payload?.personas,
          ];
          const rows = [];
          for (const arr of arrays) {
            if (!Array.isArray(arr)) continue;
            rows.push(...arr);
          }
          return rows;
        };
        const fetchTextOrJson = async (url) => {
          try {
            const response = await fetch(url, {
              method: "GET",
              credentials: "include",
              headers: {
                Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
              },
            });
            if (!response) {
              dbg("f:0:" + String(url).slice(0, 24));
              return null;
            }
            const text = await response.text();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            dbg(
              "f:" +
                String(response.status) +
                ":" +
                (url.includes("clientjstoken")
                  ? "cjt"
                  : url.includes("GetFriendList")
                    ? "fl"
                    : url.includes("GetUserSummaries")
                      ? "sum"
                      : "txt") +
                ":" +
                String(text.length)
            );
            return {
              ok: response.ok,
              status: response.status,
              text,
              json,
            };
          } catch (error) {
            const message = error?.message ? String(error.message).slice(0, 24) : "err";
            dbg("ferr:" + message);
            return null;
          }
        };

        const add = (raw) => {
          if (processed >= MAX_ITEMS) return;
          if (!raw || (typeof raw !== "object" && typeof raw !== "function")) return;
          processed += 1;
          const persona = raw.persona ?? raw.m_persona ?? raw.m_user ?? raw.m_data;
          const steamid = normalizeSteamId(
            raw.steamid ??
            raw.steamId ??
            raw.m_steamid ??
            raw.strSteamID ??
            raw.m_strSteamID ??
            raw.accountid ??
            raw.accountId ??
            raw.m_unAccountID ??
            persona?.steamid ??
            persona?.steamId ??
            persona?.m_steamid ??
            persona?.strSteamID ??
            persona?.m_strSteamID ??
            persona?.accountid ??
            persona?.accountId ??
            persona?.m_unAccountID ??
            callMaybe(raw, "GetSteamID") ??
            callMaybe(raw, "GetSteamID64")
          );
          if (!steamid) return;

          const personastate = toNumber(
            raw.personastate ??
            raw.personaState ??
            raw.m_ePersonaState ??
            raw.nPersonaState ??
            raw.persona_state ??
            persona?.personastate ??
            persona?.personaState ??
            persona?.m_ePersonaState ??
            persona?.nPersonaState ??
            callMaybe(raw, "GetPersonaState") ??
            callMaybe(raw, "GetOnlineStatus") ??
            0
          );
          const statusText = String(
            raw.persona_state_name ??
            raw.personaStatus ??
            raw.m_strStatus ??
            raw.strStatus ??
            persona?.persona_state_name ??
            persona?.personaStatus ??
            persona?.m_strStatus ??
            persona?.strStatus ??
            ""
          ).toLowerCase();
          const in_game = Boolean(
            raw.in_game ??
            raw.inGame ??
            raw.gameid ??
            raw.gameId ??
            raw.m_gameid ??
            raw.game_playing_appid ??
            raw.m_unGamePlayedAppID ??
            persona?.gameid ??
            persona?.gameId ??
            persona?.m_gameid ??
            persona?.game_playing_appid ??
            persona?.m_unGamePlayedAppID ??
            callMaybe(raw, "BIsInGame") ??
            callMaybe(raw, "IsInGame") ??
            callMaybe(persona, "BIsInGame") ??
            callMaybe(persona, "IsInGame")
          );
          const idleSignal =
            raw.idle ??
            raw.is_away ??
            raw.away ??
            raw.bIsAway ??
            raw.m_bIsAway ??
            raw.bIsIdle ??
            raw.m_bIsIdle ??
            persona?.idle ??
            persona?.is_away ??
            persona?.away ??
            persona?.bIsAway ??
            persona?.m_bIsAway ??
            persona?.bIsIdle ??
            persona?.m_bIsIdle ??
            callMaybe(raw, "BIsAway") ??
            callMaybe(raw, "IsAway") ??
            callMaybe(raw, "BIsSnooze") ??
            callMaybe(raw, "IsSnooze") ??
            callMaybe(persona, "BIsAway") ??
            callMaybe(persona, "IsAway") ??
            callMaybe(persona, "BIsSnooze") ??
            callMaybe(persona, "IsSnooze");
          const idle = Boolean(
            idleSignal ||
            personastate === 3 ||
            personastate === 4 ||
            statusText.includes("away") ||
            statusText.includes("snooze") ||
            statusText.includes("idle")
          );
          const onlineSignal =
            raw.online ??
            raw.bOnline ??
            raw.is_online ??
            persona?.online ??
            persona?.bOnline ??
            persona?.is_online ??
            callMaybe(raw, "BIsOnline") ??
            callMaybe(raw, "IsOnline") ??
            callMaybe(persona, "BIsOnline") ??
            callMaybe(persona, "IsOnline");
          const online = Boolean(
            in_game ||
            idle ||
            personastate > 0 ||
            onlineSignal ||
            statusText.includes("online") ||
            statusText.includes("busy") ||
            statusText.includes("looking to play") ||
            statusText.includes("looking to trade")
          );
          if (!online) return;

          const existing = out.get(steamid);
          const candidate = {
            steamid,
            personaname:
              raw.personaname ??
              raw.personaName ??
              raw.m_strPlayerName ??
              raw.strPlayerName ??
              persona?.personaname ??
              persona?.personaName ??
              persona?.m_strPlayerName ??
              persona?.strPlayerName ??
              raw.name ??
              "Friend",
            avatar:
              raw.avatar ??
              raw.avatarmedium ??
              raw.avatarfull ??
              raw.avatar_url ??
              raw.m_strAvatarURL ??
              persona?.avatar ??
              persona?.avatarmedium ??
              persona?.avatarfull ??
              persona?.avatar_url ??
              persona?.m_strAvatarURL,
            avatarmedium:
              raw.avatarmedium ??
              raw.avatar ??
              raw.avatarfull ??
              raw.avatar_url ??
              raw.m_strAvatarURL ??
              persona?.avatarmedium ??
              persona?.avatar ??
              persona?.avatarfull ??
              persona?.avatar_url ??
              persona?.m_strAvatarURL,
            avatarfull:
              raw.avatarfull ??
              raw.avatarmedium ??
              raw.avatar ??
              raw.avatar_url ??
              raw.m_strAvatarURL ??
              persona?.avatarfull ??
              persona?.avatarmedium ??
              persona?.avatar ??
              persona?.avatar_url ??
              persona?.m_strAvatarURL,
            avatarhash:
              raw.avatarhash ??
              raw.m_strAvatarHash ??
              persona?.avatarhash ??
              persona?.m_strAvatarHash,
            personastate,
            in_game,
            idle,
            gameextrainfo:
              raw.gameextrainfo ??
              raw.m_strGameExtraInfo ??
              raw.strGameName ??
              raw.gameName ??
              persona?.gameextrainfo ??
              persona?.m_strGameExtraInfo ??
              persona?.strGameName ??
              persona?.gameName
          };

          if (!existing) {
            out.set(steamid, candidate);
            return;
          }
          if (candidate.in_game && !existing.in_game) {
            out.set(steamid, candidate);
            return;
          }
          if (candidate.idle && !existing.idle) {
            out.set(steamid, candidate);
            return;
          }
          if (!existing.avatar && candidate.avatar) {
            out.set(steamid, candidate);
          }
        };

        const app = window.App ?? {};
        const roots = [
          window,
          globalThis,
          app.m_FriendStore,
          app.FriendStore,
          app.m_FriendsStore,
          app.FriendsStore,
          app.m_FriendsUIStore,
          app.FriendsUIStore,
          app.m_CommunityStore,
          app.m_ChatStore,
          window.g_FriendDataStore,
          window.g_PersonaStore,
          window.g_ChatStore,
          window.g_SocialStore,
          window.FriendStore,
        ];
        for (const key of Object.keys(app)) {
          if (/friend|persona|chat|social|player/i.test(key)) {
            roots.push(app[key]);
          }
        }

        for (const key of Object.keys(window)) {
          let value;
          try {
            value = window[key];
          } catch {
            value = undefined;
          }
          if (!value || (typeof value !== "object" && typeof value !== "function")) {
            continue;
          }
          if (/friend|persona|chat|social|player|steam|presence|community|account|user/i.test(key)) {
            roots.push(value);
          }
        }
        if (roots.length < 16) {
          const fallbackKeys = Object.keys(window).slice(0, 260);
          for (const key of fallbackKeys) {
            let value;
            try {
              value = window[key];
            } catch {
              value = undefined;
            }
            if (!value || (typeof value !== "object" && typeof value !== "function")) {
              continue;
            }
            roots.push(value);
          }
        }

        const collectionKeys = [
          "m_mapFriends",
          "m_mapFriendSteamIDToFriend",
          "m_mapFriendSteamIDToPersona",
          "m_mapFriendSteamIDToUser",
          "m_mapPlayers",
          "m_mapPlayerCache",
          "m_mapAccountIDToUser",
          "m_mapAccountIDToPersona",
          "m_mapPersonaStates",
          "m_mapPresence",
          "m_mapOnlineUsers",
          "m_mapOnlineFriends",
          "m_mapCachedFriends",
          "m_rgFriends",
          "rgFriends",
          "m_rgUsers",
          "rgUsers",
          "friends",
          "m_rgOnlineFriends",
          "rgOnlineFriends",
        ];
        const methodKeys = [
          "GetFriends",
          "GetAllFriends",
          "GetFriendList",
          "GetOnlineFriends",
          "GetCachedFriends",
        ];

        for (const root of roots) {
          if (!root || (typeof root !== "object" && typeof root !== "function")) {
            continue;
          }
          add(root);
          eachCollectionValue(root, add);
          for (const key of collectionKeys) {
            try {
              eachCollectionValue(root[key], add);
            } catch {}
          }
          for (const key of methodKeys) {
            try {
              const method = root[key];
              if (typeof method === "function") {
                eachCollectionValue(method.call(root), add);
              }
            } catch {}
          }
        }

        // Broad fallback traversal for minified stores where key names do not include
        // "friend"/"persona". Keep this capped to avoid long SP execution time.
        const visited = new WeakSet();
        const queue = [];
        const enqueue = (value, depth = 0) => {
          if (!value || (typeof value !== "object" && typeof value !== "function")) return;
          queue.push({ value, depth });
        };
        for (const root of roots) {
          enqueue(root, 0);
        }
        let scanned = 0;
        while (queue.length && processed < MAX_ITEMS && scanned < 12000) {
          const next = queue.shift();
          if (!next) break;
          const { value, depth } = next;
          if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
          if (typeof value === "object") {
            if (visited.has(value)) continue;
            visited.add(value);
          }
          scanned += 1;
          add(value);
          eachCollectionValue(value, add);
          if (depth >= 5) continue;

          if (Array.isArray(value)) {
            for (let i = 0; i < value.length && i < 140; i += 1) {
              enqueue(value[i], depth + 1);
            }
            continue;
          }
          if (value instanceof Map || value instanceof Set) {
            let i = 0;
            for (const item of value.values()) {
              if (i >= 140) break;
              enqueue(item, depth + 1);
              i += 1;
            }
            continue;
          }
          const keys = Object.keys(value);
          for (let i = 0; i < keys.length && i < 140; i += 1) {
            const child = value[keys[i]];
            if (!child) continue;
            enqueue(child, depth + 1);
          }
        }

        const parseHtmlFallback = (html) => {
          if (!html || html.length < 100) return;
          let doc;
          try {
            doc = new DOMParser().parseFromString(html, "text/html");
          } catch {
            return;
          }
          const entries = Array.from(doc.querySelectorAll(".friend_block_v2, .friend_block"));
          for (const entry of entries) {
            if (!entry) continue;
            const readSteamId = () => {
              const attrs = [
                entry.getAttribute?.("data-steamid"),
                entry.getAttribute?.("data-miniprofile"),
                entry.getAttribute?.("data-accountid"),
                entry.id,
              ];
              for (const candidate of attrs) {
                const normalized = normalizeSteamId(candidate);
                if (normalized) return normalized;
              }
              const links = Array.from(entry.querySelectorAll?.("a[href]") ?? []);
              for (const link of links) {
                const href = link?.getAttribute?.("href") ?? "";
                const profileMatch = href.match(/profiles\\/(\\d{17})/);
                if (profileMatch?.[1]) return profileMatch[1];
                const miniMatch = href.match(/miniprofile\\/(\\d+)/);
                if (miniMatch?.[1]) {
                  const normalized = normalizeSteamId(miniMatch[1]);
                  if (normalized) return normalized;
                }
              }
              return null;
            };
            const steamid = readSteamId();
            if (!steamid) continue;

            const classTokens = new Set();
            const collect = (className) => {
              if (!className) return;
              for (const token of String(className).toLowerCase().split(/\\s+/g)) {
                if (token) classTokens.add(token);
              }
            };
            collect(entry.className);
            for (const node of Array.from(entry.querySelectorAll?.("[class]") ?? [])) {
              collect(node.className);
            }
            const stateNode = entry.querySelector?.("[data-personastate], [data-persona-state]");
            const personaStateRaw =
              entry.getAttribute?.("data-personastate") ??
              entry.getAttribute?.("data-persona-state") ??
              stateNode?.getAttribute?.("data-personastate") ??
              stateNode?.getAttribute?.("data-persona-state");
            const personaState = personaStateRaw !== null && personaStateRaw !== undefined ? Number(personaStateRaw) : 0;

            const statusText = String(
              entry.querySelector?.(".friend_block_content")?.textContent ??
              entry.querySelector?.(".friend_block_status")?.textContent ??
              entry.textContent ??
              ""
            ).toLowerCase().replace(/\\s+/g, " ");
            const in_game =
              classTokens.has("ingame") ||
              classTokens.has("in-game") ||
              classTokens.has("friendstatus_ingame") ||
              statusText.includes("in-game") ||
              statusText.includes("currently playing") ||
              statusText.includes("playing");
            const idle =
              personaState === 3 ||
              personaState === 4 ||
              classTokens.has("away") ||
              classTokens.has("snooze") ||
              classTokens.has("idle") ||
              classTokens.has("friendstatus_away") ||
              classTokens.has("friendstatus_snooze") ||
              classTokens.has("friendstatus_idle") ||
              statusText.includes("away") ||
              statusText.includes("snooze") ||
              statusText.includes("idle");
            const online =
              in_game ||
              idle ||
              personaState > 0 ||
              classTokens.has("online") ||
              classTokens.has("busy") ||
              classTokens.has("friendstatus_online") ||
              classTokens.has("friendstatus_busy") ||
              statusText.includes("online") ||
              statusText.includes("busy") ||
              statusText.includes("looking to play") ||
              statusText.includes("looking to trade");
            if (!online) continue;

            const avatar = entry.querySelector?.("img");
            const personaname = String(
              entry.querySelector?.(".friend_block_content")?.textContent ??
              entry.querySelector?.(".friend_block_name")?.textContent ??
              entry.querySelector?.(".persona")?.textContent ??
              "Friend"
            ).trim().split("\\n")[0].trim() || "Friend";

            add({
              steamid,
              personaname,
              avatarmedium: avatar?.src ?? undefined,
              avatar: avatar?.src ?? undefined,
              personastate: personaState,
              in_game,
              idle,
            });
          }
        };

        if (!out.size) {
          const fetchUrls = [
            "https://steamcommunity.com/actions/PlayerList/?type=friendsonline&l=english",
            "https://steamcommunity.com/actions/PlayerList/?type=online&l=english",
            "https://steamcommunity.com/actions/PlayerList/?type=friends&l=english",
            "https://steamcommunity.com/my/friends/?l=english",
            "https://steamcommunity.com/chat/clientjstoken",
          ];
          for (const url of fetchUrls) {
            try {
              const response = await fetch(url, {
                method: "GET",
                credentials: "include",
                headers: {
                  Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
                },
              });
              if (!response?.ok) continue;
              const body = await response.text();
              if (!body) continue;
              if (body.trim().startsWith("{") || body.trim().startsWith("[")) {
                try {
                  const parsed = JSON.parse(body);
                  add(parsed);
                  eachCollectionValue(parsed, add);
                  const queues = [parsed];
                  let depth = 0;
                  while (queues.length && depth < 5 && processed < MAX_ITEMS) {
                    const value = queues.shift();
                    if (!value || (typeof value !== "object" && typeof value !== "function")) continue;
                    add(value);
                    eachCollectionValue(value, add);
                    const keys = Object.keys(value).slice(0, 80);
                    for (const key of keys) {
                      const child = value[key];
                      if (child && (typeof child === "object" || typeof child === "function")) {
                        queues.push(child);
                      }
                    }
                    depth += 1;
                  }
                } catch {
                  parseHtmlFallback(body);
                }
              } else {
                parseHtmlFallback(body);
              }
            } catch {}
            if (out.size) break;
          }
        }
        const oauthTokens = new Set();
        const oauthSteamIds = new Set();
        try {
          const cookie = String(document?.cookie ?? "");
          const loginCookie = cookie
            .split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith("steamLoginSecure="));
          if (loginCookie) {
            const raw = loginCookie.split("=")[1] ?? "";
            const decoded = decodeURIComponent(raw);
            collectFromAny(decoded, oauthTokens, oauthSteamIds, 0);
          }
        } catch {}

        const authPayloadUrls = [
          "https://steamcommunity.com/chat/clientjstoken",
          "https://steamcommunity.com/chat/clientjstoken/",
          "https://steamcommunity.com/my/friends/?l=english",
        ];
        for (const url of authPayloadUrls) {
          const payload = await fetchTextOrJson(url);
          if (!payload) continue;
          if (payload.json) {
            collectFromAny(payload.json, oauthTokens, oauthSteamIds, 0);
          }
          if (payload.text) {
            collectFromAny(payload.text, oauthTokens, oauthSteamIds, 0);
          }
        }

        try {
          const refreshInfo = await window?.SteamClient?.Auth?.GetRefreshInfo?.();
          if (refreshInfo) {
            dbg("ri:1");
            collectFromAny(refreshInfo, oauthTokens, oauthSteamIds, 0);
          } else {
            dbg("ri:0");
          }
        } catch {
          dbg("ri:err");
        }

        try {
          const userSid = normalizeSteamId(window?.App?.m_CurrentUser?.strSteamID);
          if (userSid) oauthSteamIds.add(userSid);
        } catch {}

        try {
          const urlsPayload = await window?.SteamClient?.URL?.GetSteamURLList?.([
            "SteamIDFriendsList",
            "SteamIDFriendsPage",
            "CommunityFriendsThatPlay",
            "WebAPI",
            "ChatRoot",
            "CommunityHome",
          ]);
          const entries = urlsPayload && typeof urlsPayload === "object"
            ? Object.values(urlsPayload)
            : [];
          dbg("u:" + String(entries.length));
          for (const entry of entries) {
            const url = String(entry?.url ?? "");
            if (!url) continue;
            collectFromAny(url, oauthTokens, oauthSteamIds, 0);
            const payload = await fetchTextOrJson(url);
            if (!payload) continue;
            if (payload.json) {
              collectFromAny(payload.json, oauthTokens, oauthSteamIds, 0);
            }
            if (payload.text) {
              collectFromAny(payload.text, oauthTokens, oauthSteamIds, 0);
              parseHtmlFallback(payload.text);
            }
          }
        } catch {
          dbg("u:err");
        }

        dbg("tok:" + String(oauthTokens.size));
        dbg("sid:" + String(oauthSteamIds.size));

        const allFriendIds = new Set();
        if (oauthTokens.size) {
          const tokens = Array.from(oauthTokens).slice(0, 4);
          let steamIds = Array.from(oauthSteamIds).slice(0, 4);
          if (!steamIds.length) {
            try {
              const currentUserSid = normalizeSteamId(window?.App?.m_CurrentUser?.strSteamID);
              if (currentUserSid) steamIds = [currentUserSid];
            } catch {}
          }
          for (const token of tokens) {
            for (const steamid of steamIds.length ? steamIds : [null]) {
              const urls = [
                steamid
                  ? "https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v1/?steamid=" +
                    steamid +
                    "&relationship=friend&access_token=" +
                    encodeURIComponent(token)
                  : "https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v1/?relationship=friend&access_token=" +
                    encodeURIComponent(token),
                steamid
                  ? "https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v0001/?steamid=" +
                    steamid +
                    "&relationship=friend&access_token=" +
                    encodeURIComponent(token)
                  : "https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v0001/?relationship=friend&access_token=" +
                    encodeURIComponent(token),
              ];
              for (const url of urls) {
                const payload = await fetchTextOrJson(url);
                if (!payload?.json) continue;
                for (const friendId of extractFriendIds(payload.json)) {
                  allFriendIds.add(friendId);
                }
              }
              if (allFriendIds.size) break;
            }
            if (allFriendIds.size) break;
          }

          dbg("fid:" + String(allFriendIds.size));

          if (allFriendIds.size) {
            const ids = Array.from(allFriendIds);
            for (let index = 0; index < ids.length; index += 100) {
              const chunk = ids.slice(index, index + 100);
              const encoded = encodeURIComponent(chunk.join(","));
              for (const token of tokens) {
                const summaryUrls = [
                  "https://api.steampowered.com/ISteamUserOAuth/GetUserSummaries/v1/?steamids=" +
                    encoded +
                    "&access_token=" +
                    encodeURIComponent(token),
                  "https://api.steampowered.com/ISteamUserOAuth/GetUserSummaries/v0002/?steamids=" +
                    encoded +
                    "&access_token=" +
                    encodeURIComponent(token),
                ];
                for (const url of summaryUrls) {
                  const payload = await fetchTextOrJson(url);
                  if (!payload?.json) continue;
                  for (const row of extractPlayers(payload.json)) {
                    add(row);
                  }
                }
              }
            }
          }
        }

        return {
          friends: Array.from(out.values()),
          debug: debugParts.join(","),
        };
      })()
    `;
  }

  private resolveCurrentSteamId(): string | null {
    const candidates: unknown[] = [];
    for (const candidateWindow of this.getCandidateWindows()) {
      const appUser = (candidateWindow as any).App?.m_CurrentUser;
      candidates.push(
        appUser?.strSteamID,
        appUser?.steamid,
        appUser?.m_strSteamID,
        (candidateWindow as any).g_steamID,
        (candidateWindow as any).__steamid,
        (candidateWindow as any).AccountData?.steamid,
        (candidateWindow as any).User?.steamid
      );
    }

    const cookieString = [
      this.getTargetDocument().cookie,
      document.cookie,
    ]
      .filter(Boolean)
      .join(";");
    const loginCookie = cookieString
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("steamLoginSecure="));
    if (loginCookie) {
      try {
        const decoded = decodeURIComponent(loginCookie.split("=")[1] ?? "");
        candidates.push(decoded);
      } catch {
        candidates.push(loginCookie.split("=")[1] ?? "");
      }
    }

    for (const candidate of candidates) {
      const normalized = this.normalizeSteamId(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  private fetchWindowStoreOnlineFriends(): FriendPresence[] {
    const containers = new Set<any>();
    const addContainer = (value: unknown) => {
      if (!value) {
        return;
      }
      if (typeof value === "object" || typeof value === "function") {
        containers.add(value);
      }
    };

    for (const candidateWindow of this.getCandidateWindows()) {
      const app = (candidateWindow as any).App;
      if (app && typeof app === "object") {
        addContainer(app.m_FriendStore);
        addContainer(app.FriendStore);
        addContainer(app.m_FriendsStore);
        addContainer(app.FriendsStore);
        addContainer(app.m_FriendsUIStore);
        addContainer(app.FriendsUIStore);
        addContainer(app.m_CommunityStore);
        addContainer(app.m_ChatStore);

        for (const key of Object.keys(app)) {
          if (!/friend|persona|chat|social|player/i.test(key)) {
            continue;
          }
          addContainer((app as Record<string, unknown>)[key]);
        }
      }

      addContainer((candidateWindow as any).g_FriendDataStore);
      addContainer((candidateWindow as any).g_PersonaStore);
      addContainer((candidateWindow as any).g_ChatStore);
      addContainer((candidateWindow as any).g_SocialStore);
      addContainer((candidateWindow as any).FriendStore);
    }

    const bySteamId = new Map<string, FriendPresence>();
    for (const container of containers) {
      const records = this.collectRawFriendRecords(container);
      for (const raw of records) {
        const parsed = this.parsePresenceFromRaw(raw);
        if (!parsed) {
          continue;
        }
        const current = bySteamId.get(parsed.steamId);
        if (!current) {
          bySteamId.set(parsed.steamId, parsed);
          continue;
        }
        bySteamId.set(parsed.steamId, this.preferPresence(current, parsed));
      }
    }

    return this.sortFriends(Array.from(bySteamId.values()));
  }

  private scanOnlineFriendsFromObjectGraph(): FriendPresence[] {
    const roots: unknown[] = [];
    for (const candidateWindow of this.getCandidateWindows()) {
      roots.push(
        (candidateWindow as any).App,
        (candidateWindow as any).SteamClient,
        (candidateWindow as any).g_FriendDataStore,
        (candidateWindow as any).g_PersonaStore,
        candidateWindow
      );
    }
    const visited = new WeakSet<object>();
    const queue: Array<{ value: unknown; depth: number; path: string }> = [];
    const bySteamId = new Map<string, FriendPresence>();
    let scanned = 0;
    const maxNodes = 10_000;

    for (const root of roots) {
      queue.push({ value: root, depth: 0, path: "root" });
    }

    while (queue.length > 0 && scanned < maxNodes) {
      const next = queue.shift();
      if (!next) {
        break;
      }
      const { value, depth, path } = next;
      if (!value || (typeof value !== "object" && typeof value !== "function")) {
        continue;
      }
      const obj = value as object;
      if (visited.has(obj)) {
        continue;
      }
      visited.add(obj);
      scanned += 1;

      const parsed = this.parsePresenceFromRaw(obj as any);
      if (parsed) {
        const current = bySteamId.get(parsed.steamId);
        if (!current) {
          bySteamId.set(parsed.steamId, parsed);
        } else {
          bySteamId.set(parsed.steamId, this.preferPresence(current, parsed));
        }
      }

      if (Array.isArray(value)) {
        if (depth >= 5) {
          continue;
        }
        const max = Math.min(value.length, 120);
        for (let index = 0; index < max; index += 1) {
          queue.push({ value: value[index], depth: depth + 1, path });
        }
        continue;
      }

      if (value instanceof Map || value instanceof Set) {
        if (depth >= 5) {
          continue;
        }
        let index = 0;
        for (const entry of value.values()) {
          if (index > 120) {
            break;
          }
          queue.push({ value: entry, depth: depth + 1, path });
          index += 1;
        }
        continue;
      }

      if (depth >= 5) {
        continue;
      }

      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      const maxKeys = Math.min(keys.length, 120);
      for (let index = 0; index < maxKeys; index += 1) {
        const key = keys[index];
        const child = record[key];
        if (!child || (typeof child !== "object" && typeof child !== "function")) {
          continue;
        }
        const keyName = key.toLowerCase();
        const nextPath = `${path}.${keyName}`;
        queue.push({ value: child, depth: depth + 1, path: nextPath });
      }
    }

    return this.sortFriends(Array.from(bySteamId.values()));
  }

  private collectRawFriendRecords(container: any): any[] {
    const out: any[] = [];
    const seen = new Set<any>();
    const addRecord = (value: any) => {
      if (!value) {
        return;
      }
      if (typeof value === "object" || typeof value === "function") {
        if (!seen.has(value)) {
          seen.add(value);
          out.push(value);
        }
        return;
      }
      const steamId = this.normalizeSteamId(value);
      if (!steamId) {
        return;
      }
      const resolved = this.resolveFriendRecordBySteamId(container, steamId);
      if (resolved) {
        addRecord(resolved);
      }
    };
    const addCollection = (value: any) => {
      if (!value) {
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          addRecord(item);
        }
        return;
      }
      if (value instanceof Map || value instanceof Set) {
        for (const item of value.values()) {
          addRecord(item);
        }
        return;
      }
      if (typeof value === "object" && typeof value[Symbol.iterator] === "function") {
        for (const item of value as Iterable<any>) {
          addRecord(item);
        }
      }
    };

    addCollection(container);

    const collectionKeys = [
      "m_mapFriends",
      "m_mapFriendSteamIDToFriend",
      "m_mapFriendSteamIDToPersona",
      "m_mapFriendSteamIDToUser",
      "m_mapFriendCodeToPersona",
      "m_mapFriendCodeToFriend",
      "m_mapPlayers",
      "m_mapPlayerCache",
      "m_mapAccountIDToUser",
      "m_mapAccountIDToPersona",
      "m_mapPersonaStates",
      "m_mapPresence",
      "m_mapOnlineUsers",
      "m_mapOnlineFriends",
      "m_mapCachedFriends",
      "m_rgFriends",
      "rgFriends",
      "m_rgUsers",
      "rgUsers",
      "friends",
      "m_rgOnlineFriends",
      "rgOnlineFriends",
    ];
    for (const key of collectionKeys) {
      addCollection(container?.[key]);
    }

    const methodKeys = [
      "GetFriends",
      "GetAllFriends",
      "GetFriendList",
      "GetOnlineFriends",
      "GetCachedFriends",
    ];
    for (const key of methodKeys) {
      const method = container?.[key];
      if (typeof method !== "function") {
        continue;
      }
      try {
        const result = method.call(container);
        addCollection(result);
      } catch {
        continue;
      }
    }

    return out;
  }

  private resolveFriendRecordBySteamId(container: any, steamId: string): any | null {
    const accountId = this.steamIdToAccountId(steamId);
    const candidates: unknown[] = [];
    const add = (value: unknown) => {
      if (value && (typeof value === "object" || typeof value === "function")) {
        candidates.push(value);
      }
    };

    const tryCall = (methodName: string, value: unknown) => {
      const method = container?.[methodName];
      if (typeof method !== "function") {
        return;
      }
      try {
        add(method.call(container, value));
      } catch {
        // ignore
      }
    };

    const methodNames = [
      "GetFriend",
      "GetFriendBySteamID",
      "GetFriendBySteamId",
      "GetFriendFromSteamID",
      "GetPersona",
      "GetPersonaBySteamID",
      "GetPersonaBySteamId",
      "GetUser",
      "GetUserBySteamID",
      "GetUserBySteamId",
      "GetPlayerBySteamID",
      "GetPlayerBySteamId",
    ];
    for (const methodName of methodNames) {
      tryCall(methodName, steamId);
      if (accountId) {
        tryCall(methodName, accountId);
        const numeric = Number(accountId);
        if (Number.isFinite(numeric) && Number.isSafeInteger(numeric)) {
          tryCall(methodName, numeric);
        }
      }
    }

    const mapKeys = [
      "m_mapFriends",
      "m_mapFriendSteamIDToFriend",
      "m_mapFriendSteamIDToPersona",
      "m_mapFriendSteamIDToUser",
      "m_mapPlayers",
      "m_mapPlayerCache",
      "m_mapAccountIDToUser",
      "m_mapAccountIDToPersona",
      "m_mapPersonaStates",
      "m_mapPresence",
      "m_mapOnlineUsers",
      "m_mapOnlineFriends",
      "m_mapCachedFriends",
    ];
    for (const key of mapKeys) {
      const map = container?.[key];
      if (!map?.get || typeof map.get !== "function") {
        continue;
      }
      try {
        add(map.get(steamId));
      } catch {
        // ignore
      }
      if (accountId) {
        try {
          add(map.get(accountId));
          const numeric = Number(accountId);
          if (Number.isFinite(numeric) && Number.isSafeInteger(numeric)) {
            add(map.get(numeric));
          }
        } catch {
          // ignore
        }
      }
    }

    return (candidates.find(Boolean) as any) ?? null;
  }

  private steamIdToAccountId(steamId: string): string | null {
    try {
      const accountId = BigInt(steamId) - STEAM_ID64_BASE;
      if (accountId <= 0n) {
        return null;
      }
      return accountId.toString();
    } catch {
      return null;
    }
  }

  private parsePresenceFromRaw(raw: any): FriendPresence | null {
    if (Array.isArray(raw) && raw.length >= 2 && raw[1] && typeof raw[1] === "object") {
      raw = raw[1];
    }
    if (!raw || (typeof raw !== "object" && typeof raw !== "function")) {
      return null;
    }
    const callMaybe = (obj: any, key: string): unknown => {
      try {
        const fn = obj?.[key];
        if (typeof fn === "function") {
          return fn.call(obj);
        }
      } catch {
        // ignore
      }
      return undefined;
    };
    const persona = raw.persona ?? raw.m_persona ?? raw.m_user ?? raw.m_data;

    const steamId = this.normalizeSteamId(
      raw.steamid ??
        raw.steamId ??
        raw.m_steamid ??
        raw.strSteamID ??
        raw.m_strSteamID ??
        raw.accountid ??
        raw.accountId ??
        raw.m_unAccountID ??
        raw.steamid64 ??
        raw.m_ulSteamID ??
        raw.ulSteamID ??
        persona?.steamid ??
        persona?.steamId ??
        persona?.m_steamid ??
        persona?.strSteamID ??
        persona?.m_strSteamID ??
        persona?.accountid ??
        persona?.accountId ??
        persona?.m_unAccountID ??
        callMaybe(raw, "steamid") ??
        callMaybe(raw, "steamId") ??
        callMaybe(raw, "SteamID") ??
        callMaybe(raw, "accountid") ??
        callMaybe(raw, "accountId") ??
        callMaybe(raw, "GetAccountID") ??
        callMaybe(persona, "steamid") ??
        callMaybe(persona, "steamId") ??
        callMaybe(persona, "SteamID") ??
        callMaybe(persona, "accountid") ??
        callMaybe(persona, "accountId") ??
        callMaybe(persona, "GetAccountID") ??
        raw.m_steamid?.ConvertTo64BitString?.() ??
        raw.m_steamid?.toString?.() ??
        raw.GetSteamID64?.() ??
        raw.GetSteamID?.() ??
        callMaybe(raw, "GetSteamID64") ??
        callMaybe(raw, "GetSteamID")
    );
    if (!steamId) {
      return null;
    }

    const personaName = (
      raw.personaname ??
      raw.m_strPlayerName ??
      raw.strPlayerName ??
      raw.m_strPersonaName ??
      raw.strPersonaName ??
      raw.name ??
      callMaybe(raw, "personaname") ??
      callMaybe(raw, "personaName") ??
      callMaybe(raw, "GetName") ??
      persona?.personaname ??
      persona?.personaName ??
      persona?.m_strPlayerName ??
      persona?.strPlayerName ??
      persona?.m_strPersonaName ??
      persona?.strPersonaName ??
      callMaybe(persona, "personaname") ??
      callMaybe(persona, "personaName") ??
      callMaybe(persona, "GetName") ??
      "Friend"
    )
      .toString()
      .trim();

    const personaState = Number(
      raw.personastate ??
        raw.m_ePersonaState ??
        raw.ePersonaState ??
        raw.nPersonaState ??
        raw.persona_state ??
        raw.m_nPersonaState ??
        raw.status ??
        persona?.personastate ??
        persona?.personaState ??
        persona?.m_ePersonaState ??
        persona?.ePersonaState ??
        persona?.nPersonaState ??
        persona?.persona_state ??
        persona?.m_nPersonaState ??
        callMaybe(raw, "personastate") ??
        callMaybe(raw, "personaState") ??
        callMaybe(raw, "GetPersonaState") ??
        callMaybe(raw, "GetOnlineStatus") ??
        callMaybe(raw, "GetOnlineState") ??
        callMaybe(persona, "personastate") ??
        callMaybe(persona, "personaState") ??
        callMaybe(persona, "GetPersonaState") ??
        callMaybe(persona, "GetOnlineStatus") ??
        callMaybe(persona, "GetOnlineState") ??
        raw.GetPersonaState?.() ??
        raw.GetOnlineStatus?.() ??
        raw.m_persona_state ??
        0
    );
    const stateText = String(
      raw.persona_state_name ??
        raw.personaStatus ??
        raw.m_strStatus ??
        raw.strStatus ??
        raw.status_text ??
        raw.statusText ??
        persona?.persona_state_name ??
        persona?.personaStatus ??
        persona?.m_strStatus ??
        persona?.strStatus ??
        persona?.status_text ??
        persona?.statusText ??
        callMaybe(raw, "persona_state_name") ??
        callMaybe(raw, "personaStatus") ??
        callMaybe(raw, "GetPersonaStateName") ??
        callMaybe(raw, "GetStatusString") ??
        callMaybe(persona, "persona_state_name") ??
        callMaybe(persona, "personaStatus") ??
        callMaybe(persona, "GetPersonaStateName") ??
        callMaybe(persona, "GetStatusString") ??
        ""
    ).toLowerCase();
    const inGame = Boolean(
      raw.gameid ??
        raw.gameId ??
        raw.m_gameid ??
        raw.game_playing_appid ??
        raw.m_unGamePlayedAppID ??
        raw.m_gamePlayedAppId ??
        raw.unGamePlayedAppID ??
        raw.game_info?.gameid ??
        persona?.gameid ??
        persona?.gameId ??
        persona?.m_gameid ??
        persona?.game_playing_appid ??
        persona?.m_unGamePlayedAppID ??
        persona?.m_gamePlayedAppId ??
        persona?.unGamePlayedAppID ??
        callMaybe(raw, "gameid") ??
        callMaybe(raw, "gameId") ??
        callMaybe(raw, "BIsInGame") ??
        callMaybe(raw, "IsInGame") ??
        callMaybe(persona, "gameid") ??
        callMaybe(persona, "gameId") ??
        callMaybe(persona, "BIsInGame") ??
        callMaybe(persona, "IsInGame") ??
        raw.BIsInGame?.() ??
        raw.IsInGame?.() ??
        persona?.BIsInGame?.() ??
        persona?.IsInGame?.() ??
        raw.m_gameInfo?.gameid ??
        raw.m_gameInfo?.m_unAppID
    );
    const idleSignal =
      raw.bIsAway ??
      raw.m_bIsAway ??
      raw.bIsIdle ??
      raw.m_bIsIdle ??
      raw.bAway ??
      raw.bIdle ??
      raw.idle ??
      raw.is_away ??
      raw.away ??
      persona?.bIsAway ??
      persona?.m_bIsAway ??
      persona?.bIsIdle ??
      persona?.m_bIsIdle ??
      persona?.bAway ??
      persona?.bIdle ??
      persona?.idle ??
      persona?.is_away ??
      persona?.away ??
      callMaybe(raw, "BIsAway") ??
      callMaybe(raw, "IsAway") ??
      callMaybe(raw, "BIsSnooze") ??
      callMaybe(raw, "IsSnooze") ??
      callMaybe(raw, "BIsIdle") ??
      callMaybe(raw, "IsIdle") ??
      callMaybe(persona, "BIsAway") ??
      callMaybe(persona, "IsAway") ??
      callMaybe(persona, "BIsSnooze") ??
      callMaybe(persona, "IsSnooze") ??
      callMaybe(persona, "BIsIdle") ??
      callMaybe(persona, "IsIdle");
    const idle =
      personaState === 3 ||
      personaState === 4 ||
      stateText.includes("away") ||
      stateText.includes("snooze") ||
      stateText.includes("idle") ||
      Boolean(idleSignal);
    const onlineSignal =
      raw.bOnline ??
      raw.m_bOnline ??
      raw.is_online ??
      raw.online ??
      persona?.bOnline ??
      persona?.m_bOnline ??
      persona?.is_online ??
      persona?.online ??
      callMaybe(raw, "BIsOnline") ??
      callMaybe(raw, "IsOnline") ??
      callMaybe(persona, "BIsOnline") ??
      callMaybe(persona, "IsOnline");
    const online =
      inGame ||
      idle ||
      personaState > 0 ||
      stateText.includes("online") ||
      stateText.includes("away") ||
      stateText.includes("snooze") ||
      stateText.includes("busy") ||
      stateText.includes("looking to play") ||
      stateText.includes("looking to trade") ||
      Boolean(onlineSignal);
    if (!online) {
      return null;
    }

    const avatarUrl = this.normalizeAvatarUrl(
      raw.avatarmedium ??
        raw.avatarfull ??
        raw.avatar ??
        raw.m_strAvatarURL ??
        raw.strAvatarURL ??
        persona?.avatarmedium ??
        persona?.avatarfull ??
        persona?.avatar ??
        persona?.m_strAvatarURL ??
        persona?.strAvatarURL ??
        raw.avatar_url,
      raw.avatarhash ??
        raw.m_strAvatarHash ??
        raw.strAvatarHash ??
        persona?.avatarhash ??
        persona?.m_strAvatarHash ??
        persona?.strAvatarHash
    );

    const gameName = (
      raw.gameextrainfo ??
      raw.m_strGameExtraInfo ??
      raw.strGameExtraInfo ??
      raw.m_strGameName ??
      raw.strGameName ??
      persona?.gameextrainfo ??
      persona?.m_strGameExtraInfo ??
      persona?.strGameExtraInfo ??
      persona?.m_strGameName ??
      persona?.strGameName ??
      raw.m_gameInfo?.name
    )
      ?.toString()
      .trim();

    return {
      steamId,
      personaName: personaName || "Friend",
      avatarUrl,
      inGame,
      idle,
      gameName: gameName || undefined,
    };
  }

  private normalizeSteamId(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value);
    const digits = text.match(/\d+/)?.[0];
    if (!digits) {
      return null;
    }

    if (digits.length === 17) {
      return digits;
    }

    if (digits.length <= 10) {
      try {
        const accountId = BigInt(digits);
        if (accountId > 0n) {
          return (STEAM_ID64_BASE + accountId).toString();
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  private normalizeAvatarUrl(url: unknown, hash: unknown): string {
    if (typeof url === "string" && url.trim().length > 0) {
      if (url.startsWith("//")) {
        return `https:${url}`;
      }
      return url;
    }
    if (typeof hash === "string") {
      const cleaned = hash.trim().toLowerCase();
      if (cleaned.length >= 20 && !/^0+$/.test(cleaned)) {
        return `https://avatars.cloudflare.steamstatic.com/${cleaned}_medium.jpg`;
      }
    }
    return DEFAULT_AVATAR;
  }

  private preferPresence(
    existing: FriendPresence,
    incoming: FriendPresence
  ): FriendPresence {
    if (incoming.inGame !== existing.inGame) {
      return incoming.inGame ? incoming : existing;
    }
    if (incoming.idle !== existing.idle) {
      // If any source reports away/idle, keep that so dotted state is visible.
      return incoming.idle ? incoming : existing;
    }
    const existingScore = this.presenceQualityScore(existing);
    const incomingScore = this.presenceQualityScore(incoming);
    if (incomingScore > existingScore) {
      return incoming;
    }
    return existing;
  }

  private presenceQualityScore(friend: FriendPresence): number {
    let score = 0;
    if (friend.inGame) {
      score += 4;
    }
    if (friend.avatarUrl !== DEFAULT_AVATAR) {
      score += 1;
    }
    if (friend.gameName) {
      score += 1;
    }
    return score;
  }

  private async fetchWebApiKeyOnlineFriends(steamId: string): Promise<FriendPresence[]> {
    const apiKey = this.getWebApiKey();
    if (!apiKey) {
      return [];
    }

    const friendListUrls = [
      `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamId}&relationship=friend`,
      `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${encodeURIComponent(apiKey)}&steamid=${steamId}&relationship=friend`,
    ];

    let friendPayload: Record<string, unknown> | null = null;
    for (const url of friendListUrls) {
      friendPayload = await this.fetchJson(url);
      if (friendPayload) {
        break;
      }
    }

    const friendIds = Array.from(
      new Set(
        this.parseFriendLinks(friendPayload)
          .map((entry) => entry.steamid?.trim())
          .filter((entry): entry is string => Boolean(entry))
      )
    );
    if (!friendIds.length) {
      return [];
    }

    const players: RawFriendSummary[] = [];
    for (let index = 0; index < friendIds.length; index += 100) {
      const chunk = friendIds.slice(index, index + 100);
      const ids = encodeURIComponent(chunk.join(","));
      const summaryUrls = [
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${ids}`,
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(apiKey)}&steamids=${ids}`,
      ];

      let payload: Record<string, unknown> | null = null;
      for (const url of summaryUrls) {
        payload = await this.fetchJson(url);
        if (payload) {
          break;
        }
      }
      players.push(...this.parseFriendSummaries(payload));
    }

    const online: FriendPresence[] = players
      .map((player) => {
        const normalizedSteamId = this.normalizeSteamId(player.steamid);
        if (!normalizedSteamId) {
          return null;
        }
        const personastate = player.personastate ?? 0;
        if (personastate <= 0) {
          return null;
        }
        return {
          steamId: normalizedSteamId,
          personaName: player.personaname?.trim() || "Friend",
          avatarUrl: this.normalizeAvatarUrl(
            player.avatarmedium || player.avatarfull || player.avatar,
            undefined
          ),
          inGame: Boolean(player.gameid),
          idle: personastate === 3 || personastate === 4,
          gameName: player.gameextrainfo,
        } as FriendPresence;
      })
      .filter((entry): entry is FriendPresence => Boolean(entry));

    return this.sortFriends(online);
  }

  private async fetchOAuthOnlineFriends(steamId: string): Promise<FriendPresence[]> {
    const oauthToken = this.resolveOAuthToken();
    const friendIds = await this.fetchOAuthFriendIds(steamId, oauthToken);
    if (!friendIds.length) {
      return [];
    }

    const players: RawFriendSummary[] = [];
    for (let index = 0; index < friendIds.length; index += 100) {
      const chunk = friendIds.slice(index, index + 100);
      const ids = encodeURIComponent(chunk.join(","));
      const summaryUrls = [
        `https://api.steampowered.com/ISteamUserOAuth/GetUserSummaries/v1/?steamids=${ids}`,
        `https://api.steampowered.com/ISteamUserOAuth/GetUserSummaries/v0002/?steamids=${ids}`,
      ];
      if (oauthToken) {
        summaryUrls.unshift(
          `https://api.steampowered.com/ISteamUserOAuth/GetUserSummaries/v1/?steamids=${ids}&access_token=${encodeURIComponent(oauthToken)}`,
          `https://api.steampowered.com/ISteamUserOAuth/GetUserSummaries/v0002/?steamids=${ids}&access_token=${encodeURIComponent(oauthToken)}`
        );
      }

      let payload: Record<string, unknown> | null = null;
      for (const url of summaryUrls) {
        payload = await this.fetchJson(url);
        if (payload) {
          break;
        }
      }

      const batch = this.parseFriendSummaries(payload);
      players.push(...batch);
    }

    const online: FriendPresence[] = players
      .filter((player) => (player.personastate ?? 0) > 0 && player.steamid)
      .map((player) => {
        const personastate = player.personastate ?? 0;
        return {
          steamId: player.steamid as string,
          personaName: player.personaname?.trim() || "Friend",
          avatarUrl:
            player.avatarmedium || player.avatarfull || player.avatar || DEFAULT_AVATAR,
          inGame: Boolean(player.gameid),
          idle: personastate === 3 || personastate === 4,
          gameName: player.gameextrainfo,
        };
      });

    return this.sortFriends(online);
  }

  private async fetchOAuthFriendIds(
    steamId: string,
    oauthToken: string | null
  ): Promise<string[]> {
    const urls = [
      `https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v1/?steamid=${steamId}&relationship=friend`,
      `https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v0001/?steamid=${steamId}&relationship=friend`,
    ];
    if (oauthToken) {
      urls.unshift(
        `https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v1/?steamid=${steamId}&relationship=friend&access_token=${encodeURIComponent(oauthToken)}`,
        `https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v0001/?steamid=${steamId}&relationship=friend&access_token=${encodeURIComponent(oauthToken)}`,
        `https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v1/?relationship=friend&access_token=${encodeURIComponent(oauthToken)}`,
        `https://api.steampowered.com/ISteamUserOAuth/GetFriendList/v0001/?relationship=friend&access_token=${encodeURIComponent(oauthToken)}`
      );
    }

    let payload: Record<string, unknown> | null = null;
    for (const url of urls) {
      payload = await this.fetchJson(url);
      if (payload) {
        break;
      }
    }

    const links = this.parseFriendLinks(payload);
    return Array.from(
      new Set(
        links
          .map((entry) => entry.steamid?.trim())
          .filter((entry): entry is string => Boolean(entry))
      )
    );
  }

  private resolveOAuthToken(): string | null {
    const cookieString = [
      this.getTargetDocument().cookie,
      document.cookie,
    ]
      .filter(Boolean)
      .join(";");
    const loginCookie = cookieString
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("steamLoginSecure="));
    if (!loginCookie) {
      return null;
    }

    const raw = loginCookie.split("=")[1] ?? "";
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }

    const token = decoded.split("||")[1]?.trim();
    if (!token) {
      return null;
    }
    return token;
  }

  private parseFriendLinks(payload: unknown): RawFriendLink[] {
    const record = payload as Record<string, any> | null;
    if (!record) {
      return [];
    }
    if (Array.isArray(record.friendslist?.friends)) {
      return record.friendslist.friends;
    }
    if (Array.isArray(record.response?.friends)) {
      return record.response.friends;
    }
    if (Array.isArray(record.friends)) {
      return record.friends;
    }
    return [];
  }

  private parseFriendSummaries(payload: unknown): RawFriendSummary[] {
    const record = payload as Record<string, any> | null;
    if (!record) {
      return [];
    }
    if (Array.isArray(record.response?.players)) {
      return record.response.players;
    }
    if (Array.isArray(record.players)) {
      return record.players;
    }
    return [];
  }

  private async fetchPlayerListOnlineFriends(): Promise<FriendPresence[]> {
    const payloads: string[] = [];
    const addPayload = (value: string | null) => {
      if (!value) {
        return;
      }
      if (value.length < 120) {
        return;
      }
      payloads.push(value);
    };

    addPayload(
      await this.fetchText("https://steamcommunity.com/actions/PlayerList/?type=friends")
    );
    addPayload(
      await this.fetchText("https://steamcommunity.com/actions/PlayerList/?type=online")
    );
    addPayload(
      await this.fetchText("https://steamcommunity.com/actions/PlayerList/?type=friendsonline")
    );
    for (const pageHtml of await this.fetchProfileFriendsHtmlPages()) {
      addPayload(pageHtml);
    }
    addPayload(await this.fetchText("https://steamcommunity.com/my/friends/"));

    if (!payloads.length) {
      return [];
    }

    const byId = new Map<string, FriendPresence>();
    for (const html of payloads) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const entries = Array.from(
        doc.querySelectorAll(".friend_block_v2, .friend_block")
      );
      for (const entry of entries) {
        if (!(entry instanceof HTMLElement)) {
          continue;
        }

        const steamId = this.readSteamId(entry);
        if (!steamId) {
          continue;
        }

        const classTokens = new Set<string>();
        const collectClassTokens = (value: string | null | undefined) => {
          if (!value) {
            return;
          }
          for (const token of value.toLowerCase().split(/\s+/g)) {
            const normalized = token.trim();
            if (normalized) {
              classTokens.add(normalized);
            }
          }
        };
        collectClassTokens(entry.className);
        for (const node of Array.from(entry.querySelectorAll("[class]"))) {
          if (node instanceof HTMLElement) {
            collectClassTokens(node.className);
          }
        }

        const personaStateNode = entry.querySelector(
          "[data-personastate], [data-persona-state]"
        ) as HTMLElement | null;
        const personaStateRaw =
          entry.getAttribute("data-personastate") ??
          entry.getAttribute("data-persona-state") ??
          personaStateNode?.getAttribute("data-personastate") ??
          personaStateNode?.getAttribute("data-persona-state");
        const personaState =
          personaStateRaw !== null ? Number(personaStateRaw) : Number.NaN;
        const hasPersonaState = Number.isFinite(personaState);

        const statusText = (
          entry.querySelector(".friend_block_content")?.textContent ??
          entry.querySelector(".friend_block_status")?.textContent ??
          entry.textContent ??
          ""
        )
          .toLowerCase()
          .replace(/\s+/g, " ");

        const inGame =
          classTokens.has("ingame") ||
          classTokens.has("in-game") ||
          classTokens.has("friendstatus_ingame") ||
          classTokens.has("friendstatus_in-game") ||
          statusText.includes("in-game") ||
          statusText.includes("currently playing") ||
          statusText.includes("playing");
        const idle =
          (hasPersonaState && (personaState === 3 || personaState === 4)) ||
          classTokens.has("away") ||
          classTokens.has("snooze") ||
          classTokens.has("idle") ||
          classTokens.has("friendstatus_away") ||
          classTokens.has("friendstatus_snooze") ||
          classTokens.has("friendstatus_idle") ||
          statusText.includes(" away") ||
          statusText.includes("snooze") ||
          statusText.includes("idle");
        const onlineSignals =
          inGame ||
          idle ||
          (hasPersonaState && personaState > 0) ||
          classTokens.has("online") ||
          classTokens.has("busy") ||
          classTokens.has("friendstatus_online") ||
          classTokens.has("friendstatus_busy") ||
          classTokens.has("friendstatus_lookingtoplay") ||
          classTokens.has("friendstatus_lookingtotrade") ||
          classTokens.has("persona_state_online") ||
          classTokens.has("persona_state_busy") ||
          classTokens.has("persona_state_lookingtoplay") ||
          classTokens.has("persona_state_lookingtotrade");
        const onlineText =
          statusText.includes("currently online") ||
          statusText.includes("online") ||
          statusText.includes("busy") ||
          statusText.includes("looking to play") ||
          statusText.includes("looking to trade");
        const online =
          onlineSignals || onlineText;
        const offline =
          (hasPersonaState && personaState === 0) ||
          classTokens.has("offline") ||
          classTokens.has("friendstatus_offline") ||
          classTokens.has("persona_state_offline") ||
          statusText.includes("offline");
        if (!online || (offline && !onlineSignals)) {
          continue;
        }

        const avatar = entry.querySelector("img") as HTMLImageElement | null;
        const rawName =
          entry.querySelector(".friend_block_content")?.textContent ??
          entry.querySelector(".friend_block_name")?.textContent ??
          entry.querySelector(".persona")?.textContent ??
          "";
        const personaName = rawName.trim().split("\n")[0].trim() || "Friend";

        const parsed: FriendPresence = {
          steamId,
          personaName,
          avatarUrl: avatar?.src || DEFAULT_AVATAR,
          inGame,
          idle,
        };

        const existing = byId.get(steamId);
        if (!existing) {
          byId.set(steamId, parsed);
        } else {
          byId.set(steamId, this.preferPresence(existing, parsed));
        }
      }
    }

    return this.sortFriends(Array.from(byId.values()));
  }

  private async fetchProfileFriendsHtmlPages(): Promise<string[]> {
    const steamId = this.resolveCurrentSteamId();
    if (!steamId) {
      return [];
    }

    const pages: string[] = [];
    const maxPages = 8;
    for (let page = 1; page <= maxPages; page += 1) {
      const candidates = [
        `https://steamcommunity.com/profiles/${steamId}/friends/?online=1&p=${page}&l=english`,
        `https://steamcommunity.com/profiles/${steamId}/friends/?p=${page}&l=english`,
        `https://steamcommunity.com/profiles/${steamId}/friends/?ajax=1&online=1&p=${page}&l=english`,
      ];
      let foundPage = false;
      for (const url of candidates) {
        const html = await this.fetchText(url);
        if (!html || html.length < 120) {
          continue;
        }
        const looksLikeFriends = /friend_block_v2|friend_block/i.test(html);
        if (!looksLikeFriends) {
          continue;
        }
        pages.push(html);
        foundPage = true;
        break;
      }
      if (!foundPage) {
        if (page > 1) {
          break;
        }
      }
    }
    return pages;
  }

  private readSteamId(entry: HTMLElement): string | null {
    const candidates = [
      entry.getAttribute("data-steamid"),
      entry.getAttribute("data-miniprofile"),
      entry.getAttribute("data-accountid"),
      entry.id,
    ];

    const nestedIdNode = entry.querySelector(
      "[data-steamid], [data-miniprofile], [data-accountid]"
    ) as HTMLElement | null;
    if (nestedIdNode) {
      candidates.push(
        nestedIdNode.getAttribute("data-steamid"),
        nestedIdNode.getAttribute("data-miniprofile"),
        nestedIdNode.getAttribute("data-accountid")
      );
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const normalized = this.normalizeSteamId(candidate);
      if (normalized) {
        return normalized;
      }
    }
    const links = Array.from(
      entry.querySelectorAll("a[href]")
    ) as HTMLAnchorElement[];
    for (const link of links) {
      if (!link.href) {
        continue;
      }
      const profileMatch = link.href.match(/profiles\/(\d{17})/);
      if (profileMatch?.[1]) {
        return profileMatch[1];
      }
      const miniProfileMatch = link.href.match(/miniprofile\/(\d+)/);
      if (miniProfileMatch?.[1]) {
        const normalized = this.normalizeSteamId(miniProfileMatch[1]);
        if (normalized) {
          return normalized;
        }
      }
    }
    return null;
  }

  private sortFriends(friends: FriendPresence[]): FriendPresence[] {
    return [...friends].sort((left, right) => {
      const leftRank = this.statusRank(left);
      const rightRank = this.statusRank(right);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.personaName.localeCompare(right.personaName, undefined, {
        sensitivity: "base",
      });
    });
  }

  private statusRank(friend: FriendPresence): number {
    if (friend.inGame && !friend.idle) {
      return 0;
    }
    if (friend.inGame && friend.idle) {
      return 1;
    }
    if (!friend.inGame && !friend.idle) {
      return 2;
    }
    return 3;
  }

  private async fetchJson(url: string): Promise<Record<string, unknown> | null> {
    const raw = await this.fetchText(this.withCacheBust(url));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async fetchText(url: string): Promise<string | null> {
    const fetchers: FetchTextFn[] = [
      async (target: string) => {
        const response = await fetch(target, {
          method: "GET",
          cache: "no-store",
          credentials: "include",
          headers: {
            Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
          },
        });
        if (!response.ok) {
          return null;
        }
        return response.text();
      },
      async (target: string) => {
        const response = await fetchNoCors(target, {
          method: "GET",
          cache: "no-store",
          credentials: "include",
          headers: {
            Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
          },
        });
        if (!response.ok) {
          return null;
        }
        return response.text();
      },
    ];

    for (const fetcher of fetchers) {
      try {
        const body = await fetcher(url);
        if (body) {
          return body;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private withCacheBust(url: string): string {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}_friendsbar_ts=${Date.now()}`;
  }
}

const runtime = new FriendsBarRuntime();

const FriendsBarGlobalMount = () => {
  useEffect(() => {
    runtime.setPreferredDocument(document);
    return () => {
      runtime.setPreferredDocument(null);
    };
  }, []);
  return null;
};

const useFriendsBarState = (): RuntimeState => {
  const [state, setState] = useState(runtime.getState());
  useEffect(() => runtime.subscribe(setState), []);
  return state;
};

const formatTimestamp = (value: string | null): string => {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Never";
  }
  return date.toLocaleTimeString();
};

const summarizeApiKey = (key: string): string => {
  const trimmed = key.trim();
  if (!trimmed) {
    return "No key saved";
  }
  if (trimmed.length <= 4) {
    return `Saved (${trimmed.length} chars)`;
  }
  return `Saved (${trimmed.length} chars, ends with ${trimmed.slice(-4)})`;
};

const FriendsBarPanel = () => {
  const state = useFriendsBarState();
  const [savedApiKey, setSavedApiKey] = useState(runtime.getConfiguredWebApiKey());
  const [xOffset, setXOffset] = useState(runtime.getXOffset());
  const [yOffset, setYOffset] = useState(runtime.getYOffset());
  const [enabled, setEnabled] = useState(runtime.getEnabled());
  const [hideInStore, setHideInStore] = useState(runtime.getHideInStore());
  const [hideOnGamePage, setHideOnGamePage] = useState(runtime.getHideOnGamePage());
  const [tapTogglesCountMode, setTapTogglesCountMode] = useState(
    runtime.getTapAction() === "toggle-count"
  );

  useEffect(() => {
    const current = runtime.getConfiguredWebApiKey();
    setSavedApiKey(current);
  }, [state.hasWebApiKey]);

  useEffect(() => {
    setXOffset(runtime.getXOffset());
    setYOffset(runtime.getYOffset());
    setEnabled(runtime.getEnabled());
    setHideInStore(runtime.getHideInStore());
    setHideOnGamePage(runtime.getHideOnGamePage());
    setTapTogglesCountMode(runtime.getTapAction() === "toggle-count");
  }, []);

  const openApiKeyEditor = () => {
    let modalHandle: { Close: () => void } | null = null;

    const close = () => {
      modalHandle?.Close();
    };

    const ApiKeyModal = () => {
      const [draft, setDraft] = useState(runtime.getConfiguredWebApiKey());
      return (
        <ModalRoot onCancel={close} closeModal={close}>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ wordBreak: "break-all", overflowWrap: "anywhere" }}>
              Get your key at: https://steamcommunity.com/dev/apikey
            </div>
            <TextField
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              focusOnMount
              style={{ width: "100%", minWidth: "24rem", fontSize: "16px" }}
            />
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                onClick={() => {
                  runtime.setWebApiKey(draft);
                  const current = runtime.getConfiguredWebApiKey();
                  setSavedApiKey(current);
                  close();
                }}
              >
                Save key
              </button>
              <button
                type="button"
                onClick={() => {
                  runtime.setWebApiKey("");
                  setSavedApiKey("");
                  close();
                }}
              >
                Clear key
              </button>
              <button type="button" onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        </ModalRoot>
      );
    };

    modalHandle = showModal(<ApiKeyModal />, window, {
      strTitle: "FriendsBar API Key",
      popupWidth: 900,
      popupHeight: 420,
    });
  };

  return (
    <PanelSection title="FriendsBar Status">
      <PanelSectionRow>
        <div>
          Top bar mounted: {state.mounted ? "Yes" : "No"} ({state.mountMode})
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>
          Online friends: {state.onlineCount} (showing {state.displayedCount})
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>Friend source: {state.source}</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>Web API key active: {state.hasWebApiKey ? "Yes" : "No"}</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>Saved key: {summarizeApiKey(savedApiKey)}</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>Type your Steam Web API key here:</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ wordBreak: "break-all", overflowWrap: "anywhere" }}>
          Get it at: https://steamcommunity.com/dev/apikey
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>
          If prompted for a domain, use `localhost` or your own domain.
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ display: "flex", gap: "8px", width: "100%" }}>
          <button type="button" onClick={openApiKeyEditor}>
            Edit API key
          </button>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Show FriendsBar globally"
          checked={enabled}
          onChange={(value) => {
            setEnabled(value);
            runtime.setEnabled(value);
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Hide while in Steam Store"
          checked={hideInStore}
          onChange={(value) => {
            setHideInStore(value);
            runtime.setHideInStore(value);
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Hide while on game page"
          checked={hideOnGamePage}
          onChange={(value) => {
            setHideOnGamePage(value);
            runtime.setHideOnGamePage(value);
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <ToggleField
          label="Tap toggles between online friend icons or online friend count"
          checked={tapTogglesCountMode}
          description={
            tapTogglesCountMode
              ? "Tap toggles between online friend count and full friend icons."
              : "Tap jumps to friend messaging."
          }
          onChange={(value) => {
            setTapTogglesCountMode(value);
            runtime.setTapAction(value ? "toggle-count" : "chat");
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField
          label="X offset"
          min={X_OFFSET_MIN_PX}
          max={X_OFFSET_MAX_PX}
          step={1}
          value={xOffset}
          valueSuffix="px"
          showValue
          onChange={(value) => {
            setXOffset(value);
            runtime.setXOffset(value);
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ display: "flex", gap: "8px", width: "100%" }}>
          <button
            type="button"
            onClick={() => {
              const reset = 0;
              setXOffset(reset);
              runtime.setXOffset(reset);
            }}
          >
            Reset X offset
          </button>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <SliderField
          label="Y offset"
          min={Y_OFFSET_MIN_PX}
          max={Y_OFFSET_MAX_PX}
          step={1}
          value={yOffset}
          valueSuffix="px"
          showValue
          onChange={(value) => {
            setYOffset(value);
            runtime.setYOffset(value);
          }}
        />
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ display: "flex", gap: "8px", width: "100%" }}>
          <button
            type="button"
            onClick={() => {
              const reset = 0;
              setYOffset(reset);
              runtime.setYOffset(reset);
            }}
          >
            Reset Y offset
          </button>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ display: "flex", gap: "8px", width: "100%" }}>
          <button
            type="button"
            onClick={() => {
              runtime.forceRefresh();
            }}
          >
            Force update now
          </button>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>Last refresh: {formatTimestamp(state.lastUpdated)}</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>Hidden by settings: {state.hiddenBySettings ? "Yes" : "No"}</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ wordBreak: "break-all", overflowWrap: "anywhere" }}>
          Store probe: {state.storeDebug || "(none)"}
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ wordBreak: "break-all", overflowWrap: "anywhere" }}>
          Route candidates: {state.routeDebug || "(none)"}
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div>
          Status:{" "}
          {state.error
            ? `Error loading friends (${state.error})`
            : "FriendsBar is running"}
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
};

export default definePlugin(() => {
  runtime.start();
  routerHook.addGlobalComponent(GLOBAL_COMPONENT_NAME, FriendsBarGlobalMount);
  return {
    title: <div className={staticClasses.Title}>FriendsBar</div>,
    icon: <FaUserFriends />,
    content: <FriendsBarPanel />,
    onDismount() {
      routerHook.removeGlobalComponent(GLOBAL_COMPONENT_NAME);
      runtime.stop();
    },
  };
});
