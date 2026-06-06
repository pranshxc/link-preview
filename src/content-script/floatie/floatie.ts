import floatieCssTxt from "./floatie.txt.css";
import { Logger } from "../../utils/logger";
import Storage from "../../utils/storage";
import manifest from "../../manifest.json";
import { arrow, computePosition, flip, offset, shift } from "@floating-ui/dom";

export class Floatie {
  container: HTMLElement;
  copyButton: HTMLElement;
  searchButton: HTMLElement;
  previewButton: HTMLElement;
  tooltipArrow: HTMLElement;
  shadowHost: HTMLElement | null = null;
  shadowRoot: ShadowRoot | null = null;
  isCopyActionEnabled = false;
  showTimeout?: number;
  logger = new Logger(this);
  private wiredAnchors = new WeakSet<HTMLAnchorElement>();
  private domObserver: MutationObserver | null = null;
  private hideTimer: any = null;

  // ── Alt/Option instant-preview state ──────────────────────────────────
  private altKeyHeld = false;
  private altBadge: HTMLElement | null = null;
  private altMoveHandler: ((e: MouseEvent) => void) | null = null;
  // ──────────────────────────────────────────────────────────────────────

  constructor() {
    const markup = `
      <div id="sp-floatie-container">
        <div id="sp-floatie-arrow"></div>
        <div id="sp-floatie-search"  class="sp-floatie-action" data-action="search">Search</div>
        <div id="sp-floatie-preview" class="sp-floatie-action" data-action="preview">Preview</div>
        <div id="sp-floatie-copy"    class="sp-floatie-action" data-action="copy">Copy</div>
      </div>`;

    const tmp = document.createElement("div");
    tmp.innerHTML = markup;

    const container     = tmp.querySelector<HTMLElement>("#sp-floatie-container")!;
    const searchButton  = tmp.querySelector<HTMLElement>("#sp-floatie-search")!;
    const previewButton = tmp.querySelector<HTMLElement>("#sp-floatie-preview")!;
    const copyButton    = tmp.querySelector<HTMLElement>("#sp-floatie-copy")!;
    const tooltipArrow  = tmp.querySelector<HTMLElement>("#sp-floatie-arrow")!;

    if (!container || !searchButton || !previewButton || !copyButton || !tooltipArrow) {
      throw new Error("Impossible error obtaining action buttons from DOM");
    }

    this.container     = container;
    this.searchButton  = searchButton;
    this.previewButton = previewButton;
    this.copyButton    = copyButton;
    this.tooltipArrow  = tooltipArrow;
    this.logger.debug("Initialized floatie");
  }

  startListening(): void {
    if (this.inIframe()) return;

    // Shadow host lives in light DOM — this is what we position via fixed coords.
    const bft = document.createElement("better-previews-tooltip");
    bft.style.cssText = [
      "all: initial",
      "position: fixed",
      "top: 0",
      "left: 0",
      "z-index: 2147483647",
      "pointer-events: none",
      "display: block",
    ].join(";");
    document.body.appendChild(bft);

    const shadow = bft.attachShadow({ mode: "open" });
    const style  = document.createElement("style");
    style.textContent = floatieCssTxt;
    shadow.appendChild(style);
    shadow.appendChild(this.container);

    this.container.style.pointerEvents = "auto";
    this.container.style.display       = "none";

    this.container.addEventListener("mouseenter", () => {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    });
    this.container.addEventListener("mouseleave", () => { this.scheduleHide(300); });

    this.shadowHost = bft;
    this.shadowRoot = shadow;

    // ── Create the Alt-mode badge (separate fixed element, no shadow DOM) ─
    const badge = document.createElement("div");
    badge.id = "sp-alt-badge";
    badge.textContent = "⌥ Alt · instant preview";
    badge.style.cssText = [
      "all: initial",
      "position: fixed",
      "z-index: 2147483646",
      "background: #1a1a2e",
      "color: #a78bfa",
      "font: 600 11px/1 sans-serif",
      "padding: 4px 8px",
      "border-radius: 4px",
      "border: 1px solid #6d28d9",
      "pointer-events: none",
      "display: none",
      "white-space: nowrap",
      "letter-spacing: 0.02em",
    ].join(";");
    document.body.appendChild(badge);
    this.altBadge = badge;
    // ──────────────────────────────────────────────────────────────────────

    window.onscroll      = () => this.hideAll();
    window.onresize      = () => this.hideAll();
    window.oncontextmenu = () => this.hideAll();
    document.onmouseup   = (e) => this.deferredMaybeShow(e);

    // keydown: use addEventListener (not onkeydown) so we don't clash with
    // the text-selection hideAll that was previously on onkeydown.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Alt" || e.key === "Option") {
        e.preventDefault(); // stop browser menu-bar focus on Alt
        this.enterAltMode();
      } else {
        // Any non-Alt key dismisses floatie (original behaviour).
        this.hideAll();
      }
    });

    window.addEventListener("keyup", (e) => {
      if (e.key === "Alt" || e.key === "Option") {
        this.exitAltMode();
      }
    });

    // If window loses focus while Alt is held (e.g. user Cmd+Tabs), exit alt mode.
    window.addEventListener("blur", () => this.exitAltMode());

    this.setupLinkPreviews();
  }

  // ── Alt-mode helpers ────────────────────────────────────────────────────

  private enterAltMode(): void {
    if (this.altKeyHeld) return;
    this.altKeyHeld = true;
    this.hideAll();

    if (this.altBadge) this.altBadge.style.display = "block";

    // Follow cursor so the badge stays near the mouse.
    this.altMoveHandler = (e: MouseEvent) => {
      if (!this.altBadge) return;
      const x = Math.min(e.clientX + 14, window.innerWidth  - 160);
      const y = Math.max(e.clientY - 28, 4);
      this.altBadge.style.left = x + "px";
      this.altBadge.style.top  = y + "px";
    };
    document.addEventListener("mousemove", this.altMoveHandler);
  }

  private exitAltMode(): void {
    if (!this.altKeyHeld) return;
    this.altKeyHeld = false;
    if (this.altBadge) this.altBadge.style.display = "none";
    if (this.altMoveHandler) {
      document.removeEventListener("mousemove", this.altMoveHandler);
      this.altMoveHandler = null;
    }
  }

  // ── Shadow-host coordinate positioning ─────────────────────────────────

  showAtRect(rect: DOMRect): void {
    if (!this.shadowHost) return;

    const ARROW_SIZE = 8;
    const GAP        = 6;
    const containerW = this.container.offsetWidth  || 80;
    const containerH = this.container.offsetHeight || 30;
    const vpW        = window.innerWidth;

    let top: number;
    if (rect.top - containerH - ARROW_SIZE - GAP >= 0) {
      top = rect.top - containerH - ARROW_SIZE - GAP;
      this.tooltipArrow.style.bottom = "-4px";
      this.tooltipArrow.style.top    = "";
    } else {
      top = rect.bottom + ARROW_SIZE + GAP;
      this.tooltipArrow.style.top    = "-4px";
      this.tooltipArrow.style.bottom = "";
    }

    let left = rect.left + rect.width / 2 - containerW / 2;
    left = Math.max(5, Math.min(left, vpW - containerW - 5));

    const arrowLeft = (rect.left + rect.width / 2) - left - ARROW_SIZE / 2;
    this.tooltipArrow.style.left = Math.max(4, Math.min(arrowLeft, containerW - ARROW_SIZE - 4)) + "px";

    Object.assign(this.shadowHost.style, { top: top + "px", left: left + "px" });
  }

  // ── Per-anchor event wiring ─────────────────────────────────────────────

  attachLinkPreview(a: HTMLAnchorElement): void {
    if (this.wiredAnchors.has(a)) return;
    if (!this.isGoodUrl(a.href)) return;

    const hasText        = !!(a.innerText?.trim() || a.textContent?.trim());
    const isPureImgLink  = !hasText && !!a.querySelector("img, svg");
    if (isPureImgLink) return;

    this.wiredAnchors.add(a);

    let showTimeout: any     = null;
    let autoPreviewTimeout: any = null;

    a.addEventListener("mouseover", (e: MouseEvent) => {
      // ── ALT MODE: instant preview, no floatie ──
      if (this.altKeyHeld) {
        this.sendMessage("preview", a.href);
        return;
      }

      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }

      showTimeout = setTimeout(async () => {
        const previewOnHover = (await Storage.get("preview-on-hover")) ?? false;
        this.showLinkActions(a, [this.previewButton]);

        if (previewOnHover) {
          const delaySec = (await Storage.get("preview-on-hover-delay")) ?? 3;
          this.container.classList.add("hide-" + delaySec);
          autoPreviewTimeout = setTimeout(() => {
            this.container.className = "";
            this.hideAll();
            this.sendMessage("preview", a.href);
          }, delaySec * 1000);
        }
      }, 500);
    });

    a.addEventListener("mouseout", (e: MouseEvent) => {
      const rel = e.relatedTarget as Node | null;
      if (rel && this.shadowHost && this.shadowHost.contains(rel)) return;

      if (showTimeout)        { clearTimeout(showTimeout); showTimeout = null; }
      if (autoPreviewTimeout) {
        clearTimeout(autoPreviewTimeout);
        this.container.className = "";
        autoPreviewTimeout = null;
      }
      this.scheduleHide(800);
    });
  }

  showLinkActions(a: HTMLAnchorElement, buttons: HTMLElement[]): void {
    this.hideAll();
    if (!buttons.length) return;

    buttons.forEach((b) => {
      b.style.display = "inline-block";
      b.onclick = () => {
        this.sendMessage(b.getAttribute("data-action") || "preview", a.href);
        this.hideAll();
      };
    });

    this.container.style.display = "block";
    requestAnimationFrame(() => { this.showAtRect(a.getBoundingClientRect()); });
  }

  setupLinkPreviews(): void {
    document.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => this.attachLinkPreview(a));

    this.domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as Element;
          if (el.tagName === "A") this.attachLinkPreview(el as HTMLAnchorElement);
          el.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => this.attachLinkPreview(a));
        });
      }
    });

    this.domObserver.observe(document.body, { childList: true, subtree: true });
  }

  scheduleHide(ms: number): void {
    this.hideTimer = setTimeout(() => this.hideAll(), ms);
  }

  stopListening(): void {
    this.domObserver?.disconnect();
    this.domObserver = null;
    this.exitAltMode();
    if (this.altBadge && document.body.contains(this.altBadge)) {
      document.body.removeChild(this.altBadge);
    }
    if (this.shadowHost && document.body.contains(this.shadowHost)) {
      document.body.removeChild(this.shadowHost);
    }
    document.onmouseup  = null;
    window.onscroll     = null;
    window.onresize     = null;
    window.oncontextmenu= null;
  }

  // ── Text-selection floatie ──────────────────────────────────────────────

  deferredMaybeShow(e: MouseEvent): void {
    this.showTimeout = window.setTimeout(() => this.maybeShow(e), 100);
  }

  maybeShow(e: MouseEvent): void {
    this.hideAll();
    if (typeof window.getSelection === "undefined") return;
    const selection = window.getSelection()!;
    if (selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    const range        = selection.getRangeAt(0);
    const boundingRect = range.getBoundingClientRect();

    const actionsToShow: HTMLElement[] = [];
    if (this.shouldShowPreview(e, selectedText))     actionsToShow.push(this.previewButton);
    else if (this.shouldShowSearch(e, selectedText)) actionsToShow.push(this.searchButton);
    if (this.shouldShowCopy(selectedText))           actionsToShow.push(this.copyButton);

    this.showActions(boundingRect, e, selectedText, actionsToShow);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  getAbsoluteUrl(urlStr: string): URL | null {
    try { if (/^(?:[a-z+]+:)?\//i.test(urlStr)) return new URL(urlStr); } catch {}
    return null;
  }

  isGoodUrl(urlStr: string): boolean {
    if (!urlStr?.trim()) return false;
    const url = this.getAbsoluteUrl(urlStr);
    if (!url) return false;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.hostname === window.location.hostname) return false;
    return true;
  }

  shouldShowCopy(selectedText: string): boolean {
    return this.isCopyActionEnabled && selectedText.length > 0;
  }

  shouldShowPreview(e: MouseEvent | KeyboardEvent, selectedText: string): boolean {
    const looksLikeUrl = (s: string) => {
      try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
    };
    const isGoodHyperlink = (ev: MouseEvent | KeyboardEvent) => {
      let t: any = ev.target;
      do { if (t.nodeName?.toUpperCase() === "A" && t.href) return true; } while ((t = t.parentElement));
      return false;
    };
    return looksLikeUrl(selectedText) || isGoodHyperlink(e);
  }

  getPreviewUrl(e: MouseEvent | KeyboardEvent, selectedText: string): string | undefined {
    try { const u = new URL(selectedText); if (u.protocol === "http:" || u.protocol === "https:") return u.href; } catch {}
    let t: any = e.target;
    do { if (t.nodeName?.toUpperCase() === "A" && t.href) return t.href as string; } while ((t = t.parentElement));
    return undefined;
  }

  shouldShowSearch(e: MouseEvent, selectedText: string): boolean {
    const isQuerySize = (s: string) => s.length > 0 && s.length < 100;
    const isEmail     = (s: string) => /^[^@]+@[^@]+\.[^@]+$/.test(s.toLowerCase());
    const isDate      = (s: string) => !isNaN(Date.parse(s));
    const hasLetters  = (s: string) => /[a-zA-Z]/.test(s);
    return isQuerySize(selectedText) && hasLetters(selectedText)
      && !isEmail(selectedText) && !isDate(selectedText)
      && !this.shouldShowPreview(e, selectedText);
  }

  showActions(boundingRect: DOMRect, e: MouseEvent, text: string, buttons: HTMLElement[]): void {
    this.hideAll();
    if (!buttons.length) return;

    this.container.style.display = "block";
    buttons.forEach((b) => {
      b.style.display = "inline-block";
      b.onclick = () => {
        let sendText = text;
        if (typeof window.getSelection !== "undefined") {
          const sel = window.getSelection()!;
          if (!sel.isCollapsed) sendText = sel.toString().trim();
          if (b.innerText === "Preview") {
            const href = this.getPreviewUrl(e, sendText);
            if (href) sendText = href;
          }
        }
        this.sendMessage(b.getAttribute("data-action") || "preview", sendText);
        this.hideAll();
      };
    });

    const virtualEl = { getBoundingClientRect: () => ({ ...boundingRect }) };

    if (this.shadowHost) { this.shadowHost.style.top = "0px"; this.shadowHost.style.left = "0px"; }

    computePosition(virtualEl, this.container, {
      placement: "top",
      strategy:  "fixed",
      middleware: [offset(12), flip(), shift({ padding: 5 }), arrow({ element: this.tooltipArrow })],
    }).then(({ x, y, placement, middlewareData }) => {
      if (this.shadowHost) { this.shadowHost.style.top = y + "px"; this.shadowHost.style.left = x + "px"; }
      const coords     = middlewareData.arrow;
      const staticSide = ({ top: "bottom", left: "right", bottom: "top", right: "left" } as any)[placement.split("-")[0]] ?? "bottom";
      Object.assign(this.tooltipArrow.style, {
        left: coords?.x != null ? coords.x + "px" : "",
        top:  coords?.y != null ? coords.y + "px" : "",
        right: "", bottom: "",
        [staticSide]: "-4px",
      });
      this.container.style.zIndex = "2147483647";
    });
  }

  sendMessage(action: string, data: any): void {
    window.postMessage(
      { application: manifest.__package_name__, action, data },
      window.location.origin,
    );
  }

  hideAll(): void {
    clearTimeout(this.showTimeout);
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.container.style.display    = "none";
    this.copyButton.style.display   = "none";
    this.searchButton.style.display = "none";
    this.previewButton.style.display= "none";
  }

  inIframe(): boolean {
    try { return window.self !== window.top; } catch { return true; }
  }
}
