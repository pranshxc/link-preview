import floatieCssTxt from "./floatie.txt.css";
import { Logger } from "../../utils/logger";
import Storage from "../../utils/storage";
import manifest from "../../manifest.json";
// NOTE: We no longer use @floating-ui/dom for the hover-link floatie because
// computePosition() cannot correctly measure elements inside a Shadow DOM.
// We use direct coordinate math instead (see showAtRect).
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
  // Track the current hide timer so mouseover-to-floatie doesn't dismiss it.
  private hideTimer: any = null;

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

    const container    = tmp.querySelector<HTMLElement>("#sp-floatie-container")!;
    const searchButton = tmp.querySelector<HTMLElement>("#sp-floatie-search")!;
    const previewButton= tmp.querySelector<HTMLElement>("#sp-floatie-preview")!;
    const copyButton   = tmp.querySelector<HTMLElement>("#sp-floatie-copy")!;
    const tooltipArrow = tmp.querySelector<HTMLElement>("#sp-floatie-arrow")!;

    if (!container || !searchButton || !previewButton || !copyButton || !tooltipArrow) {
      throw new Error("Impossible error obtaining action buttons from DOM");
    }

    this.container    = container;
    this.searchButton = searchButton;
    this.previewButton= previewButton;
    this.copyButton   = copyButton;
    this.tooltipArrow = tooltipArrow;
    this.logger.debug("Initialized floatie");
  }

  startListening(): void {
    if (this.inIframe()) return;

    // Create shadow host in light DOM — this is what we position.
    // The shadow root just isolates CSS; all positioning is done on the HOST.
    const bft = document.createElement("better-previews-tooltip");
    bft.style.cssText = [
      "all: initial",
      "position: fixed",
      "top: 0",
      "left: 0",
      "z-index: 2147483647",
      "pointer-events: none",   // host is transparent to clicks
      "display: block",
    ].join(";");
    document.body.appendChild(bft);

    const shadow = bft.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = floatieCssTxt;
    shadow.appendChild(style);
    shadow.appendChild(this.container);

    // Re-enable pointer events on the actual floatie UI inside the shadow.
    this.container.style.pointerEvents = "auto";
    // Keep container hidden by default; we'll show it via showAtRect.
    this.container.style.display = "none";

    // Keep container visible while mouse is over it.
    this.container.addEventListener("mouseenter", () => {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    });
    this.container.addEventListener("mouseleave", () => {
      this.scheduleHide(300);
    });

    this.shadowHost = bft;
    this.shadowRoot = shadow;

    window.onscroll       = () => this.hideAll();
    window.onresize       = () => this.hideAll();
    window.oncontextmenu  = () => this.hideAll();
    document.onmouseup    = (e) => this.deferredMaybeShow(e);
    document.onkeydown    = () => this.hideAll();

    this.setupLinkPreviews();
  }

  // -----------------------------------------------------------------------
  // Position the floatie above (or below) a bounding rect.
  // We move the SHADOW HOST to the right place in the light DOM, then the
  // container inside renders at the right spot. This sidesteps the
  // @floating-ui shadow-DOM measurement bug entirely.
  // -----------------------------------------------------------------------
  showAtRect(rect: DOMRect): void {
    if (!this.shadowHost) return;

    const ARROW_SIZE  = 8;
    const GAP         = 6;
    const containerW  = this.container.offsetWidth  || 80;
    const containerH  = this.container.offsetHeight || 30;

    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    // Try to place above the link; if not enough room, go below.
    let top: number;
    if (rect.top - containerH - ARROW_SIZE - GAP >= 0) {
      top = rect.top - containerH - ARROW_SIZE - GAP;
      this.tooltipArrow.style.bottom  = "-4px";
      this.tooltipArrow.style.top     = "";
    } else {
      top = rect.bottom + ARROW_SIZE + GAP;
      this.tooltipArrow.style.top     = "-4px";
      this.tooltipArrow.style.bottom  = "";
    }

    // Horizontally center over the link, clamped to viewport edges.
    let left = rect.left + rect.width / 2 - containerW / 2;
    left = Math.max(5, Math.min(left, vpW - containerW - 5));

    // Arrow horizontal center.
    const arrowLeft = (rect.left + rect.width / 2) - left - ARROW_SIZE / 2;
    this.tooltipArrow.style.left = Math.max(4, Math.min(arrowLeft, containerW - ARROW_SIZE - 4)) + "px";

    // Move the shadow HOST to the computed position.
    Object.assign(this.shadowHost.style, {
      top:  top  + "px",
      left: left + "px",
    });
  }

  attachLinkPreview(a: HTMLAnchorElement): void {
    if (this.wiredAnchors.has(a)) return;
    if (!this.isGoodUrl(a.href)) return;

    // Only skip pure icon-links (no text AND has img/svg child).
    const hasText = !!(a.innerText?.trim() || a.textContent?.trim());
    const isPureImageLink = !hasText && !!a.querySelector("img, svg");
    if (isPureImageLink) return;

    this.wiredAnchors.add(a);

    let showTimeout: any = null;
    let autoPreviewTimeout: any = null;

    a.addEventListener("mouseover", (e) => {
      // Cancel any pending hide.
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }

      showTimeout = setTimeout(async () => {
        const previewOnHover = (await Storage.get("preview-on-hover")) ?? false;

        // Show only the Preview button for link hovers.
        this.showLinkActions(a, [this.previewButton]);

        if (previewOnHover) {
          const delaySec = (await Storage.get("preview-on-hover-delay")) ?? 3;
          this.container.classList.add("hide-" + delaySec);
          autoPreviewTimeout = setTimeout(() => {
            this.container.className = "";
            this.hideAll();
            // Directly send the preview action — no floatie click needed.
            this.sendMessage("preview", a.href);
          }, delaySec * 1000);
        }
      }, 500);
    });

    a.addEventListener("mouseout", (e: MouseEvent) => {
      // Don't hide if mouse moved into the floatie itself.
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

  // Show floatie buttons for a link hover. Wires onclick handlers.
  showLinkActions(a: HTMLAnchorElement, buttons: HTMLElement[]): void {
    this.hideAll();
    if (!buttons.length) return;

    // Make buttons visible first so we can measure containerH for positioning.
    buttons.forEach((b) => {
      b.style.display = "inline-block";
      b.onclick = () => {
        this.sendMessage(b.getAttribute("data-action") || "unknown-action", a.href);
        this.hideAll();
      };
    });

    this.container.style.display = "block";

    // Use rAF so the browser has laid out the container and offsetHeight is correct.
    requestAnimationFrame(() => {
      this.showAtRect(a.getBoundingClientRect());
    });
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
    if (this.shadowHost && document.body.contains(this.shadowHost)) {
      document.body.removeChild(this.shadowHost);
    }
    document.onmouseup   = null;
    document.onkeydown   = null;
    window.onscroll      = null;
    window.onresize      = null;
    window.oncontextmenu = null;
  }

  // -----------------------------------------------------------------------
  // Text-selection floatie (search / copy / preview of selected URL).
  // This still uses computePosition because the reference is a Range rect
  // from the light DOM — not a shadow element — so floating-ui works fine.
  // -----------------------------------------------------------------------
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
    this.logger.debug("Selected: ", selectedText);

    const actionsToShow: HTMLElement[] = [];
    if (this.shouldShowPreview(e, selectedText))     actionsToShow.push(this.previewButton);
    else if (this.shouldShowSearch(e, selectedText)) actionsToShow.push(this.searchButton);
    if (this.shouldShowCopy(selectedText))           actionsToShow.push(this.copyButton);

    this.showActions(boundingRect, e, selectedText, actionsToShow);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  getAbsoluteUrl(urlStr: string): URL | null {
    try {
      if (/^(?:[a-z+]+:)?\//i.test(urlStr)) return new URL(urlStr);
    } catch {}
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
      try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; }
      catch { return false; }
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
    const isQuerySize  = (s: string) => s.length > 0 && s.length < 100;
    const isEmail      = (s: string) => /^[^@]+@[^@]+\.[^@]+$/.test(s.toLowerCase());
    const isDate       = (s: string) => !isNaN(Date.parse(s));
    const hasLetters   = (s: string) => /[a-zA-Z]/.test(s);
    return isQuerySize(selectedText) && hasLetters(selectedText) && !isEmail(selectedText)
      && !isDate(selectedText) && !this.shouldShowPreview(e, selectedText);
  }

  // Text-selection floatie using floating-ui (safe here: reference is a Range, not shadow element).
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
        this.sendMessage(b.getAttribute("data-action") || "unknown-action", sendText);
        this.hideAll();
      };
    });

    const virtualEl = { getBoundingClientRect: () => ({
      width: boundingRect.width, height: boundingRect.height,
      x: boundingRect.x, y: boundingRect.y,
      top: boundingRect.top, left: boundingRect.left,
      right: boundingRect.right, bottom: boundingRect.bottom,
    }) };

    // For the selection floatie we must position the container relative to
    // the shadow host. Move the host to 0,0 first so container coords align.
    if (this.shadowHost) {
      this.shadowHost.style.top  = "0px";
      this.shadowHost.style.left = "0px";
    }

    computePosition(virtualEl, this.container, {
      placement: "top",
      strategy: "fixed",
      middleware: [
        offset(12), flip(), shift({ padding: 5 }),
        arrow({ element: this.tooltipArrow }),
      ],
    }).then(({ x, y, placement, middlewareData }) => {
      if (this.shadowHost) {
        this.shadowHost.style.top  = y + "px";
        this.shadowHost.style.left = x + "px";
      }

      const coords = middlewareData.arrow;
      const staticSide = { top: "bottom", left: "right", bottom: "top", right: "left" }[placement.split("-")[0]] ?? "bottom";
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
    this.container.style.display   = "none";
    this.copyButton.style.display   = "none";
    this.searchButton.style.display = "none";
    this.previewButton.style.display= "none";
  }

  inIframe(): boolean {
    try { return window.self !== window.top; } catch { return true; }
  }
}
