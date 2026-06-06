import { arrow, computePosition, flip, offset, shift } from "@floating-ui/dom";
import floatieCssTxt from "./floatie.txt.css";
import { Logger } from "../../utils/logger";
import Storage from "../../utils/storage";
import manifest from "../../manifest.json";

/*
 * This component is responsible for rendering
 * the floatie and managing its lifecycle.
 * The floatie is rendered in a shadow dom to
 * avoid interference from parent document.
 * TODO: rename to Popover.ts.
 */
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
  // Track anchors we've already wired to avoid duplicate listeners on SPA re-renders.
  private wiredAnchors = new WeakSet<HTMLAnchorElement>();
  private domObserver: MutationObserver | null = null;

  constructor() {
    const markup = `
        <div id="sp-floatie-container">
            <div id="sp-floatie-arrow"></div>
            <div id="sp-floatie-search" class="sp-floatie-action" data-action="search">Search</div>
            <div id="sp-floatie-preview" class="sp-floatie-action" data-action="preview">Preview</div>
            <div id="sp-floatie-copy" class="sp-floatie-action" data-action="copy">Copy</div>
        </div>
        `;
    const tmp = document.createElement("div");
    tmp.innerHTML = markup;

    const container = tmp.querySelector<HTMLElement>("#sp-floatie-container");
    const searchButton = tmp.querySelector<HTMLElement>("#sp-floatie-search");
    const previewButton = tmp.querySelector<HTMLElement>("#sp-floatie-preview");
    const copyButton = tmp.querySelector<HTMLElement>("#sp-floatie-copy");
    const tooltipArrow = tmp.querySelector<HTMLElement>("#sp-floatie-arrow");

    if (
      !container ||
      !searchButton ||
      !previewButton ||
      !copyButton ||
      !tooltipArrow
    ) {
      throw new Error("Impossible error obtaining action buttons from DOM");
    }
    this.container = container;
    this.searchButton = searchButton;
    this.previewButton = previewButton;
    this.copyButton = copyButton;
    this.tooltipArrow = tooltipArrow;

    this.logger.debug("Initialized floatie");
  }

  startListening(): void {
    if (this.inIframe()) {
      return;
    }

    // Build shadow DOM correctly: attachShadow() first, then inject content
    // INTO the shadow root so CSS is fully isolated from the host page.
    const bft = document.createElement("better-previews-tooltip");
    // Shadow host needs a high z-index on the light DOM side so it stacks
    // above x.com's own fixed headers, modals, etc.
    bft.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;";
    document.body.appendChild(bft);
    const shadow = bft.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = floatieCssTxt;
    shadow.appendChild(style);
    shadow.appendChild(this.container);

    // Re-enable pointer events on the container itself (host is none so it
    // doesn't block clicks on the page underneath).
    this.container.style.pointerEvents = "auto";

    this.shadowHost = bft;
    this.shadowRoot = shadow;

    // Window level events.
    window.onscroll = () => this.hideAll();
    window.onresize = () => this.hideAll();

    // Do not display in contextMenu.
    window.oncontextmenu = () => this.hideAll();

    // TODO: Do not display in contentEditable.

    // Listen for mouse up events and suggest search if there's a selection.
    document.onmouseup = (e) => this.deferredMaybeShow(e);
    document.onkeydown = () => this.hideAll();

    this.setupLinkPreviews();
  }

  /*
   * Wire hover-preview listeners to a single anchor element.
   * Safe to call multiple times — WeakSet prevents duplicate listeners.
   */
  attachLinkPreview(a: HTMLAnchorElement): void {
    if (this.wiredAnchors.has(a)) {
      return;
    }

    if (!this.isGoodUrl(a.href)) {
      return;
    }

    // FIX: x.com wraps link text in deep React <span> trees. On the first
    // MutationObserver tick the element is in the DOM but layout hasn't run,
    // so a.innerText is '' even though text is visible. Use textContent as a
    // fallback (available immediately, no layout flush needed). If both are
    // empty we still wire the listener — isGoodUrl is the real quality gate.
    const hasText =
      (a.innerText && a.innerText.trim().length > 0) ||
      (a.textContent && a.textContent.trim().length > 0);

    // Only skip if the element is a pure icon/image link with no text at all
    // AND has an img/svg child — otherwise wire it.
    const isPureImageLink =
      !hasText && a.querySelector("img, svg") !== null;

    if (isPureImageLink) {
      return;
    }

    this.wiredAnchors.add(a);

    let showTimeout: any = null;
    let autoPreviewTimeout: any = null;
    let hideTimeout: any = null;

    a.addEventListener("mouseover", (e) => {
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }

      showTimeout = setTimeout(async () => {
        const previewOnHover =
          (await Storage.get("preview-on-hover")) ?? false;

        // getBoundingClientRect() returns viewport-relative coords — correct
        // for position:fixed. Previously used with position:absolute which
        // caused off-screen rendering on scrolled pages.
        this.showActions(a.getBoundingClientRect(), e, a.href, [
          this.previewButton,
        ]);

        if (previewOnHover) {
          const timeout = (await Storage.get("preview-on-hover-delay")) ?? 3;
          this.container.classList.add("hide-" + timeout);
          autoPreviewTimeout = setTimeout(() => {
            this.container.className = "";
            this.container.style.display = "none";
            this.sendMessage("preview", a.href);
          }, timeout * 1000);
        }
      }, 500);
    });

    a.addEventListener("mouseout", (e: MouseEvent) => {
      // Don't hide if the mouse moved INTO the floatie container itself.
      const relatedTarget = e.relatedTarget as Node | null;
      if (relatedTarget && this.container.contains(relatedTarget)) {
        return;
      }

      if (showTimeout) {
        clearTimeout(showTimeout);
        showTimeout = null;
      }
      if (autoPreviewTimeout) {
        clearTimeout(autoPreviewTimeout);
        this.container.className = "";
        this.container.style.display = "none";
        autoPreviewTimeout = null;
      }
      hideTimeout = setTimeout(() => {
        this.hideAll();
      }, 300);
    });

    // Also hide when mouse leaves the floatie back to non-link area.
    this.container.addEventListener("mouseleave", () => {
      hideTimeout = setTimeout(() => {
        this.hideAll();
      }, 300);
    });

    this.container.addEventListener("mouseenter", () => {
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
    });
  }

  /*
   * Wire all existing anchors and set up a MutationObserver to catch
   * dynamically injected links from SPAs like x.com, YouTube, etc.
   */
  setupLinkPreviews(): void {
    document.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
      this.attachLinkPreview(a);
    });

    // Watch for new <a> tags added by SPA navigation / infinite scroll.
    this.domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as Element;

          if (el.tagName === "A") {
            this.attachLinkPreview(el as HTMLAnchorElement);
          }

          el.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
            this.attachLinkPreview(a);
          });
        });
      }
    });

    this.domObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  stopListening(): void {
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }

    if (this.shadowHost && document.body.contains(this.shadowHost)) {
      document.body.removeChild(this.shadowHost);
    }

    document.onmouseup = null;
    document.onkeydown = null;
    window.onscroll = null;
    window.onresize = null;
    window.oncontextmenu = null;
  }

  deferredMaybeShow(e: MouseEvent): void {
    this.showTimeout = window.setTimeout(() => this.maybeShow(e), 100);
  }

  maybeShow(e: MouseEvent): void {
    this.hideAll();

    if (typeof window.getSelection == "undefined") {
      return;
    }
    const selection = window.getSelection()!;
    if (selection.isCollapsed) {
      return;
    }

    const selectedText = selection.toString().trim();
    const range = selection.getRangeAt(0);
    const boundingRect = range.getBoundingClientRect();
    this.logger.debug("Selected: ", selectedText);
    const actionsToShow: HTMLElement[] = [];
    if (this.shouldShowPreview(e, selectedText)) {
      actionsToShow.push(this.previewButton);
    } else if (this.shouldShowSearch(e, selectedText)) {
      actionsToShow.push(this.searchButton);
    }
    if (this.shouldShowCopy(selectedText)) {
      actionsToShow.push(this.copyButton);
    }
    this.showActions(boundingRect, e, selectedText, actionsToShow);
  }

  getAbsoluteUrl(urlStr: string): URL | null {
    const absoluteUrlMatcher = new RegExp("^(?:[a-z+]+:)?//", "i");
    let url: URL;
    try {
      if (absoluteUrlMatcher.test(urlStr)) {
        url = new URL(urlStr);
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
    return url;
  }

  isGoodUrl(urlStr: string): boolean {
    if (!urlStr || !urlStr.trim()) {
      return false;
    }

    const url = this.getAbsoluteUrl(urlStr);
    if (url === null) {
      return false;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    if (url.hostname === window.location.hostname) {
      // Same-origin links are skipped by default.
      return false;
    }

    return true;
  }

  shouldShowCopy(selectedText: string): boolean {
    return this.isCopyActionEnabled && selectedText.length > 0;
  }

  shouldShowPreview(
    e: MouseEvent | KeyboardEvent,
    selectedText: string,
  ): boolean {
    const looksLikeUrl = (s: string) => {
      try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    };

    const isGoodHyperlink = (e: MouseEvent | KeyboardEvent) => {
      var target: any = e.target;
      do {
        if (target.nodeName.toUpperCase() === "A" && target.href) {
          return true;
        }
      } while ((target = target.parentElement));
      return false;
    };

    return looksLikeUrl(selectedText) || isGoodHyperlink(e);
  }

  getPreviewUrl(
    e: MouseEvent | KeyboardEvent,
    selectedText: string,
  ): string | undefined {
    const isWrappedByLink = (e: MouseEvent | KeyboardEvent) => {
      var target: any = e.target;
      do {
        if (target.nodeName.toUpperCase() === "A" && target.href) {
          return target.href as string;
        }
      } while ((target = target.parentElement));
      return undefined;
    };

    try {
      const u = new URL(selectedText);
      if (u.protocol === "http:" || u.protocol === "https:") {
        return u.href;
      }
    } catch {}

    return isWrappedByLink(e);
  }

  shouldShowSearch(e: MouseEvent, selectedText: string): boolean {
    const isQuerySize = (text: string) => {
      return text.length > 0 && text.length < 100;
    };

    const isEmail = (email: string) => {
      return String(email)
        .toLowerCase()
        .match(
          /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
        );
    };

    const isDate = (dataStr: string) => {
      return !isNaN(Date.parse(dataStr));
    };

    const isNotSymbols = function (str: string) {
      let notSymbols: boolean = false;
      for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (
          (code >= 0 && code <= 47) ||
          (code >= 58 && code <= 64) ||
          (code >= 91 && code <= 96) ||
          (code >= 123 && code <= 255)
        ) {
          continue;
        } else {
          notSymbols = true;
          break;
        }
      }
      return notSymbols;
    };

    return (
      isQuerySize(selectedText) &&
      isNotSymbols(selectedText) &&
      !isEmail(selectedText) &&
      !isDate(selectedText) &&
      !this.shouldShowPreview(e, selectedText)
    );
  }

  showActions(
    boundingRect: DOMRect,
    e: MouseEvent,
    text: string,
    buttons: HTMLElement[],
  ) {
    this.hideAll();
    if (buttons.length === 0) {
      return;
    }

    this.showContainer(boundingRect);
    buttons.forEach((b) => {
      b.style.display = "inline-block";
      b.onclick = () => {
        if (typeof window.getSelection != "undefined") {
          const selection = window.getSelection()!;
          if (!selection.isCollapsed) {
            text = selection.toString().trim();
          }

          if (b.innerText == "Preview") {
            const href = this.getPreviewUrl(e, text);
            if (href) {
              text = href;
            }
          }
        }

        this.sendMessage(
          b.getAttribute("data-action") || "unknown-action",
          text,
        );
        this.hideAll();
      };
    });
  }

  sendMessage(action: string, data: any) {
    window.postMessage(
      { application: manifest.__package_name__, action: action, data: data },
      window.location.origin,
    );
  }

  // It should be a no-op to call this multiple times.
  showContainer(boundingRect: DOMRect): void {
    this.container.style.display = "block";

    // FIX: Use strategy:'fixed' so x/y from computePosition are
    // viewport-relative, matching position:fixed on the container.
    // Previously 'absolute' with no positioned ancestor in the shadow DOM
    // caused the floatie to render at wrong coordinates (often off-screen).
    const virtualEl = {
      getBoundingClientRect() {
        return {
          width: boundingRect.width,
          height: boundingRect.height,
          x: boundingRect.x,
          y: boundingRect.y,
          top: boundingRect.top,
          left: boundingRect.left,
          right: boundingRect.right,
          bottom: boundingRect.bottom,
        };
      },
    };

    computePosition(virtualEl, this.container, {
      placement: "top",
      strategy: "fixed",
      middleware: [
        offset(12),
        flip(),
        shift({ padding: 5 }),
        arrow({ element: this.tooltipArrow }),
      ],
    }).then(({ x, y, placement, middlewareData }) => {
      Object.assign(this.container.style, {
        top: `${y}px`,
        left: `${x}px`,
      });

      const coords = middlewareData.arrow;
      let staticSide = "bottom";
      switch (placement.split("-")[0]) {
        case "top":    staticSide = "bottom"; break;
        case "left":   staticSide = "right";  break;
        case "bottom": staticSide = "top";    break;
        case "right":  staticSide = "left";   break;
      }
      Object.assign(this.tooltipArrow.style, {
        left:   coords?.x != null ? `${coords.x}px` : "",
        top:    coords?.y != null ? `${coords.y}px` : "",
        right:  "",
        bottom: "",
        [staticSide]: "-4px",
      });

      // FIX: getMaxZIndex() queries 'body *' which can't pierce shadow DOM.
      // On x.com many elements have z-index > 9000. Instead of computing a
      // dynamic max, just use the maximum possible CSS z-index value.
      // The shadow host already has z-index:2147483647 on the light-DOM side.
      this.container.style.zIndex = "2147483647";
      this.tooltipArrow.style.zIndex = "2147483646";
    });
  }

  hideAll(): void {
    clearTimeout(this.showTimeout);
    this.container.style.display = "none";
    this.copyButton.style.display = "none";
    this.searchButton.style.display = "none";
    this.previewButton.style.display = "none";
  }

  inIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  }
}
